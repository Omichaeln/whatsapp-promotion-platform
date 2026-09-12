import { id, nowIso } from "./db.mjs";

/**
 * Transactional outbox for WhatsApp sends (spec §7 outbox states, §18).
 * Rows are written in the same transaction as the domain change that caused
 * them and delivered by the worker under a lease. States:
 *   pending -> sending -> sent -> delivered -> read
 *   pending -> retryable_failure (backoff) -> pending ...
 *   pending -> permanent_failure | unknown_outcome
 * `unknown_outcome` is recorded when the provider call timed out after it may
 * have accepted the message; it is never blindly retried (a duplicate winner
 * notification is worse than a delayed one) and is surfaced to operators.
 */
export const OUTBOUND_STATES = ["pending", "sending", "sent", "delivered", "read", "retryable_failure", "permanent_failure", "unknown_outcome"];
const MAX_ATTEMPTS = 6;
/**
 * Codes THIS platform writes when it decides not to send. They are not provider
 * trouble, so they must not be counted into the `outbound.failures` warning,
 * whose runbook (provider-outage.md) tells an operator to check Meta's status
 * page, rotate the access token and retry the rows: a participant exercising
 * their right to withdraw, or a campaign an operator paused on purpose, would
 * otherwise raise a provider-outage alarm every hour and teach operators to
 * ignore the one alert that means WhatsApp is actually down.
 */
export const POLICY_BLOCK_CODES = ["CONSENT_WITHDRAWN", "RECIPIENT_NOT_ALLOWED", "OUTBOUND_PAUSED", "TEMPLATE_REQUIRED"];
/**
 * ...of those, the holds a human has to clear: nobody can send the message (the
 * 24h window closed and no approved template is configured) or the deployment
 * was never given an allowlist. A pause ends when the operator ends it and a
 * withdrawal is permanent by design, so neither needs an alarm.
 */
const ACTIONABLE_HOLD_CODES = ["TEMPLATE_REQUIRED", "RECIPIENT_NOT_ALLOWED"];
const inList = (xs) => xs.map(() => "?").join(",");

