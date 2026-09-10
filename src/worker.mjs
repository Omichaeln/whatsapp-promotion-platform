/**
 * Durable worker (spec §18): drains inbound channel events -> conversation,
 * background jobs (receipt extraction, expiries, media purge), the WhatsApp
 * outbox and the CRM outbox. Bounded per tick; leases make a crash safe.
 * Recipient policy and template eligibility are enforced at dispatch time.
 */
export function createWorker({ db, transport, outbox, crm, intake, domain, cfg, intervalMs = 1500, log = console }) {
  let timer = null, running = false, lastTick = null, ticks = 0;

  function recipientPolicy(row) {
    const env = domain.environment();
    const allow = domain.getSetting("outbound.allowed_recipients", []);
    if (env !== "production" && allow.length && !allow.includes(row.wa_phone_uid)) return { blocked: true, code: "RECIPIENT_NOT_ALLOWED", message: `non-production: ${domain.maskPhone(row.wa_phone_uid)} is not a designated test recipient`, retryable: false };
    if (row.campaign_id) {
      const pause = domain.getPauseFlags(row.campaign_id);
      if (pause.outbound) return { blocked: true, code: "OUTBOUND_PAUSED", message: "campaign outbound paused", retryable: true };
    }
    if (row.purpose === "winner_contact" && row.kind === "text" && transport.requiresTemplateOutsideWindow) {
      const last = db.prepare(`select received_at from channel_events where wa_phone_uid=? and event_kind like 'message.%' order by received_at desc limit 1`).get(row.wa_phone_uid);
      if (!last || Date.now() - Date.parse(last.received_at) > 24 * 3600_000) return { blocked: true, code: "TEMPLATE_REQUIRED", message: "outside the 24h customer-service window: an approved template message is required (configure winner_template_name)", retryable: true };
    }
    return null;
  }

  async function tick() {
    if (running) return; running = true; ticks++;
    try {
      for (let i = 0; i < 25; i++) { const r = await intake.processNext(); if (!r) break; }
      for (let i = 0; i < 10; i++) { const r = await intake.processNextJob(); if (!r) break; }
      for (let i = 0; i < 25; i++) {
        const r = await outbox.processPendingWhatsApp(async (row, payload) => {
          const res = await transport.send({ waPhoneUid: payload.waPhoneUid, kind: row.kind, payload: row.kind === "text" ? payload.body : payload, idempotencyKey: row.idempotency_key, templateName: row.template_name });
          return { providerMessageId: typeof res === "string" ? res : res?.providerMessageId || res?.id || null };
        }, { policy: recipientPolicy });
        if (!r) break;
      }
      for (let i = 0; i < 10; i++) { const r = await crm.deliverOne(); if (!r || r.skipped) break; }
      // housekeeping: expiries + alerts on backlog
      if (ticks % 40 === 0) housekeeping();
      lastTick = new Date().toISOString();
    } catch (e) { log.error?.("[worker]", e.message); }
    finally { running = false; }
  }
  function housekeeping() {
    try {
      const st = intake.stats();
      if (st.oldestEvent && Date.now() - Date.parse(st.oldestEvent) > 5 * 60_000) domain.alert({ kind: "inbound.backlog", severity: "warning", message: `inbound backlog: oldest event ${st.oldestEvent}`, runbook: "docs/runbooks/queue-replay.md" });
      const rv = db.prepare(`select count(*) n, min(created_at) oldest from review_tasks where state!='decided'`).get();
      if (rv.n && Date.now() - Date.parse(rv.oldest) > 24 * 3600_000) domain.alert({ kind: "review.backlog", severity: "warning", message: `${rv.n} receipts awaiting review; oldest ${rv.oldest}`, runbook: "docs/runbooks/review-operations.md" });
      const ob = outbox.stats();
      if ((ob.byStatus.unknown_outcome || 0) + (ob.byStatus.permanent_failure || 0) > 0) domain.alert({ kind: "outbound.failures", severity: "warning", message: `outbound failures: ${JSON.stringify(ob.byStatus)}`, runbook: "docs/runbooks/provider-outage.md" });
      db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) select 'job_exp_' || strftime('%Y%m%d%H', 'now'), 'winner.expire', '{}', 'pending', ?, ? where not exists (select 1 from jobs where id='job_exp_' || strftime('%Y%m%d%H', 'now'))`).run(new Date().toISOString(), new Date().toISOString());
    } catch (e) { log.error?.("[worker] housekeeping", e.message); }
  }
  return {
    start() { if (!timer) timer = setInterval(tick, intervalMs); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick, housekeeping,
    health: () => ({ running: !!timer, lastTick, ticks }),
  };
}
