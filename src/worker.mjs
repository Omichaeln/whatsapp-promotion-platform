/**
 * Durable worker (spec §18): drains inbound channel events -> conversation,
 * background jobs (receipt extraction, expiries, media purge), the WhatsApp
 * outbox and the CRM outbox. Bounded per tick; leases make a crash safe.
 * Recipient policy and template eligibility are enforced at dispatch time.
 */
const SERVICE_WINDOW_MS = 24 * 3600_000;
// Answers to a message the participant has just sent: inside the 24h service
// window by construction, and the one thing someone who has withdrawn must
// still receive (the answer to their own support request).
const CONVERSATIONAL = new Set(["reply", "support"]);

export function createWorker({ db, transport, outbox, crm, intake, domain, cfg, intervalMs = 1500, housekeepingMs = 60_000, stallAfterMs = null, log = console }) {
  let timer = null, running = false, lastTick = null, ticks = 0, tickStartedAt = null;
  // Wall clock, not tick count: ticks only advance when a tick actually runs, so
  // under load (10 OCR passes per tick) the old `ticks % 40` stretched the 60s
  // housekeeping interval to tens of minutes — the backlog alerts and the winner
  // expiry driver degraded in proportion to the backlog they exist to report.
  let lastHousekeepingAt = Date.now();
  // A tick is a BATCH, not a single operation: up to 25 inbound events (each of
  // which may run OCR), 10 jobs, 25 provider sends and 10 CRM deliveries, plus
  // a bounded reconcile once a minute. At the default 1.5s interval the old
  // 60s threshold was below the duration of a legitimately busy tick, so the
  // critical "the whole queue is stopped" alert fired on healthy load and
  // trained operators to ignore the one alarm that means the queue is wedged.
  // Five minutes is longer than any bounded tick can take and still far short
  // of a wedge that matters.
  const stallMs = stallAfterMs ?? Math.max(20 * intervalMs, 5 * 60_000);

  function lastInboundAt(phoneUid) {
    const last = db.prepare(`select received_at from channel_events where wa_phone_uid=? and event_kind like 'message.%' order by received_at desc limit 1`).get(phoneUid);
    const t = last ? Date.parse(last.received_at) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  function recipientPolicy(row) {
    const env = domain.environment();
    if (env !== "production") {
      const allow = domain.getSetting("outbound.allowed_recipients", []);
      // Deny by default on a live provider. An unset allowlist used to mean
      // "message everybody": a staging service given real Meta credentials (the
      // documented way to test a round-trip) replied to every member of the
      // public who wrote to the live number, because the allowlist PUT is a
      // manual console step nothing verifies.
      // But HOLD, do not burn: an unset allowlist is a configuration gap, not a
      // bad message. permanent_failure here destroys the whole queued backlog,
      // and setting the allowlist afterwards does not release it — an operator
      // would have to press Retry on every row one at a time (outbox.retry takes
      // a single id). Retryable means the queue waits and drains itself the
      // moment the setting lands; outbound.blocked makes an indefinite wait
      // visible. The explicit "not a designated test recipient" block below
      // stays terminal: there the allowlist exists and says no.
      if (transport?.isLiveProvider && !allow.length) return { blocked: true, code: "RECIPIENT_NOT_ALLOWED", message: "non-production deployment on a live provider: set outbound.allowed_recipients before anything may be sent", retryable: true };
      if (allow.length && !allow.includes(row.wa_phone_uid)) return { blocked: true, code: "RECIPIENT_NOT_ALLOWED", message: `non-production: ${domain.maskPhone(row.wa_phone_uid)} is not a designated test recipient`, retryable: false };
    }
    if (row.campaign_id) {
      const pause = domain.getPauseFlags(row.campaign_id);
      if (pause.outbound) return { blocked: true, code: "OUTBOUND_PAUSED", message: "campaign outbound paused", retryable: true };
    }
    // Consent is re-checked at DISPATCH, not only at enqueue: a message queued
    // before the participant withdrew — or produced afterwards by a reviewer's
    // decision on an earlier submission — would otherwise still be delivered to
    // someone who has opted out.
    if (!CONVERSATIONAL.has(row.purpose)) {
      const p = db.prepare(`select status from participants where wa_phone_uid=?`).get(row.wa_phone_uid);
      if (p && p.status !== "active") return { blocked: true, code: "CONSENT_WITHDRAWN", message: `participant is ${p.status}: campaign messages must not be sent`, retryable: false };
    }
    // The 24h service window applies to every free-form text, not just winner
    // contact: a receipt outcome decided at the 24h review SLA, or a support
    // reply typed the next day, is refused by WhatsApp (error 131047) exactly
    // like a winner notification, and the consumer is simply never told.
    if (row.kind === "text" && row.purpose !== "reply" && transport.requiresTemplateOutsideWindow) {
      const last = lastInboundAt(row.wa_phone_uid);
      if (!last || Date.now() - last > SERVICE_WINDOW_MS) {
        // Hold rather than send: while held, a new inbound message reopens the
        // window and the queued message goes out. But the hold must end — a
        // policy block that stays retryable for ever would hold a winner notice
        // until the claim deadline passed — so past one window it becomes
        // terminal, where the outbound.blocked alert counts it.
        const created = Date.parse(row.created_at);
        const retryable = Number.isFinite(created) ? Date.now() - created < SERVICE_WINDOW_MS : true;
        return { blocked: true, code: "TEMPLATE_REQUIRED", message: `outside the 24h customer-service window: an approved template message is required for purpose '${row.purpose}'`, retryable };
      }
    }
    return null;
  }

  async function tick() {
    if (running) {
      // The interval keeps firing while a tick is wedged on a never-settling
      // await, and `finally { running = false }` never runs. This is the only
      // code path left outside the wedge, so it is where the stall is reported:
      // health() alone is not read by anything that can act on it.
      if (tickStartedAt && Date.now() - tickStartedAt > stallMs) {
        try { domain.alert({ kind: "worker.stalled", severity: "critical", message: `worker tick has not completed for ${Math.round((Date.now() - tickStartedAt) / 1000)}s: the whole queue (inbound, jobs, outbound, CRM) is stopped`, runbook: "docs/runbooks/queue-replay.md" }); } catch { /* alerting itself is down */ }
      }
      return;
    }
    running = true; ticks++; tickStartedAt = Date.now();
    try {
      for (let i = 0; i < 25; i++) { const r = await intake.processNext(); if (!r) break; }
      for (let i = 0; i < 10; i++) { const r = await intake.processNextJob(); if (!r) break; }
      for (let i = 0; i < 25; i++) {
        const r = await outbox.processPendingWhatsApp(async (row, payload) => {
          // payload_json is the message only; the recipient comes from its own
          // column. Rows enqueued by an older build still carry routing fields
          // inside the envelope — they must never reach the provider payload.
          const { waPhoneUid: _p, kind: _k, idempotencyKey: _i, ...content } = payload;
          const res = await transport.send({ waPhoneUid: row.wa_phone_uid, kind: row.kind, payload: row.kind === "text" ? payload.body : content, idempotencyKey: row.idempotency_key, templateName: row.template_name });
          return { providerMessageId: typeof res === "string" ? res : res?.providerMessageId || res?.id || null };
        }, { policy: recipientPolicy });
        if (!r) break;
      }
      for (let i = 0; i < 10; i++) { const r = await crm.deliverOne(); if (!r || r.skipped) break; }
      // housekeeping: expiries + alerts on backlog
      if (Date.now() - lastHousekeepingAt >= housekeepingMs) {
        lastHousekeepingAt = Date.now();
        await reconcileCrm();
        housekeeping();
      }
      lastTick = new Date().toISOString();
    } catch (e) { log.error?.("[worker]", e.message); }
    finally { running = false; tickStartedAt = null; }
  }
  /**
   * unknown_outcome CRM events are not selectable by deliverOne(), so until now
   * the ONLY thing that ever resolved them was a human clicking Reconcile in the
   * console — a transient CRM blip during an award burst left those entries
   * permanently absent from the CRM. Awaited and hard-bounded: reconcile does one
   * network read per row and runs inside the tick's single-flight guard, so its
   * budget is part of the tick's worst case. Three rows a minute clears a
   * backlog steadily without letting a slow CRM dominate the tick; the console's
   * manual Reconcile is still there for a burst.
   */
  async function reconcileCrm({ limit = 3 } = {}) {
    try {
      if (!crm?.reconcile || crm.reconcileView?.().provider === "none") return null;
      return await crm.reconcile({ limit });
    } catch (e) { log.error?.("[worker] crm reconcile", e.message); return null; }
  }
  function housekeeping() {
    try {
      // Rows abandoned mid-processing at the attempts cap are invisible to the
      // queue selectors: terminate them so they dead-letter, alert and can be
      // replayed instead of disappearing.
      intake.sweepStranded?.();
      const st = intake.stats();
      if (st.oldestEvent && Date.now() - Date.parse(st.oldestEvent) > 5 * 60_000) domain.alert({ kind: "inbound.backlog", severity: "warning", message: `inbound backlog: oldest event ${st.oldestEvent}`, runbook: "docs/runbooks/queue-replay.md" });
      const rv = db.prepare(`select count(*) n, min(created_at) oldest from review_tasks where state!='decided'`).get();
      if (rv.n && Date.now() - Date.parse(rv.oldest) > 24 * 3600_000) domain.alert({ kind: "review.backlog", severity: "warning", message: `${rv.n} receipts awaiting review; oldest ${rv.oldest}`, runbook: "docs/runbooks/review-operations.md" });
      const ob = outbox.stats();
      // Two different incidents, two different alerts. `outbound.failures` is
      // the PROVIDER one (provider-outage.md: check Meta status, rotate the
      // token, retry the rows). Counting our own policy blocks here meant that
      // every support-processed withdrawal, and every deliberate campaign pause
      // lasting more than half an hour, raised a provider-outage warning —
      // exactly the noise that trains operators to ignore a real outage.
      if (ob.providerFailures > 0) domain.alert({ kind: "outbound.failures", severity: "warning", message: `outbound failures: ${ob.providerFailures} (${JSON.stringify(ob.byStatus)})`, runbook: "docs/runbooks/provider-outage.md" });
      // ...and this is the "nobody can send this message" one: a hold nobody can
      // clear (no approved template for a closed 24h window, or a deployment
      // with no allowlist) sitting there for half an hour, or one already gone
      // terminal — a winner marked 'notified' with nothing delivered. Counted by
      // nothing before; a pause or a withdrawal is deliberately not counted here.
      const held = ob.oldestHeld && Date.now() - Date.parse(ob.oldestHeld) > 30 * 60_000 ? ob.oldestHeld : null;
      if (held || ob.undeliverable > 0) domain.alert({ kind: "outbound.blocked", severity: "warning", message: `outbound blocked by policy${ob.undeliverable ? `: ${ob.undeliverable} message(s) past the 24h service window with nothing sent` : ""}${held ? `; oldest unresolved hold queued ${held}` : ""}`, runbook: "docs/runbooks/winners-claims.md" });
      const cs = crm?.reconcileView?.();
      // CRM backlog had no alert at all, including the read-back-failure path
      // that marks a SUCCESSFUL upsert unknown_outcome without telling anyone.
      if (cs && cs.provider !== "none" && (cs.unknown_outcome || 0) + (cs.permanent_failure || 0) > 0) domain.alert({ kind: "crm.backlog", severity: "warning", message: `CRM backlog: ${cs.unknown_outcome || 0} unknown_outcome, ${cs.permanent_failure || 0} permanent_failure`, runbook: "docs/runbooks/crm-reconciliation.md" });
      db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) select 'job_exp_' || strftime('%Y%m%d%H', 'now'), 'winner.expire', '{}', 'pending', ?, ? where not exists (select 1 from jobs where id='job_exp_' || strftime('%Y%m%d%H', 'now'))`).run(new Date().toISOString(), new Date().toISOString());
      // Retention. media.purge and the facts sweep were implemented but nothing
      // ever enqueued them, so receipt images and extracted OCR text were kept
      // for ever despite the documented 90/180-day commitments. Daily ids keep
      // this idempotent across the many housekeeping passes in a day.
      db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) select 'job_purge_' || strftime('%Y%m%d', 'now'), 'media.purge', '{}', 'pending', ?, ? where not exists (select 1 from jobs where id = 'job_purge_' || strftime('%Y%m%d', 'now'))`).run(new Date().toISOString(), new Date().toISOString());
      db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) select 'job_facts_' || strftime('%Y%m%d', 'now'), 'retention.scrub', '{}', 'pending', ?, ? where not exists (select 1 from jobs where id = 'job_facts_' || strftime('%Y%m%d', 'now'))`).run(new Date().toISOString(), new Date().toISOString());
    } catch (e) {
      // Housekeeping schedules retention and expiry. A silent catch here hid a
      // ReferenceError that stopped the retention jobs being enqueued at all,
      // and nothing surfaced it: log AND alert so a broken pass is visible.
      log.error?.("[worker] housekeeping", e.message);
      try { domain.alert({ kind: "worker.housekeeping_failed", severity: "critical", message: `housekeeping pass failed: ${e.message}`, runbook: "docs/runbooks/queue-replay.md" }); } catch { /* alerting itself is down */ }
    }
  }
  return {
    start() { if (!timer) timer = setInterval(tick, intervalMs); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick, housekeeping,
    // `running: !!timer` only says the interval object exists, which stays true
    // while a wedged tick blocks every queue: report the stall itself so a
    // readiness probe has something to fail on.
    health: () => ({ running: !!timer, lastTick, ticks, stalled: !!(tickStartedAt && Date.now() - tickStartedAt > stallMs), tickStartedAt: tickStartedAt ? new Date(tickStartedAt).toISOString() : null }),
  };
}
