import { id, nowIso, normalizePhone } from "./db.mjs";

/**
 * Durable channel-event intake and job queue (spec §8, §18).
 *  receive():  persist the provider event (UNIQUE provider+account+message+kind)
 *              BEFORE acknowledging; a replay returns { duplicate: true }.
 *  processNext(): lease the oldest received event, run the conversation, enqueue
 *              replies to the outbox, mark processed. Failures retry with a
 *              bounded attempt count, then dead-letter with an alert. A worker
 *              crash simply lets the lease expire: no message is lost.
 *  Jobs table: receipt.process (extraction) and other background work, with
 *              leases and bounded attempts.
 */
export function createIntake({ db, conversation, outbox, pipeline, domain, transport = null, log = console, now = nowIso }) {
  const insert = db.prepare(`insert or ignore into channel_events (id, provider, provider_account, provider_message_id, event_kind, wa_phone_uid, payload_json, media_ref, status, received_at, correlation_id)
    values (?,?,?,?,?,?,?,?,?,?,?)`);
  // 'processing' rows whose lease expired belong to a crashed worker: re-take them
  const nextEvent = db.prepare(`select * from channel_events where ((status in ('received','failed') and (lease_until is null or lease_until < ?)) or (status='processing' and lease_until < ?)) and attempts < 5 order by received_at limit 1`);
  const nextJob = db.prepare(`select * from jobs where (run_after is null or run_after <= ?) and ((status in ('pending','failed') and (lease_until is null or lease_until < ?)) or (status='processing' and lease_until < ?)) and attempts < 6 order by run_after, created_at limit 1`);

  function receive(ev) {
    const provider = ev.provider || "simulator";
    const kind = ev.type === "delivery.status" ? `delivery.status:${ev.status || "unknown"}` : (ev.type || "message.unsupported");
    const phone = normalizePhone(ev.phoneUid) || null;
    const cid = ev.correlationId || `corr_${id("").slice(1)}`;
    const eid = id("cev");
    const r = insert.run(eid, provider, ev.providerAccount || "default", String(ev.providerMessageId), kind, phone, JSON.stringify({ text: ev.text || "", mediaId: ev.mediaId || null, status: ev.status || null, raw: ev.raw ? redact(ev.raw) : null, timestamp: ev.timestamp || null, inlineMediaB64: ev.inlineMediaB64 || null, mime: ev.mime || null }), ev.mediaId || null, "received", now(), cid);
    if (!r.changes) return { accepted: false, duplicate: true };
    domain.metric("inbound.received", 1, { kind });
    return { accepted: true, id: eid, correlationId: cid };
  }

  async function processNext({ leaseSeconds = 90 } = {}) {
    const ev = nextEvent.get(now(), now());
    if (!ev) return null;
    const leased = db.prepare(`update channel_events set status='processing', lease_until=?, attempts=attempts+1 where id=? and (status in ('received','failed') or (status='processing' and lease_until < ?))`).run(new Date(Date.now() + leaseSeconds * 1000).toISOString(), ev.id, now());
    if (!leased.changes) return { id: ev.id, skipped: true };
    const payload = JSON.parse(ev.payload_json);
    const t0 = Date.now();
    try {
      let result;
      if (ev.event_kind.startsWith("delivery.status:")) {
        outbox.markDelivery(ev.provider_message_id, ev.event_kind.split(":")[1], { errorCode: payload.raw?.errors?.[0]?.code || null, at: payload.timestamp });
        result = { delivery: true };
      } else {
        let mediaBytes = null;
        if (ev.event_kind === "message.image" || ev.event_kind === "message.document") {
          if (payload.inlineMediaB64) mediaBytes = Buffer.from(payload.inlineMediaB64, "base64");
          else if (payload.mediaId && transport?.downloadMedia) {
            try { mediaBytes = await transport.downloadMedia(payload.mediaId); }
            catch (e) { if (e.permanent) mediaBytes = null; else throw Object.assign(new Error(`media download failed: ${e.message}`), { transient: true }); }
          }
        }
        result = await conversation.handle({ eventId: ev.id, providerMessageId: ev.provider_message_id, phoneUid: ev.wa_phone_uid, type: ev.event_kind, text: payload.text || "", mediaBytes, mime: payload.mime, correlationId: ev.correlation_id, eventAt: payload.timestamp });
        for (const [i, reply] of (result?.replies || []).entries()) {
          outbox.enqueueWhatsApp({ waPhoneUid: ev.wa_phone_uid, kind: "text", purpose: "reply", campaignId: result.campaignId || null, correlationId: ev.correlation_id, payload: reply, idempotencyKey: `conv:${ev.id}:${i}` });
        }
      }
      // Retention at the source: the event has been handled, so the second full
      // copy of the image (inlineMediaB64) is redundant — the bytes live in the
      // media store under its own retention — and a message body the
      // conversation flagged as personal data (the national ID) must not be
      // kept in cleartext. Scrubbing here bounds channel_events instead of
      // relying on a sweep that may never run.
      const scrubbed = { ...payload };
      let scrub = false;
      if (scrubbed.inlineMediaB64) { scrubbed.inlineMediaB64 = null; scrubbed.inlineMediaRedacted = true; scrub = true; }
      if (result?.redactInbound && scrubbed.text) { scrubbed.text = "[redacted: personal identifier]"; scrubbed.textRedacted = true; scrub = true; }
      if (scrub) db.prepare(`update channel_events set payload_json=? where id=?`).run(JSON.stringify(scrubbed), ev.id);
      db.prepare(`update channel_events set status='processed', processed_at=?, lease_until=null, result_json=?, error=null where id=?`).run(now(), JSON.stringify({ state: result?.state || null, replies: (result?.replies || []).length, receiptId: result?.receiptId || null }), ev.id);
      domain.metric("inbound.processed_ms", Date.now() - t0, { kind: ev.event_kind });
      return { id: ev.id, ok: true, result };
    } catch (e) {
      const attempts = ev.attempts + 1;
      const dead = attempts >= 5;
      db.prepare(`update channel_events set status=?, lease_until=?, error=? where id=?`).run(dead ? "dead" : "failed", dead ? null : new Date(Date.now() + Math.min(2 ** attempts, 60) * 1000).toISOString(), String(e.message).slice(0, 300), ev.id);
      log.error?.("[intake] event failed", ev.id, e.message);
      if (dead) domain.alert({ kind: "inbound.dead_letter", severity: "critical", message: `inbound event ${ev.id} dead-lettered: ${e.message}`, runbook: "docs/runbooks/queue-replay.md" });
      return { id: ev.id, error: e.message, dead };
    }
  }

  async function processNextJob({ leaseSeconds = 120 } = {}) {
    const job = nextJob.get(now(), now(), now());
    if (!job) return null;
    const leased = db.prepare(`update jobs set status='processing', lease_until=?, attempts=attempts+1 where id=? and (status in ('pending','failed') or (status='processing' and lease_until < ?))`).run(new Date(Date.now() + leaseSeconds * 1000).toISOString(), job.id, now());
    if (!leased.changes) return { id: job.id, skipped: true };
    const payload = JSON.parse(job.payload_json || "{}");
    try {
      let result = null;
      if (job.kind === "receipt.process") {
        result = await pipeline.process(payload.receiptId, { correlationId: job.correlation_id });
        await conversation.onReceiptOutcome?.(payload.receiptId, result);
      } else if (job.kind === "winner.expire") result = await conversation.services?.winners?.expireDue?.();
      else if (job.kind === "media.purge") {
        // purgeExpired caps each call, so a backlog needs several passes.
        const store = conversation.services?.mediaStore; let purged = 0, pass = 0;
        while (store?.purgeExpired && pass < 50) { const n = Number(store.purgeExpired(200) || 0); purged += n; pass += 1; if (n < 200) break; }
        result = { purged };
      } else if (job.kind === "retention.scrub") result = domain.retentionScrub();
      else throw Object.assign(new Error(`unknown job kind ${job.kind}`), { permanent: true });
      db.prepare(`update jobs set status='done', finished_at=?, lease_until=null where id=?`).run(now(), job.id);
      return { id: job.id, ok: true, result };
    } catch (e) {
      const attempts = job.attempts + 1;
      const dead = attempts >= 6 || e.permanent;
      db.prepare(`update jobs set status=?, lease_until=null, last_error=?, run_after=? where id=?`).run(dead ? "dead" : "failed", String(e.message).slice(0, 300), dead ? null : new Date(Date.now() + Math.min(2 ** attempts, 120) * 1000).toISOString(), job.id);
      log.error?.("[jobs] failed", job.id, job.kind, e.message);
      if (dead) domain.alert({ kind: "jobs.dead_letter", severity: "critical", message: `job ${job.id} (${job.kind}) dead: ${e.message}`, runbook: "docs/runbooks/queue-replay.md" });
      return { id: job.id, error: e.message, dead };
    }
  }

  /** Drain everything (tests and the simulator use this). */
  async function drain({ max = 500 } = {}) {
    let n = 0;
    for (let i = 0; i < max; i++) { const r = await processNext(); if (!r) break; n++; }
    for (let i = 0; i < max; i++) { const r = await processNextJob(); if (!r) break; n++; }
    return n;
  }
  function replay(eventId, actorId) {
    const r = db.prepare(`update channel_events set status='received', attempts=0, lease_until=null, error=null where id=? and status in ('dead','failed')`).run(eventId);
    if (r.changes) domain.audit({ actorType: "admin", actorId, action: "inbound.replay", targetType: "channel_event", targetId: eventId });
    return r.changes > 0;
  }
  function retryJob(jobId, actorId) {
    const r = db.prepare(`update jobs set status='pending', attempts=0, lease_until=null, run_after=null where id=? and status in ('dead','failed')`).run(jobId);
    if (r.changes) domain.audit({ actorType: "admin", actorId, action: "job.retry", targetType: "job", targetId: jobId });
    return r.changes > 0;
  }
  function stats() {
    const ev = Object.fromEntries(db.prepare(`select status, count(*) n from channel_events group by status`).all().map((r) => [r.status, r.n]));
    const jobs = Object.fromEntries(db.prepare(`select status, count(*) n from jobs group by status`).all().map((r) => [r.status, r.n]));
    return { events: ev, jobs, oldestEvent: db.prepare(`select received_at from channel_events where status in ('received','failed') order by received_at limit 1`).get()?.received_at || null, oldestJob: db.prepare(`select created_at from jobs where status in ('pending','failed') order by created_at limit 1`).get()?.created_at || null };
  }
  return { receive, processNext, processNextJob, drain, replay, retryJob, stats };
}

function redact(raw) { try { const s = JSON.stringify(raw); return JSON.parse(s.length > 4000 ? s.slice(0, 4000) : s); } catch { return null; } }
