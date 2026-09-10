// CRM contract + reconciliation (T-26, T-27) against the local contract
// receiver, and reliability behaviours (T-13 crash/lease, T-28 provider
// failures, unknown outcomes, forged webhooks, extractor outage).
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { server as receiver } from "../scripts/crm-receiver.mjs";
import { WebhookCrmAdapter } from "../src/crm.mjs";
import { createServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { CloudApiTransport } from "../src/transport/cloud-api.mjs";
import crypto from "node:crypto";

describe("CRM integration and reliability", () => {
  let h, port = 5900 + Math.floor(Math.random() * 90), base;
  before(async () => { await new Promise((r) => receiver.listen(port, "127.0.0.1", r)); base = `http://127.0.0.1:${port}`; h = await buildApp({ extractor: "simulator", env: { CRM_PROVIDER: "webhook", CRM_WEBHOOK_URL: base, CRM_TIMEOUT_MS: "800" } }); });
  after(async () => { await h.close(); await new Promise((r) => receiver.close(r)); });
  const fault = (mode) => fetch(`${base}/fault`, { method: "POST", body: JSON.stringify({ mode }) });

  it("T-26: registration, entry and winner events reach the CRM with stable keys, no identity numbers, and are confirmed by read-back", async () => {
    const ph = "263771000501"; await h.register(ph, { first: "Crm", last: "One", identity: "TESTCRM1X" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "CRM-1" }))); assert.equal(r.receipt.status, "QUALIFIED");
    for (let i = 0; i < 5; i++) await h.app.worker.tick();
    const ev = h.db.prepare(`select * from crm_events where entity_type='entry' order by created_at desc limit 1`).get();
    assert.equal(ev.status, "delivered"); assert.ok(ev.readback_at); assert.match(ev.external_key, /^test:entry:ent_/);
    const back = await (await fetch(`${base}/records/entry/${encodeURIComponent(ev.external_key)}`)).json();
    assert.equal(back.entity_version, 1); assert.equal(back.submission_reference, r.outcomes[0].match(/R-[A-Z0-9]+/)[0]); assert.ok(!JSON.stringify(back).includes("TESTCRM1X"));
    const sub = h.db.prepare(`select * from crm_events where entity_type='submission' and entity_id=?`).get(r.receiptId); assert.equal(sub.status, "delivered");
    const health = await h.app.crm.health(); assert.equal(health.mode, "configured"); assert.equal(health.ok, true);
  });
  it("T-27: CRM down -> entries unaffected, events retry and survive; timeout-after-write -> unknown outcome reconciled without a duplicate; older version never regresses", async () => {
    await fault("down");
    const ph = "263771000502"; await h.register(ph, { first: "Crm", last: "Two", identity: "TESTCRM2X" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "CRM-2" }))); assert.equal(r.receipt.status, "QUALIFIED", "entry accepted while CRM is down");
    for (let i = 0; i < 3; i++) await h.app.worker.tick();
    const ev = h.db.prepare(`select * from crm_events where entity_type='entry' order by created_at desc limit 1`).get(); assert.equal(ev.status, "retryable_failure"); assert.ok(ev.attempts >= 1);
    await fault("timeout-after-write");
    h.db.prepare(`update crm_events set next_attempt_at=null where id=?`).run(ev.id);
    await h.app.worker.tick(); await new Promise((r) => setTimeout(r, 900)); await h.app.worker.tick();
    let ev2 = h.db.prepare(`select * from crm_events where id=?`).get(ev.id);
    // the receiver stored the record even though the client timed out: read-back during delivery may already confirm it
    assert.ok(["unknown_outcome", "delivered"].includes(ev2.status), ev2.status);
    await fault("none");
    const rec = await h.app.crm.reconcile(); assert.ok(rec.checked >= 0);
    ev2 = h.db.prepare(`select * from crm_events where id=?`).get(ev.id); assert.ok(["delivered", "reconciled"].includes(ev2.status));
    const all = await (await fetch(`${base}/records`)).json(); assert.equal(all.records.filter((x) => x.external_key === ev.external_key).length, 1, "no duplicate CRM object");
    // older version cannot overwrite newer: emit v3 then v2
    h.app.crm.emit({ entityType: "entry", entityId: ev.entity_id, entityVersion: 3, payload: { participantId: r.receipt.participant_id, campaignCode: "X", period: "W0", status: "active" } });
    for (let i = 0; i < 3; i++) await h.app.worker.tick();
    h.app.crm.emit({ entityType: "entry", entityId: ev.entity_id, entityVersion: 2, payload: { participantId: r.receipt.participant_id, campaignCode: "X", period: "W0", status: "excluded" } });
    for (let i = 0; i < 3; i++) await h.app.worker.tick();
    const v2 = h.db.prepare(`select status, last_error from crm_events where entity_id=? and entity_version=2`).get(ev.entity_id); assert.equal(v2.status, "permanent_failure"); assert.match(v2.last_error, /superseded/);
    const back = await (await fetch(`${base}/records/entry/${encodeURIComponent(ev.external_key)}`)).json(); assert.equal(back.entity_version, 3);
  });
  it("not_configured provider: events queue visibly and nothing is marked delivered", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try { await h2.register("263771000503", { first: "Nina", last: "Cee", identity: "TESTNC0X" }); await h2.app.worker.tick(); const s = h2.app.crm.reconcileView(); assert.equal(s.provider, "none"); assert.ok(s.pending >= 1); assert.equal(s.delivered, 0); assert.equal((await h2.app.crm.health()).mode, "not_configured"); }
    finally { await h2.close(); }
  });
  it("T-13: a worker crash mid-extraction leaves a lease that expires; the job resumes and awards exactly once; replayed webhooks are deduped", async () => {
    const ph = "263771000504"; await h.register(ph, { first: "Crash", last: "Test", identity: "TESTCRSHX" });
    await h.selectOutlet(ph);
    const ev = await h.say(ph, "", { image: await h.simImage(h.simReceipt({ no: "CRASH-1" })), drain: false });
    await h.app.intake.processNext();  // submission created, job enqueued
    const job = h.db.prepare(`select * from jobs where kind='receipt.process' and status='pending' order by created_at desc limit 1`).get();
    // simulate: worker took the lease and died
    h.db.prepare(`update jobs set status='processing', lease_until=?, attempts=1 where id=?`).run(new Date(Date.now() - 1000).toISOString(), job.id);
    h.db.prepare(`update receipts set status='processing' where id=?`).run(JSON.parse(job.payload_json).receiptId);
    assert.equal((await h.app.intake.processNextJob())?.ok, true, "expired lease is re-taken");
    const rc = h.db.prepare(`select * from receipts where id=?`).get(JSON.parse(job.payload_json).receiptId); assert.equal(rc.status, "QUALIFIED");
    await h.app.intake.processNextJob(); // nothing left
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(rc.id).n, 1);
    const replay = h.app.intake.receive({ provider: "simulator", providerMessageId: h.db.prepare(`select provider_message_id from channel_events where id=?`).get(ev.id).provider_message_id, phoneUid: ph, type: "message.image", inlineMediaB64: "x" });
    assert.equal(replay.duplicate, true);
    // inbound event failing repeatedly dead-letters with an alert and can be replayed by an operator
    const bad = h.app.intake.receive({ provider: "simulator", providerMessageId: "bad-ev", phoneUid: ph, type: "message.text", text: "hi" });
    h.db.prepare(`update channel_events set attempts=4, status='failed' where id=?`).run(bad.id);
    const orig = h.app.conversation.handle; h.app.conversation.handle = async () => { throw new Error("boom"); };
    await h.app.intake.processNext(); h.app.conversation.handle = orig;
    assert.equal(h.db.prepare(`select status from channel_events where id=?`).get(bad.id).status, "dead");
    assert.ok(h.db.prepare(`select 1 from alerts where kind='inbound.dead_letter'`).get());
    assert.equal(h.app.intake.replay(bad.id, "adm"), true); await h.app.intake.drain();
    assert.equal(h.db.prepare(`select status from channel_events where id=?`).get(bad.id).status, "processed");
  });
  it("T-28: WhatsApp send failures — retryable backoff, permanent failure, unknown outcome never blindly retried; delivery callbacks update state; extractor outage delays rather than rejects", async () => {
    const ph = "263771000505"; await h.register(ph, { first: "Out", last: "Box", identity: "TESTOUTBX" });
    const pid = h.domain.getParticipantByPhone(ph).id;
    h.app.transport.failNext = { message: "503 from provider" };
    const q = h.app.outbox.enqueueWhatsApp({ waPhoneUid: ph, kind: "text", purpose: "reply", payload: "hello", idempotencyKey: `t28:${Date.now()}` });
    await h.app.worker.tick(); let m = h.app.outbox.get(q.id); assert.equal(m.status, "retryable_failure"); assert.ok(m.next_attempt_at);
    h.db.prepare(`update outbound_messages set next_attempt_at=null where id=?`).run(q.id); await h.app.worker.tick(); m = h.app.outbox.get(q.id); assert.equal(m.status, "sent");
    h.app.transport.failNext = { message: "timeout", unknownOutcome: true };
    const u = h.app.outbox.enqueueWhatsApp({ waPhoneUid: ph, kind: "text", purpose: "winner_contact", payload: "win", idempotencyKey: `t28u:${Date.now()}` });
    await h.app.worker.tick(); await h.app.worker.tick(); assert.equal(h.app.outbox.get(u.id).status, "unknown_outcome", "held for operator resolution, not re-sent");
    assert.equal(h.app.outbox.retry(u.id), true); await h.app.worker.tick(); assert.equal(h.app.outbox.get(u.id).status, "sent");
    // delivery callbacks by provider id, including out-of-order (read before delivered)
    const pm = h.app.outbox.get(u.id).provider_message_id;
    h.app.intake.receive({ provider: "simulator", providerMessageId: pm, type: "delivery.status", status: "read", phoneUid: ph }); h.app.intake.receive({ provider: "simulator", providerMessageId: pm, type: "delivery.status", status: "delivered", phoneUid: ph });
    await h.app.intake.drain(); const fin = h.app.outbox.get(u.id); assert.equal(fin.status, "read"); assert.ok(fin.delivered_at && fin.read_at);
    // recipient allowlist in non-production blocks other numbers permanently and visibly
    h.domain.setSetting("outbound.allowed_recipients", ["263770000001"], "test");
    const blocked = h.app.outbox.enqueueWhatsApp({ waPhoneUid: ph, kind: "text", purpose: "reply", payload: "x", idempotencyKey: `t28b:${Date.now()}` }); await h.app.worker.tick(); assert.equal(h.app.outbox.get(blocked.id).error_code, "RECIPIENT_NOT_ALLOWED"); h.domain.setSetting("outbound.allowed_recipients", [], "test");
    // extractor outage -> delayed + retry job, participant told it is delayed, never a rejection
    const orig = h.app.extractor.extract; h.app.extractor.extract = async () => { const e = new Error("ocr down"); e.transient = true; throw e; };
    await h.selectOutlet(ph); const ev = await h.say(ph, "", { image: await h.simImage(h.simReceipt({ no: "DELAY-1" })) });
    const rc = h.db.prepare(`select * from receipts where id=?`).get(ev.result.receiptId); assert.equal(rc.status, "delayed");
    assert.ok(h.db.prepare(`select 1 from outbound_messages where idempotency_key=?`).get(`receipt:${rc.id}:delayed`)); assert.ok(h.db.prepare(`select 1 from jobs where kind='receipt.process' and status='pending'`).get());
    h.app.extractor.extract = orig; h.db.prepare(`update jobs set run_after=null where status='pending'`).run(); await h.app.intake.drain(); await h.app.worker.tick();
    assert.equal(h.db.prepare(`select status from receipts where id=?`).get(rc.id).status, "QUALIFIED"); assert.equal(h.db.prepare(`select count(*) n from entries where participant_id=?`).get(pid).n, 1);
  });
  it("T-28: forged Cloud API webhooks are rejected; valid ones are parsed into distinct message and status events", async () => {
    const cfg = loadConfig({ ENVIRONMENT: "test", DATABASE: ":memory:", MEDIA_DIR: h.dir + "/m2", PORT: "5999", ADMIN_EMAIL: "a@x.test", ADMIN_PASSWORD: "TestAdminPassword123", IDENTITY_KEY: "k".repeat(20), WHATSAPP_TRANSPORT: "cloud-api", META_ACCESS_TOKEN: "tok", META_APP_SECRET: "secret", META_PHONE_NUMBER_ID: "111", WHATSAPP_WEBHOOK_TOKEN: "verify-me", RECEIPT_EXTRACTOR: "simulator" });
    const app = await createServer({ config: cfg, log: { log() {}, error() {}, warn() {} } }); await app.listen();
    try {
      assert.ok(app.transport instanceof CloudApiTransport);
      const hs = await fetch(`http://127.0.0.1:5999/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc`); assert.equal(await hs.text(), "abc");
      assert.equal((await fetch(`http://127.0.0.1:5999/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`)).status, 403);
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "111" }, messages: [{ id: "wamid.1", from: "263771000001", type: "text", text: { body: "hi" }, timestamp: "1700000000" }], statuses: [{ id: "wamid.out1", status: "delivered", recipient_id: "263771000001", timestamp: "1700000001" }, { id: "wamid.out1", status: "read", recipient_id: "263771000001", timestamp: "1700000002" }] } }] }] });
      const forged = await fetch(`http://127.0.0.1:5999/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body }); assert.equal(forged.status, 403);
      const sig = "sha256=" + crypto.createHmac("sha256", "secret").update(body).digest("hex");
      const ok = await fetch(`http://127.0.0.1:5999/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body }); const j = await ok.json(); assert.equal(j.accepted, 3);
      const again = await (await fetch(`http://127.0.0.1:5999/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body })).json(); assert.equal(again.deduped, 3);
      assert.equal(app.db.prepare(`select count(*) n from channel_events where event_kind like 'delivery.status:%'`).get().n, 2, "delivered and read are distinct events");
    } finally { await app.close(); }
  });
});
