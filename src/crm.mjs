import { id, nowIso } from "./db.mjs";

/**
 * CRM synchronization (G-15, spec 11.6): canonical internal events -> durable
 * outbox -> provider adapter, with retries, dead letters, reconciliation.
 * A CRM outage NEVER rolls back a valid entry. Provider contract (D-14) is
 * supplied by the client; the webhook adapter is the default seam.
 */
export function createCrm({ db, cfg, now = nowIso }) {
  const claimNext = db.prepare(
    `select * from crm_sync_jobs where status='pending' and (next_attempt_at is null or next_attempt_at <= ?) order by created_at limit 1`);
  const markDelivered = db.prepare(
    `update crm_sync_jobs set status='delivered', external_id=?, delivered_at=?, attempts=attempts+1 where id=?`);
  const markDead = db.prepare(
    `update crm_sync_jobs set status='dead', last_error=?, attempts=attempts+1 where id=?`);
  const markRetry = db.prepare(
    `update crm_sync_jobs set status='pending', next_attempt_at=?, last_error=?, attempts=attempts+1 where id=?`);

  async function deliverOne() {
    const job = claimNext.get(now());
    if (!job) return null;
    const payload = JSON.parse(job.payload_json);
    try {
      if (cfg.provider === "webhook") {
        if (!cfg.webhookUrl) throw new Error("CRM_WEBHOOK_URL not set");
        const res = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(cfg.webhookToken ? { Authorization: `Bearer ${cfg.webhookToken}` } : {}) },
          body: JSON.stringify({ entityType: job.entity_type, entityId: job.entity_id, eventType: job.event_type, payload }),
        });
        if (!res.ok) throw new Error(`crm webhook ${res.status}`);
      }
      markDelivered.run(resExternalId(payload, job), now(), job.id);
      return { id: job.id, delivered: true };
    } catch (e) {
      const attempts = job.attempts + 1;
      if (attempts >= 8) { markDead.run(String(e.message).slice(0, 300), job.id); return { id: job.id, dead: true }; }
      markRetry.run(new Date(Date.parse(now()) + 2 ** Math.min(attempts, 6) * 1000).toISOString(), String(e.message).slice(0, 300), job.id);
      return { id: job.id, retry: true, error: e.message };
    }
  }

  function reconcileView() {
    return {
      pending: count("pending"), delivered: count("delivered"), dead: count("dead"),
      oldestPending: db.prepare(`select created_at from crm_sync_jobs where status='pending' order by created_at limit 1`).get()?.created_at || null,
    };
  }

  function count(status) { return db.prepare(`select count(*) n from crm_sync_jobs where status=?`).get(status).n; }

  return { deliverOne, reconcileView };
}

function resExternalId(payload, job) {
  return payload?.externalId || payload?.entryId || payload?.id || job.id;
}