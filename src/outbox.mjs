import { id, sha256hex, nowIso } from "./db.mjs";

/**
 * Transactional outbox (spec 10.1, 11.6): side effects (WhatsApp sends, CRM
 * writes, analytics events) are enqueued in the SAME transaction as the domain
 * change, then delivered by the worker with idempotency keys. A CRM or
 * notification outage can never invalidate an accepted entry.
 */

export function createOutbox(db, now = nowIso) {
  const insert = db.prepare(`insert or ignore into outbound_messages
    (id, provider, wa_phone_uid, kind, payload_json, idempotency_key, status, created_at)
    values (?,?,?,?,?,?,?,?)`);
  const crmInsert = db.prepare(`insert or ignore into crm_sync_jobs
    (id, entity_type, entity_id, event_type, payload_hash, payload_json, status, created_at)
    values (?,?,?,?,?,?,?,?)`);
  const claim = db.prepare(`update outbound_messages set status='pending', next_attempt_at=?
    where id=? and status='pending'`);
  const next = db.prepare(`select * from outbound_messages where status='pending' and (next_attempt_at is null or next_attempt_at <= ?)
    order by created_at limit 1`);

  return {
    /** Enqueue a WhatsApp message; unique on idempotency_key. */
    enqueueWhatsApp({ waPhoneUid, kind = "text", payload, idempotencyKey, provider = "whatsapp-cloud-api" }) {
      const key = idempotencyKey;
      const row = db.prepare(`select id from outbound_messages where idempotency_key=?`).get(key);
      if (row) return { existed: true, key };
      const outId = id("out");
      // normalize: callers may pass a plain string body or an object envelope
      const envelope = typeof payload === "string" ? { body: payload } : { ...payload, body: payload.body ?? payload };
      insert.run(outId, provider, waPhoneUid, typeof payload === "object" && payload.kind ? payload.kind : kind,
        JSON.stringify({ ...envelope, waPhoneUid, kind: typeof payload === "object" && payload.kind ? payload.kind : kind, idempotencyKey: key }), key, "pending", now());
      return { id: outId, key };
    },
    /** Enqueue a CRM sync event (one row per entity/event type). */
    enqueueCrm({ entityType, entityId, eventType, payload }) {
      const payloadHash = sha256hex(JSON.stringify(payload));
      const jobId = id("crm");
      const r = db.prepare(`select id from crm_sync_jobs where entity_type=? and entity_id=? and event_type=?`).get(entityType, entityId, eventType);
      if (r) return { existed: r.id, payloadHash };
      crmInsert.run(jobId, entityType, entityId, eventType, payloadHash, JSON.stringify(payload), "pending", now());
      return { id: jobId, payloadHash };
    },
    async processPendingWhatsApp(dispatch) {
      const row = next.get(now());
      if (!row) return null;
      const payload = JSON.parse(row.payload_json);
      try {
        const providerMsgId = await dispatch(row.provider, payload);
        db.prepare(`update outbound_messages set status='sent', provider_message_id=?, sent_at=?, attempts=attempts+1 where id=?`).run(providerMsgId, now(), row.id);
        return { id: row.id, sent: providerMsgId };
      } catch (e) {
        const attempts = row.attempts + 1;
        db.prepare(`update outbound_messages set status=?, attempts=?, last_error=?, next_attempt_at=? where id=?`)
          .run(attempts >= 5 ? "failed" : "pending", attempts, String(e.message).slice(0, 300), new Date(Date.parse(now()) + 2 ** Math.min(attempts, 6) * 1000).toISOString(), row.id);
        return { id: row.id, error: e.message };
      }
    },
  };
}