export function createOutbox(db, now = nowIso) {
  const insert = db.prepare(`insert or ignore into outbound_messages
    (id, provider, wa_phone_uid, kind, payload_json, idempotency_key, status, created_at, purpose, campaign_id, correlation_id, template_name)
    values (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const byKey = db.prepare(`select id from outbound_messages where idempotency_key=?`);
  const next = db.prepare(`select * from outbound_messages where (next_attempt_at is null or next_attempt_at <= ?) and ((status in ('pending','retryable_failure') and (lease_until is null or lease_until < ?)) or (status='sending' and lease_until < ?)) order by created_at limit 1`);
  const lease = db.prepare(`update outbound_messages set status='sending', lease_until=?, attempts=attempts+1 where id=? and (status in ('pending','retryable_failure') or (status='sending' and lease_until < ?))`);

  return {
    enqueueWhatsApp({ waPhoneUid, kind = "text", payload, idempotencyKey, provider = "whatsapp", purpose = "reply", campaignId = null, correlationId = null, templateName = null }) {
      if (!idempotencyKey) throw new Error("idempotencyKey required");
      const row = byKey.get(idempotencyKey);
      if (row) return { existed: true, id: row.id, key: idempotencyKey };
      const outId = id("out");
      // payload_json holds the MESSAGE ONLY. Routing metadata (recipient, kind,
      // idempotency key) lives in its own columns: it used to be spread into the
      // same object, so for kind='template' the internal idempotency key and the
      // phone uid ended up inside Meta's `template` object on the wire — unknown
      // params Graph may reject with a 400, which this adapter treats as
      // permanent and would fail every winner notification of a live draw.
      const envelope = typeof payload === "string" ? { body: payload } : { ...payload };
      insert.run(outId, provider, waPhoneUid, kind, JSON.stringify(envelope), idempotencyKey, "pending", now(), purpose, campaignId, correlationId, templateName);
      return { id: outId, key: idempotencyKey };
    },
    /**
     * Deliver one message. `dispatch(row, payload)` must return
     * { providerMessageId } or throw; a thrown error with `.unknownOutcome`
     * marks the row unknown_outcome; `.permanent` marks permanent_failure.
     * `policy(row)` may return { blocked: true, code, message, retryable }.
     */
    async processPendingWhatsApp(dispatch, { policy = null, leaseSeconds = 60 } = {}) {
      const row = next.get(now(), now(), now());
      if (!row) return null;
      const leased = lease.run(new Date(Date.now() + leaseSeconds * 1000).toISOString(), row.id, now());
      if (leased.changes === 0) return { id: row.id, skipped: true };
      const payload = JSON.parse(row.payload_json);
      if (policy) {
        const p = policy(row, payload);
        if (p?.blocked) {
          db.prepare(`update outbound_messages set status=?, last_error=?, error_code=?, lease_until=null, next_attempt_at=? where id=?`)
            .run(p.retryable ? "retryable_failure" : "permanent_failure", String(p.message || p.code).slice(0, 300), p.code, p.retryable ? backoff(row.attempts) : null, row.id);
          return { id: row.id, blocked: p.code };
        }
      }
      try {
        const res = await dispatch(row, payload);
        db.prepare(`update outbound_messages set status='sent', provider_message_id=?, sent_at=?, lease_until=null, last_error=null, error_code=null where id=?`).run(res?.providerMessageId || null, now(), row.id);
        return { id: row.id, sent: res?.providerMessageId || null };
      } catch (e) {
        const attempts = row.attempts + 1;
        let status = attempts >= MAX_ATTEMPTS || e.permanent ? "permanent_failure" : "retryable_failure";
        if (e.unknownOutcome) status = "unknown_outcome";
        db.prepare(`update outbound_messages set status=?, last_error=?, error_code=?, lease_until=null, next_attempt_at=? where id=?`)
          .run(status, String(e.message).slice(0, 300), e.code || null, status === "retryable_failure" ? backoff(attempts) : null, row.id);
        return { id: row.id, error: e.message, status };
      }
    },
    /** Provider delivery callback (sent/delivered/read/failed) by provider message id. */
    markDelivery(providerMessageId, status, { errorCode = null, at = null } = {}) {
      const row = db.prepare(`select id, status from outbound_messages where provider_message_id=?`).get(providerMessageId);
      if (!row) return false;
      const ts = at || now();
      if (status === "delivered") db.prepare(`update outbound_messages set status=case when status='read' then status else 'delivered' end, delivered_at=coalesce(delivered_at, ?) where id=?`).run(ts, row.id);
      else if (status === "read") db.prepare(`update outbound_messages set status='read', read_at=coalesce(read_at, ?), delivered_at=coalesce(delivered_at, ?) where id=?`).run(ts, ts, row.id);
      else if (status === "failed") {
        // Provider statuses are not ordered: a 'failed' can arrive after the
        // recipient has already read the message. Overwriting a proven
        // delivered/read state destroyed that evidence AND unlocked the console
        // Retry button (the runbook tells operators to retry permanent_failure),
        // which re-sent a winner notification someone had already read.
        const code = providerErrorCode(errorCode);
        if (row.status === "delivered" || row.status === "read") {
          db.prepare(`update outbound_messages set last_error=?, error_code=coalesce(error_code, ?) where id=?`).run(`provider reported failure after ${row.status}; ignored (delivery already proven)`, code, row.id);
        } else {
          db.prepare(`update outbound_messages set status='permanent_failure', error_code=?, last_error='provider reported failure' where id=?`).run(code, row.id);
        }
      }
      else if (status === "sent") db.prepare(`update outbound_messages set sent_at=coalesce(sent_at, ?) where id=?`).run(ts, row.id);
      return true;
    },
    /** Operator retry of a failed / unknown row (audited by caller). */
    retry(outId) {
      const r = db.prepare(`update outbound_messages set status='pending', next_attempt_at=null, lease_until=null, attempts=0 where id=? and status in ('retryable_failure','permanent_failure','unknown_outcome')`).run(outId);
      return r.changes > 0;
    },
    get: (outId) => db.prepare(`select * from outbound_messages where id=?`).get(outId),
    stats() {
      const rows = db.prepare(`select status, count(*) n from outbound_messages group by status`).all();
      const oldest = db.prepare(`select created_at from outbound_messages where status in ('pending','retryable_failure') order by created_at limit 1`).get()?.created_at || null;
      // A policy-blocked row sits in retryable_failure, which the failure alert
      // does not count — a message could be held indefinitely with nobody told.
      // Surface the age of the oldest hold SOMEONE CAN CLEAR only: an
      // OUTBOUND_PAUSED row is held for exactly as long as the operator wants
      // the campaign paused, and a row with no error_code is an ordinary
      // transient provider retry sitting in backoff. Counting either made any
      // pause longer than half an hour, and every provider blip, raise a warning
      // on the hour.
      const held = db.prepare(`select created_at from outbound_messages where status='retryable_failure' and error_code in (${inList(ACTIONABLE_HOLD_CODES)}) order by created_at limit 1`).get(...ACTIONABLE_HOLD_CODES)?.created_at || null;
      // Failures the PROVIDER caused: everything terminal except our own policy
      // decisions (see POLICY_BLOCK_CODES). unknown_outcome is always provider
      // trouble — the call timed out after the message may have been accepted.
      const providerFailures = db.prepare(`select count(*) n from outbound_messages where status='unknown_outcome' or (status='permanent_failure' and (error_code is null or error_code not in (${inList(POLICY_BLOCK_CODES)})))`).get(...POLICY_BLOCK_CODES).n;
      // A message that can never now be delivered because the service window
      // closed on it: the winner is marked 'notified' and nothing was sent.
      // RECIPIENT_NOT_ALLOWED is deliberately absent — a permanent block on a
      // number that is not a designated test recipient is the allowlist working.
      const undeliverable = db.prepare(`select count(*) n from outbound_messages where status='permanent_failure' and error_code='TEMPLATE_REQUIRED'`).get().n;
      return { byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])), oldestPending: oldest, oldestHeld: held, providerFailures, undeliverable };
    },
    list({ status = null, limit = 100 } = {}) {
      return status ? db.prepare(`select id, wa_phone_uid, kind, purpose, status, attempts, last_error, error_code, provider_message_id, created_at, sent_at, delivered_at from outbound_messages where status=? order by created_at desc limit ?`).all(status, limit)
        : db.prepare(`select id, wa_phone_uid, kind, purpose, status, attempts, last_error, error_code, provider_message_id, created_at, sent_at, delivered_at from outbound_messages order by created_at desc limit ?`).all(limit);
    },
  };
}

function backoff(attempts) { return new Date(Date.now() + Math.min(2 ** attempts, 300) * 1000 + Math.floor(Math.random() * 1000)).toISOString(); }

/**
 * One shape for error_code whatever the source. The send path records Meta
 * errors as `META_<code>`; the delivery-status path bound the raw JSON number
 * into a TEXT column, which node:sqlite stores as '131047.0', so no console
 * filter on a documented Meta code could ever match either form.
 */
function providerErrorCode(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : (/^\d+(\.0+)?$/.test(String(raw)) ? Number(raw) : NaN);
  if (Number.isFinite(n)) return `META_${Math.trunc(n)}`;
  return String(raw).startsWith("META_") ? String(raw) : String(raw).slice(0, 60);
}
