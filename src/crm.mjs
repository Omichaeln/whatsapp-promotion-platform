import crypto from "node:crypto";
import { id, nowIso } from "./db.mjs";
import { canonicalJson } from "./audit.mjs";

/**
 * CRM integration (spec §16). Canonical events -> versioned outbox -> adapter
 * -> authoritative read-back -> reconciliation. The vendor is a
 * context-dependent decision (D-19); adapters implement one small contract:
 *   upsert({ externalKey, entityType, payload, entityVersion }) -> { externalId }
 *   read({ externalKey, entityType })                           -> record|null
 *   health()                                                    -> { ok, mode }
 * Provider "none" = not_configured (events accumulate, visibly, and are never
 * marked delivered). "webhook" = generic HTTP contract (used with the local
 * contract-test receiver in scripts/crm-receiver.mjs).
 */
export const MAPPING_VERSION = "crm-mapping/1";
const MAX_ATTEMPTS = 8;
/**
 * 4xx codes that mean "the caller is currently not allowed / not ready", not
 * "this payload is wrong". Treating them as permanent dead-lettered the whole
 * outbox on the FIRST attempt whenever a webhook token or vendor OAuth token was
 * rotated — an operator-fixable condition — with no automatic recovery.
 */
const RETRYABLE_HTTP = new Set([401, 403, 408, 423, 425, 429]);
/**
 * Failure classes recorded at failure time (prefixed onto last_error). After
 * MAX_ATTEMPTS a credential outage and a semantic rejection both end up as
 * `permanent_failure`, and reconcile() must be able to tell them apart to
 * requeue the first; last_error is free vendor text and must never be
 * pattern-matched for that decision.
 */
function errorClass(e) {
  if (e?.notConfigured) return "not_configured";
  if (e?.unknownOutcome) return "unknown";
  return e?.permanent ? "rejected" : "transport";
}
/** The class this row's failure was recorded with, or null for older/other rows. */
export function classOf(lastError) { return String(lastError || "").match(/^([a-z_]+): /)?.[1] || null; }

/** Field mapping: identity numbers and raw receipts are excluded by default. */
export function mapEntity(entityType, payload) {
  switch (entityType) {
    case "participant": return { external_key: payload.externalKey, first_name: payload.firstName, surname: payload.surname, phone: payload.phone, town: payload.location, status: payload.status, source: "whatsapp-promotion" };
    case "enrollment": return { external_key: payload.externalKey, participant_key: payload.participantKey, campaign: payload.campaignCode, terms_version: payload.termsVersion, privacy_version: payload.privacyVersion, marketing_consent: !!payload.marketingConsent, enrolled_at: payload.enrolledAt };
    case "submission": return { external_key: payload.externalKey, participant_key: payload.participantKey, campaign: payload.campaignCode, reference: payload.reference, outlet_code: payload.outletCode, status: payload.status, reason: payload.reason, submitted_at: payload.intakeAt };
    case "entry": return { external_key: payload.externalKey, participant_key: payload.participantKey, campaign: payload.campaignCode, period: payload.period, outlet_code: payload.outletCode, submission_reference: payload.reference, status: payload.status, awarded_at: payload.createdAt };
    case "winner": return { external_key: payload.externalKey, participant_key: payload.participantKey, campaign: payload.campaignCode, period: payload.period, prize: payload.prize, rank: payload.rank, status: payload.status };
    case "claim": return { external_key: payload.externalKey, winner_key: payload.winnerKey, state: payload.state, collection_outlet: payload.collectionOutlet, fulfilled_at: payload.fulfilledAt };
    default: return { external_key: payload.externalKey, ...payload };
  }
}

