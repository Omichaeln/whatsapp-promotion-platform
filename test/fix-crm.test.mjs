// Fixes for the CRM outbox audit package (crm-2, crm-3, crm-5/crosscut-10, crm-8).
// Each test drives src/crm.mjs directly with a stub adapter, because the defects
// are about what reconcile()/deliverOne() record when the vendor misbehaves.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { createCrm, WebhookCrmAdapter } from "../src/crm.mjs";

/** Minimal adapter over an in-memory vendor store, with injectable faults. */
function stubAdapter({ records = new Map(), readError = null, upsertError = null } = {}) {
  return {
    records,
    get name() { return "stub"; },
    async upsert({ externalKey, entityType, entityVersion }) {
      if (upsertError) throw upsertError();
      records.set(`${entityType}:${externalKey}`, { id: "vend-1", external_key: externalKey, entity_version: Number(entityVersion) });
      return { externalId: "vend-1" };
    },
    async read({ externalKey, entityType }) {
      if (readError) throw readError();
      return records.get(`${entityType}:${externalKey}`) || null;
    },
    async health() { return { ok: true, mode: "configured", provider: "stub" }; },
  };
}

describe("CRM outbox fixes: reconciliation honesty, starvation, credential failures, delivered_at", () => {
  let h;
  before(async () => { h = await buildApp({ extractor: "simulator", seed: false }); });
  after(async () => { await h.close(); });

  const clear = () => { h.db.prepare(`delete from crm_events`).run(); h.db.prepare(`delete from crm_external_refs`).run(); };
  const row = (id) => h.db.prepare(`select * from crm_events where id=?`).get(id);
  let seq = 0;
  function seed({ status, createdAt, entityId = null, version = 1, lastError = null, attempts = 0, type = "entry" }) {
    const eid = `crm_fix_${++seq}`;
    const entity = entityId || `ent_fix_${seq}`;
    const key = `local:${type}:${entity}`;
    h.db.prepare(`insert into crm_events (id, provider, entity_type, entity_id, entity_version, event_type, mapping_version, external_key, payload_json, payload_hash, status, attempts, last_error, created_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(eid, "stub", type, entity, version, "upsert", "crm-mapping/1", key, "{}", "a".repeat(64), status, attempts, lastError, createdAt);
    return { id: eid, externalKey: key, entityId: entity };
  }

  it("crm-5 / crosscut-10: a reconciliation run against an unreachable vendor is never reported as clean", async () => {
    clear();
    for (let i = 0; i < 4; i++) seed({ status: "unknown_outcome", createdAt: `2026-05-0${i + 1}T00:00:00.000Z` });
    const crm = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: stubAdapter({ readError: () => new Error("connect ECONNREFUSED https://vendor.example/records/entry/local:entry:ent_1") }) });
    const before = h.db.prepare(`select count(*) n from alerts where kind='crm.reconcile_unreachable'`).get().n;
    const out = await crm.reconcile();

    assert.equal(out.unreachable, 4, "every failed vendor read must be counted");
    assert.equal(out.partial, true, "a run that could not reach the vendor must be marked partial");
    assert.equal(out.checked, 0, "checked must count reads that actually completed");
    assert.equal(out.errors.length, 4, "each failure must be attributable to an event id");
    assert.ok(out.errors.every((e) => e.id && typeof e.error === "string" && e.error.length <= 200), JSON.stringify(out.errors[0]));
    assert.equal(out.differences.length, 0, "transport failures are not vendor disagreements");
    assert.equal(h.db.prepare(`select count(*) n from alerts where kind='crm.reconcile_unreachable'`).get().n, before + 1,
      "an unreachable vendor must raise an alert from inside reconcile()");
  });

  it("crm-5: a genuinely clean run stays clean — no partial flag, no alert, no errors", async () => {
    clear();
    const records = new Map();
    const s = seed({ status: "unknown_outcome", createdAt: "2026-05-01T00:00:00.000Z" });
    records.set(`entry:${s.externalKey}`, { id: "vend-1", entity_version: 1 });
    const crm = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: stubAdapter({ records }) });
    const out = await crm.reconcile();
    assert.equal(out.checked, 1);
    assert.equal(out.reconciled, 1);
    assert.equal(out.unreachable, 0);
    assert.ok(!out.partial);
    assert.equal(out.errors.length, 0);
  });

  it("crm-3: a backlog of permanent failures must not starve newer unknown_outcome events out of the scan window", async () => {
    clear();
    const records = new Map();
    for (let i = 0; i < 50; i++) seed({ status: "permanent_failure", createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, lastError: "rejected: crm http 422" });
    const fresh = seed({ status: "unknown_outcome", createdAt: "2026-06-01T00:00:00.000Z" });
    records.set(`entry:${fresh.externalKey}`, { id: "vend-9", entity_version: 1 });
    const crm = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: stubAdapter({ records }) });

    const out = await crm.reconcile();
    assert.equal(row(fresh.id).status, "reconciled", `the newer unknown_outcome event must be reached on the first pass, got ${JSON.stringify(out)}`);
    assert.equal(out.reconciled, 1);
  });

  it("crm-2: an expired CRM credential is retried, not dead-lettered on the first attempt", async () => {
    const ad = new WebhookCrmAdapter({ url: "http://vendor.invalid", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    await assert.rejects(
      () => ad.upsert({ externalKey: "k", entityType: "entry", payload: {}, entityVersion: 1, eventType: "upsert" }),
      (e) => { assert.notEqual(e.permanent, true, "401 is an operator-fixable credential fault, not a semantic rejection"); return true; });
    const semantic = new WebhookCrmAdapter({ url: "http://vendor.invalid", fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({}) }) });
    await assert.rejects(
      () => semantic.upsert({ externalKey: "k", entityType: "entry", payload: {}, entityVersion: 1, eventType: "upsert" }),
      (e) => { assert.equal(e.permanent, true, "a 422 payload rejection stays permanent"); return true; });

    clear();
    const crm = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: { get name() { return "webhook"; }, upsert: () => ad.upsert({ externalKey: "k", entityType: "entry", payload: {}, entityVersion: 1, eventType: "upsert" }), read: async () => null, health: async () => ({ ok: false }) } });
    const s = seed({ status: "pending", createdAt: "2026-06-02T00:00:00.000Z" });
    const r = await crm.deliverOne();
    assert.equal(r.id, s.id);
    const after = row(s.id);
    assert.equal(after.status, "retryable_failure", "a 401 storm must not dead-letter the outbox on attempt 1");
    assert.ok(after.next_attempt_at, "a retryable failure is scheduled for another attempt");
  });

  it("crm-2: after the credential is fixed, reconcile requeues the auth/transport dead-letters in bulk and leaves superseded and rejected events alone", async () => {
    clear();
    const ad401 = { get name() { return "webhook"; }, async upsert() { const e = new Error("crm http 401"); e.permanent = false; throw e; }, async read() { return null; }, async health() { return { ok: false }; } };
    const crm401 = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: ad401 });
    // attempts already at the cap: the next 401 exhausts the budget and dead-letters the row
    const dead = seed({ status: "pending", createdAt: "2026-06-03T00:00:00.000Z", attempts: 7 });
    await crm401.deliverOne();
    assert.equal(row(dead.id).status, "permanent_failure", "the attempt budget is still respected");

    const superseded = seed({ status: "permanent_failure", createdAt: "2026-06-03T00:00:01.000Z", lastError: "superseded by newer version" });
    const rejected = seed({ status: "permanent_failure", createdAt: "2026-06-03T00:00:02.000Z", lastError: "rejected: crm http 422" });

    const crmOk = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: stubAdapter({ records: new Map() }) });
    const out = await crmOk.reconcile();
    assert.equal(row(dead.id).status, "pending", `a credential-outage dead-letter must be requeued by Reconcile, got ${JSON.stringify(out)}`);
    assert.equal(row(dead.id).attempts, 0, "the requeued event gets a fresh attempt budget, or it re-dead-letters immediately");
    assert.equal(row(superseded.id).status, "permanent_failure", "a superseded event must not be re-queued (it would churn and re-alert)");
    assert.equal(row(rejected.id).status, "permanent_failure", "a semantic rejection is not fixed by retrying");
    assert.ok(out.differences.some((d) => d.id === superseded.id) && out.differences.some((d) => d.id === rejected.id));
  });

  it("crm-8: delivered_at only ever records a read-back-confirmed delivery", async () => {
    clear();
    const records = new Map();
    const failRead = { fail: true };
    const ad = {
      get name() { return "stub"; },
      async upsert({ externalKey, entityType, entityVersion }) { records.set(`${entityType}:${externalKey}`, { id: "vend-7", entity_version: Number(entityVersion) }); return { externalId: "vend-7" }; },
      async read({ externalKey, entityType }) { if (failRead.fail) throw new Error("read timeout"); return records.get(`${entityType}:${externalKey}`) || null; },
      async health() { return { ok: true }; },
    };
    const crm = createCrm({ db: h.db, cfg: {}, domain: h.domain, adapter: ad });
    const s = seed({ status: "pending", createdAt: "2026-06-04T00:00:00.000Z" });
    await crm.deliverOne();
    let after = row(s.id);
    assert.equal(after.status, "unknown_outcome");
    assert.equal(after.delivered_at, null, "an unconfirmed write must not be stamped as delivered");
    assert.equal(after.external_id, "vend-7", "the vendor id is still the handle reconcile() needs");

    failRead.fail = false;
    await crm.reconcile();
    after = row(s.id);
    assert.equal(after.status, "reconciled");
    assert.ok(after.delivered_at, "once the vendor is proven to hold our version, delivered_at is recorded");
  });
});