export class WebhookCrmAdapter {
  constructor({ url, token = "", timeoutMs = 10_000, fetchImpl = globalThis.fetch }) { this.url = url.replace(/\/+$/, ""); this.token = token; this.timeoutMs = timeoutMs; this.fetch = fetchImpl; }
  get name() { return "webhook"; }
  headers() { return { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }; }
  async upsert({ externalKey, entityType, payload, entityVersion, eventType }) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.url}/events`, { method: "POST", headers: this.headers(), signal: ctrl.signal, body: JSON.stringify({ entity_type: entityType, external_key: externalKey, entity_version: entityVersion, event_type: eventType, mapping_version: MAPPING_VERSION, record: payload }) });
      if (res.status === 409) { const e = new Error("older version rejected by CRM"); e.permanent = true; throw e; }
      // an auth/lock/too-early response is a vendor-side condition an operator
      // fixes (rotate the token, unlock the record): retry it rather than
      // dead-lettering every queued event at the first tick of the outage.
      if (!res.ok) { const e = new Error(`crm http ${res.status}`); e.permanent = res.status >= 400 && res.status < 500 && !RETRYABLE_HTTP.has(res.status); throw e; }
      const j = await res.json().catch(() => ({}));
      return { externalId: j.id || j.external_id || externalKey };
    } catch (e) {
      if (e.name === "AbortError") { const u = new Error("crm timeout (outcome unknown)"); u.unknownOutcome = true; throw u; }
      throw e;
    } finally { clearTimeout(t); }
  }
  async read({ externalKey, entityType }) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.url}/records/${encodeURIComponent(entityType)}/${encodeURIComponent(externalKey)}`, { headers: this.headers(), signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`crm read http ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }
  async health() {
    try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000); const res = await this.fetch(`${this.url}/health`, { signal: ctrl.signal, headers: this.headers() }); clearTimeout(t); return { ok: res.ok, mode: "configured", provider: this.name, url: this.url }; }
    catch (e) { return { ok: false, mode: "configured", provider: this.name, error: e.message }; }
  }
}

export class NoneCrmAdapter {
  get name() { return "none"; }
  async upsert() { const e = new Error("CRM provider not configured (D-19)"); e.notConfigured = true; throw e; }
  async read() { return null; }
  async health() { return { ok: false, mode: "not_configured", provider: "none", note: "events are queued and visible; no delivery attempted until a provider is configured" }; }
}

export function createCrm({ db, cfg, domain, now = nowIso, adapter = null, environment = "local" }) {
  const provider = adapter ? adapter.name : (cfg?.provider || "none");
  const ad = adapter || (provider === "webhook" && cfg?.webhookUrl ? new WebhookCrmAdapter({ url: cfg.webhookUrl, token: cfg.webhookToken, timeoutMs: cfg.timeoutMs || 10_000 }) : new NoneCrmAdapter());
  const externalKey = (entityType, entityId) => `${environment}:${entityType}:${entityId}`;
  const next = db.prepare(`select * from crm_events where (next_attempt_at is null or next_attempt_at <= ?) and ((status in ('pending','retryable_failure') and (lease_until is null or lease_until < ?)) or (status='sending' and lease_until < ?)) order by created_at limit 1`);

  function emit({ entityType, entityId, entityVersion, eventType = "upsert", payload, correlationId = null }) {
    const key = externalKey(entityType, entityId);
    const mapped = mapEntity(entityType, { ...payload, externalKey: key, participantKey: payload.participantId ? externalKey("participant", payload.participantId) : payload.participantKey, winnerKey: payload.winnerId ? externalKey("winner", payload.winnerId) : undefined });
    const eid = id("crm");
    const payloadHash = hash(mapped);
    const r = db.prepare(`insert or ignore into crm_events (id, provider, entity_type, entity_id, entity_version, event_type, mapping_version, external_key, payload_json, payload_hash, status, created_at, correlation_id)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eid, ad.name, entityType, entityId, entityVersion, eventType, MAPPING_VERSION, key, JSON.stringify(mapped), payloadHash, "pending", now(), correlationId);
    if (r.changes) return { id: eid, externalKey: key };
    // INSERT OR IGNORE hit UNIQUE (entity_type, entity_id, entity_version,
    // event_type). Re-emitting the SAME payload is a benign idempotent repeat.
    // A DIFFERENT payload under the same version means a distinct event is
    // being thrown away, which the CRM would never learn about — that is data
    // loss and must be loud, not a silent no-op.
    const existing = db.prepare(`select id, payload_hash from crm_events where entity_type=? and entity_id=? and entity_version=? and event_type=?`)
      .get(entityType, entityId, entityVersion, eventType);
    const comparable = !!existing && /^[0-9a-f]{64}$/.test(String(existing.payload_hash || ""));
    const collision = comparable && existing.payload_hash !== payloadHash;
    if (collision) {
      domain?.alert?.({ kind: "crm.event_dropped", severity: "critical", runbook: "docs/runbooks/crm-reconciliation.md",
        message: `CRM ${entityType} ${entityId} version ${entityVersion} was dropped: a different payload already holds that version`,
        detail: { entityType, entityId, entityVersion, eventType, existingEventId: existing.id } });
      domain?.metric?.("crm.event_dropped", 1, { entityType });
    }
    return { existed: true, externalKey: key, collision, existingId: existing?.id || null };
  }

  async function deliverOne({ leaseSeconds = 60 } = {}) {
    const job = next.get(now(), now(), now());
    if (!job) return null;
    if (ad.name === "none") return { id: job.id, skipped: "not_configured" };
    const leased = db.prepare(`update crm_events set status='sending', lease_until=?, attempts=attempts+1 where id=? and (status in ('pending','retryable_failure') or (status='sending' and lease_until < ?))`).run(new Date(Date.now() + leaseSeconds * 1000).toISOString(), job.id, now());
    if (!leased.changes) return { id: job.id, skipped: "leased" };
    const payload = JSON.parse(job.payload_json);
    // older-event guard: never let an older version overwrite a newer delivered one
    const ref = db.prepare(`select * from crm_external_refs where entity_type=? and entity_id=? and provider=?`).get(job.entity_type, job.entity_id, ad.name);
    if (ref && ref.last_entity_version > job.entity_version) {
      db.prepare(`update crm_events set status='permanent_failure', last_error='superseded by newer version', lease_until=null where id=?`).run(job.id);
      return { id: job.id, superseded: true };
    }
    try {
      const res = await ad.upsert({ externalKey: job.external_key, entityType: job.entity_type, payload, entityVersion: job.entity_version, eventType: job.event_type });
      // authoritative read-back: the vendor record must carry our version
      const back = await ad.read({ externalKey: job.external_key, entityType: job.entity_type }).catch(() => null);
      const confirmed = back && Number(back.entity_version) >= Number(job.entity_version);
      // delivered_at is only ever a CONFIRMED delivery: stamping it on the
      // unknown_outcome branch made "how many events reached the CRM?" (a
      // delivered_at is not null count) silently overstate delivery, and
      // disagree with the status column in the same row. external_id stays: the
      // vendor really did return it and reconcile() needs it as the handle.
      db.prepare(`update crm_events set status=?, external_id=?, delivered_at=?, lease_until=null, readback_json=?, readback_at=?, last_error=? where id=?`)
        .run(confirmed ? "delivered" : "unknown_outcome", res.externalId || null, confirmed ? now() : null, back ? JSON.stringify(back).slice(0, 4000) : null, now(), confirmed ? null : "read-back did not confirm the written version", job.id);
      if (confirmed) db.prepare(`insert into crm_external_refs (entity_type, entity_id, provider, external_id, last_entity_version, updated_at) values (?,?,?,?,?,?) on conflict(entity_type, entity_id, provider) do update set external_id=excluded.external_id, last_entity_version=max(crm_external_refs.last_entity_version, excluded.last_entity_version), updated_at=excluded.updated_at`).run(job.entity_type, job.entity_id, ad.name, res.externalId || job.external_key, job.entity_version, now());
      return { id: job.id, delivered: confirmed, readback: !!back };
    } catch (e) {
      const attempts = job.attempts + 1;
      let status = e.permanent || attempts >= MAX_ATTEMPTS ? "permanent_failure" : "retryable_failure";
      if (e.unknownOutcome) status = "unknown_outcome";
      // record WHY it failed, not just what the vendor said: once the attempt
      // budget is spent, only this class tells reconcile() that the row is an
      // outage casualty worth requeueing rather than a rejected payload.
      db.prepare(`update crm_events set status=?, last_error=?, lease_until=null, next_attempt_at=? where id=?`).run(status, `${errorClass(e)}: ${String(e.message)}`.slice(0, 300), status === "retryable_failure" ? new Date(Date.now() + Math.min(2 ** attempts, 600) * 1000).toISOString() : null, job.id);
      if (status !== "retryable_failure") domain?.alert?.({ kind: "crm.delivery", severity: "warning", message: `CRM event ${job.id} ${status}: ${e.message}`, runbook: "docs/runbooks/crm-reconciliation.md" });
      return { id: job.id, status, error: e.message };
    }
  }

  /** Reconcile unknown/undelivered events against the vendor's actual records. */
  async function reconcile({ limit = 50 } = {}) {
    // Status priority, not plain created_at: permanent failures are never
    // cleared by this scan, so an old backlog of them used to occupy the whole
    // oldest-N window for ever and newer unknown_outcome events — entries and
    // winners the CRM may never have received — were never even read.
    // Two competing needs: newer unknown_outcome events must not be starved by
    // an old permanent_failure backlog, AND the transport requeue below must
    // actually reach those permanent failures. Ordering alone cannot do both —
    // ranking permanent_failure last simply moved the starvation onto the
    // recovery path. So scan two bounded slices and merge them.
    const share = Math.max(1, Math.floor(limit / 4));
    const live = db.prepare(`select * from crm_events where status in ('unknown_outcome','retryable_failure')
      order by case status when 'unknown_outcome' then 0 else 1 end, created_at limit ?`).all(limit - share);
    const dead = db.prepare(`select * from crm_events where status='permanent_failure' order by created_at limit ?`).all(share + (limit - share - live.length));
    const rows = [...live, ...dead];
    const out = { scanned: rows.length, checked: 0, reconciled: 0, requeued: 0, unreachable: 0, differences: [], errors: [] };
    for (const job of rows) {
      let back = null;
      try { back = await ad.read({ externalKey: job.external_key, entityType: job.entity_type }); }
      catch (e) {
        // A swallowed read error used to be indistinguishable from "checked and
        // clean", and that object is what the admin route writes into the audit
        // chain as the outcome of the operator's Reconcile. Name the failure,
        // attribute it to the event, and never count it as checked.
        out.unreachable++;
        if (out.errors.length < 20) out.errors.push({ id: job.id, error: String(e?.message || e).slice(0, 200) });
        continue;
      }
      out.checked++;
      if (back && Number(back.entity_version) >= Number(job.entity_version)) {
        // the vendor is proven to hold our version: that is a confirmed delivery
        // delivered_at must describe THIS row's delivery. A row the vendor holds
        // because a LATER version superseded it was never sent, so stamping it
        // would overstate delivery just as surely as the bug this replaced.
        db.prepare(`update crm_events set status='reconciled', readback_json=?, readback_at=?, delivered_at=coalesce(delivered_at, case when external_id is not null then ? else null end), lease_until=null where id=?`).run(JSON.stringify(back).slice(0, 4000), now(), now(), job.id);
        db.prepare(`insert into crm_external_refs (entity_type, entity_id, provider, external_id, last_entity_version, updated_at) values (?,?,?,?,?,?) on conflict(entity_type, entity_id, provider) do update set last_entity_version=max(crm_external_refs.last_entity_version, excluded.last_entity_version), updated_at=excluded.updated_at`).run(job.entity_type, job.entity_id, ad.name, back.id || job.external_key, job.entity_version, now());
        out.reconciled++;
      } else if (job.status === "unknown_outcome") {
        // vendor does not have it: safe to retry (no duplicate risk because upsert is keyed)
        db.prepare(`update crm_events set status='pending', next_attempt_at=null where id=?`).run(job.id); out.requeued++;
      } else if (job.status === "permanent_failure" && classOf(job.last_error) === "transport") {
        // The vendor is reachable again but does not hold this event: it died of
        // an auth/transport outage (e.g. a rotated credential exhausting the
        // attempt budget), not of a rejected payload. This is the bulk recovery
        // — without it a single credential incident dead-letters the whole
        // outbox and the only cure is one HTTP retry per event id. Superseded
        // and rejected rows carry a different class and are left alone.
        // Bounded: an undeliverable row must not be requeued by every Reconcile
        // press for ever. The marker rides in last_error, which the class
        // prefix already owns, so no schema change is needed.
        const requeues = Number((/\[requeued x(\d+)\]/.exec(job.last_error || "") || [])[1] || 0);
        if (requeues >= 3) {
          out.differences.push({ id: job.id, entity: `${job.entity_type}:${job.entity_id}`, vendorVersion: back?.entity_version ?? null, ourVersion: job.entity_version, status: job.status, note: "transport class, but already requeued 3 times; needs a person" });
        } else {
          const marked = `${String(job.last_error || "").replace(/ \[requeued x\d+\]$/, "")} [requeued x${requeues + 1}]`;
          db.prepare(`update crm_events set status='pending', next_attempt_at=null, lease_until=null, attempts=0, last_error=? where id=?`).run(marked, job.id);
          out.requeued++;
        }
      } else out.differences.push({ id: job.id, entity: `${job.entity_type}:${job.entity_id}`, vendorVersion: back?.entity_version ?? null, ourVersion: job.entity_version, status: job.status });
    }
    if (out.unreachable) {
      // partial (not thrown): the admin route audits the returned object on its
      // success path, so a failed run must still leave a record of the attempt.
      out.partial = true;
      domain?.alert?.({ kind: "crm.reconcile_unreachable", severity: "warning", runbook: "docs/runbooks/crm-reconciliation.md",
        message: `CRM reconciliation could not reach the vendor for ${out.unreachable} of ${out.scanned} events`,
        detail: { unreachable: out.unreachable, checked: out.checked, scanned: out.scanned, errors: out.errors.slice(0, 5) } });
      domain?.metric?.("crm.reconcile_unreachable", out.unreachable);
    }
    return out;
  }

  function reconcileView() {
    const c = (s) => db.prepare(`select count(*) n from crm_events where status=?`).get(s).n;
    return { provider: ad.name, pending: c("pending"), sending: c("sending"), delivered: c("delivered"), retryable_failure: c("retryable_failure"), permanent_failure: c("permanent_failure"), unknown_outcome: c("unknown_outcome"), reconciled: c("reconciled"), oldestPending: db.prepare(`select created_at from crm_events where status in ('pending','retryable_failure') order by created_at limit 1`).get()?.created_at || null };
  }
  function retry(eventId) { return db.prepare(`update crm_events set status='pending', next_attempt_at=null, lease_until=null, attempts=0 where id=? and status in ('retryable_failure','permanent_failure','unknown_outcome')`).run(eventId).changes > 0; }
  function list({ status = null, limit = 100 } = {}) {
    return status ? db.prepare(`select id, entity_type, entity_id, entity_version, event_type, status, attempts, last_error, external_id, readback_at, created_at, delivered_at from crm_events where status=? order by created_at desc limit ?`).all(status, limit)
      : db.prepare(`select id, entity_type, entity_id, entity_version, event_type, status, attempts, last_error, external_id, readback_at, created_at, delivered_at from crm_events order by created_at desc limit ?`).all(limit);
  }
  return { emit, deliverOne, reconcile, reconcileView, retry, list, health: () => ad.health(), adapter: ad, mappingPreview: (t, p) => mapEntity(t, { ...p, externalKey: externalKey(t, p.id || "example") }) };
}

/**
 * Digest of a mapped payload, used to tell a benign idempotent re-emit from a
 * DIFFERENT event colliding on an already-used version.
 *
 * This was previously `base64(JSON.stringify(o)).slice(0, 32)` — the first 24
 * bytes of the payload, not a digest. Every mapped payload begins with the same
 * `{"external_key":"<env>:<type>:<id>"...` prefix, so two completely different
 * events for one entity produced identical `payload_hash` values and nothing
 * comparing them could ever see a difference.
 */
function hash(o) { return crypto.createHash("sha256").update(canonicalJson(o)).digest("hex"); }
