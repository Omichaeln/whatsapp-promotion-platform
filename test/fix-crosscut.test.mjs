// Cross-cutting round: the residue nobody could fix because the correct change
// spanned files owned by different engineers, plus the problems a verifier
// raised against round-two fixes in those files. Every test here was confirmed
// to FAIL against the tree before the fix that accompanies it.
import { describe, it, assert, buildApp } from "./helpers.mjs";
import { createAttemptThrottle } from "../src/server.mjs";
import { createAudit } from "../src/audit.mjs";
import { openDb, migrate } from "../src/db.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("crosscut — login throttle (round-3 reviewer problems 2 and 3)", () => {
  it("guessing cannot flood the map and keep its own hard ceiling down at the same time", () => {
    // A key at its hard ceiling stops pushing timestamps, so eviction sorted on
    // the last RECORDED attempt made the key under active attack the FIRST to be
    // thrown away: a guesser could flood fresh keys, watch its victim's scrypt
    // ceiling reset, and resume guessing (~2k junk requests per 20 further
    // verifications). A bounded map must evict something, so this does not claim
    // a flood can never drop an idle counter — it claims the key the attacker is
    // STILL HITTING is the last to go, not the first.
    let t = 1000;
    const victim = "login:acct:victim";
    const th = createAttemptThrottle({ windowMs: 60_000, maxKeys: 100, now: () => (t += 1) });
    for (let i = 0; i < 25; i++) th.hit(victim, 5, 20);
    assert.ok(th.hit(victim, 5, 20).hard > 0, "victim is pinned at its ceiling to begin with");
    for (let i = 0; i < 90; i++) th.hit(`login:acct:junk${i}`, 5, 20);
    assert.ok(th.hit(victim, 5, 20).hard > 0, "...and still is: nothing has been evicted yet");
    for (let i = 90; i < 100; i++) th.hit(`login:acct:junk${i}`, 5, 20);   // crosses the cap -> sweep
    const after = th.hit(victim, 5, 20);
    assert.ok(after.hard > 0, `the ceiling of the key still being hit must survive the sweep, got ${JSON.stringify(after)}`);
    assert.ok(th.size() <= 100, `the map stays bounded (got ${th.size()})`);
  });

  it("one flooding source cannot spend the whole account budget and lock the holder out", async () => {
    const prev = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "1";
    let h;
    try {
      h = await buildApp({ seed: false });
      const attempt = (ip, password) => h.api("/api/login", { method: "POST", body: { email: "admin@x.test", password }, headers: { "x-forwarded-for": ip } });
      for (let i = 0; i < 61; i++) await attempt("198.51.100.66", `wrong-${i}`);
      const holder = await attempt("203.0.113.9", "TestAdminPassword123");
      assert.equal(holder.status, 200, `the account holder must still get in from another address: ${JSON.stringify(holder.data)}`);
    } finally {
      if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = prev;
      await h?.close();
    }
  });

  it("a malformed credential answers 401, as the published route contract says", async () => {
    const h = await buildApp({ seed: false });
    try {
      for (const body of [{}, { email: "admin@x.test" }, { email: "admin@x.test", password: null }, { email: "admin@x.test", password: 12345 }, { email: 7, password: "TestAdminPassword123" }]) {
        const r = await h.api("/api/login", { method: "POST", body });
        assert.equal(r.status, 401, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)}`);
        assert.equal(r.data?.error?.code, "INVALID_CREDENTIALS");
      }
    } finally { await h.close(); }
  });
});

describe("crosscut — a send interrupted mid-dispatch (ops-5, outbox-2)", () => {
  it("shutdown drains the in-flight tick instead of abandoning the provider call", async () => {
    const h = await buildApp({ seed: false });
    let closed = false;
    try {
      const t = h.app.transport;
      let release; const gate = new Promise((r) => { release = r; });
      const real = t.send.bind(t);
      t.send = async (m) => { inflight.push(m); await gate; return real(m); };
      const inflight = [];
      h.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000991", payload: "You are a WINNER. Claim ref ABC123.", purpose: "winner_contact", idempotencyKey: "crosscut:drain:1" });
      h.app.worker.start();
      for (let i = 0; i < 200 && !inflight.length; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(inflight.length, 1, "the dispatch must be in flight before we shut down");
      // SIGTERM: bootstrap.mjs does `await app.close(); process.exit(0)`
      const closing = h.app.close().then(() => { closed = true; });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(closed, false, "close() must not resolve while a provider call is in flight");
      release();
      await closing;
      const row = h.db.prepare(`select status, attempts from outbound_messages where idempotency_key='crosscut:drain:1'`).get();
      assert.equal(row.status, "sent", "the drained tick recorded the outcome, so no row is left leased in 'sending'");
      assert.equal(t.sentCount, 1);
    } finally { await h.close(); }
  });

  it("a row abandoned in 'sending' is never re-dispatched: it is reclaimed for an operator", async () => {
    const h = await buildApp({ seed: false });
    try {
      const t = h.app.transport;
      h.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000992", payload: "You are a WINNER. Claim ref ABC123.", purpose: "winner_contact", idempotencyKey: "crosscut:stalled:1" });
      // exactly what SIGKILL between the provider accepting the message and the
      // status update leaves behind: leased, lease long expired
      h.db.prepare(`update outbound_messages set status='sending', attempts=1, lease_until='2000-01-01T00:00:00.000Z' where idempotency_key='crosscut:stalled:1'`).run();
      await h.app.worker.tick();
      assert.equal(t.sentCount, 0, "the message must NOT be sent a second time (the winner was already notified)");
      const still = h.db.prepare(`select status from outbound_messages where idempotency_key='crosscut:stalled:1'`).get();
      assert.equal(still.status, "sending");
      // housekeeping moves it to the state the runbook covers, and the operator
      // alert for outbound failures counts it
      h.app.worker.housekeeping();
      const row = h.db.prepare(`select id, status, error_code from outbound_messages where idempotency_key='crosscut:stalled:1'`).get();
      assert.equal(row.status, "unknown_outcome");
      assert.equal(row.error_code, "DISPATCH_INTERRUPTED");
      await h.app.worker.tick();
      assert.equal(t.sentCount, 0, "unknown_outcome is never blindly retried");
      assert.equal(h.db.prepare(`select count(*) n from alerts where kind='outbound.failures'`).get().n, 1, "an operator is told");
      // ...and the documented operator action still works
      assert.equal(h.app.outbox.retry(row.id), true);
      await h.app.worker.tick();
      assert.equal(t.sentCount, 1, "an explicit operator retry does send it");
    } finally { await h.close(); }
  });

  it("a message whose recipient was erased cannot be requeued by the operator", async () => {
    const h = await buildApp({ seed: false });
    try {
      const t = h.app.transport;
      const { id } = h.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000993", kind: "template", payload: { body: "hello" }, purpose: "winner_contact", idempotencyKey: "crosscut:erased:1" });
      // a row that WAS sent and then got a provider 'failed' webhook keeps
      // sent_at, so erasure leaves it behind with the body replaced
      h.db.prepare(`update outbound_messages set status='permanent_failure', sent_at=?, wa_phone_uid='deleted:ptc_x', payload_json='{"body":"[erased]","erased":true}' where id=?`).run(new Date().toISOString(), id);
      assert.equal(h.app.outbox.retry(id), false, "Retry must refuse an erased recipient");
      await h.app.worker.tick();
      assert.equal(t.sentCount, 0, "nothing is dispatched to a dead address");
      assert.equal(h.db.prepare(`select status from outbound_messages where id=?`).get(id).status, "permanent_failure");
    } finally { await h.close(); }
  });
});

describe("crosscut — round-two leftovers in files nobody owned", () => {
  it("GET /api/qr publishes the media type it actually returns, and is not sniffable", async () => {
    const h = await buildApp({ seed: false });
    try {
      const admin = await h.login("admin@x.test", "TestAdminPassword123");
      const doc = (await h.api("/api/openapi.json", { token: admin })).data;
      const content = doc.paths["/api/qr"].get.responses[200].content || {};
      assert.ok(content["image/svg+xml"], `the contract must describe an SVG, got ${JSON.stringify(content)}`);
      assert.ok(!content["application/json"], "and must not describe it as JSON");
      // the simulator has no QR of its own; stand one up so the served response
      // (not just the document) can be inspected
      h.app.transport.currentQr = () => "QR-PAYLOAD";
      h.app.transport.qrSvg = () => "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
      const r = await h.api("/api/qr", { token: admin, raw: true });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/svg+xml");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", "an SVG served to a browser must not be sniffable");
    } finally { await h.close(); }
  });
});

describe("crosscut — a second reviewer decision must reach the participant (pipeline-7)", { timeout: 180_000 }, () => {
  it("a receipt credited on the reviewer's second look is told so, not left on 'does not qualify'", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000994";
      await h.register(phone, { first: "Second", last: "Look", identity: "TESTP7ID1" });
      // one pack: auto-rejected below_minimum_quantity, which creates NO review task
      const sub = await h.submit(phone, await h.simImage(h.simReceipt({ no: "880011", packs: 1 })));
      assert.equal(sub.receipt.status, "NOT_QUALIFIED", JSON.stringify(sub.receipt));
      assert.equal(h.db.prepare(`select count(*) n from review_tasks where receipt_id=?`).get(sub.receiptId).n, 0);
      // support escalates; the reviewer decides twice — no validation_results row
      // is written by either decision, so attemptNo does not move between them
      h.app.pipeline.review(sub.receiptId, { reviewer: "rev_crosscut", decision: "NOT_QUALIFIED", reasonCode: "below_minimum_quantity" });
      h.app.pipeline.review(sub.receiptId, { reviewer: "rev_crosscut", decision: "QUALIFIED" });
      assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=? and status='active'`).get(sub.receiptId).n, 1, "the entry exists");
      const bodies = h.db.prepare(`select payload_json from outbound_messages where idempotency_key like ? order by created_at`).all(`receipt:${sub.receiptId}:outcome:%`).map((m) => JSON.parse(m.payload_json).body);
      assert.equal(bodies.length, 3, `one message per decision, got ${JSON.stringify(bodies)}`);
      assert.ok(/after review/i.test(bodies[2]) && /entry has been added/i.test(bodies[2]), `the participant must be told they are in the draw: ${JSON.stringify(bodies)}`);
    } finally { await h.close(); }
  });
});

describe("crosscut — an inbound event with no addressable sender (schema-3)", () => {
  it("is ignored with the raw id kept, not dead-lettered after five retries", async () => {
    const h = await buildApp({ seed: false });
    try {
      // an 18-digit group/@lid jid: normalizePhone refuses anything outside 8..15
      // digits, and the NULL it used to write violated
      // conversation_sessions.wa_phone_uid NOT NULL inside conversation.handle
      const r = h.app.intake.receive({ provider: "simulator", providerMessageId: "crosscut_badsender_1", phoneUid: "120363043211234567", type: "message.text", text: "hi", timestamp: new Date().toISOString() });
      assert.equal(r.accepted, false);
      assert.equal(r.ignored, true);
      await h.app.intake.drain(); await h.app.worker.tick();
      const ev = h.db.prepare(`select status, attempts, error, payload_json, wa_phone_uid from channel_events where provider_message_id='crosscut_badsender_1'`).get();
      assert.equal(ev.status, "ignored", `status=${ev.status} error=${ev.error}`);
      assert.equal(ev.attempts, 0, "no lease is ever taken, so nothing burns the retry ladder");
      assert.equal(JSON.parse(ev.payload_json).rawSenderId, "120363043211234567", "the raw id is kept for diagnosis");
      const alerts = h.db.prepare(`select kind, severity from alerts`).all();
      assert.deepEqual(alerts.map((a) => [a.kind, a.severity]), [["inbound.unusable_sender", "warning"]], "one warning, not a critical dead-letter");
    } finally { await h.close(); }
  });
});

describe("crosscut — the technical admin has no prize or review authority (authz-6)", { timeout: 180_000 }, () => {
  it("platform_admin cannot unmask a national ID or move an entry in or out of the draw pool", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      const admin = await h.login("admin@x.test", "TestAdminPassword123");
      assert.deepEqual(h.app.auth.listUsers().find((u) => u.email === "admin@x.test").roles, JSON.stringify(["platform_admin"]));
      const phone = "263771000995";
      await h.register(phone, { first: "Held", last: "Barred", identity: "TESTAZ6ID1" });
      const sub = await h.submit(phone, await h.simImage(h.simReceipt({ no: "990011", packs: 2 })));
      assert.equal(sub.receipt.status, "QUALIFIED", JSON.stringify(sub.receipt));
      const p = h.domain.getParticipantByPhone(phone);
      const entry = h.db.prepare(`select id from entries where receipt_id=?`).get(sub.receiptId);

      const reveal = await h.api(`/api/participants/${p.id}/reveal-identity`, { method: "POST", token: admin, body: { reason: "probe" } });
      assert.equal(reveal.status, 403, `the plaintext identity must not be readable: ${JSON.stringify(reveal.data)}`);
      const dq = await h.api(`/api/entries/${entry.id}/disqualify`, { method: "POST", token: admin, body: { reason: "probe" } });
      assert.equal(dq.status, 403, JSON.stringify(dq.data));
      assert.equal(h.db.prepare(`select status from entries where id=?`).get(entry.id).status, "active", "the entry is still in the pool");
      const ri = await h.api(`/api/entries/${entry.id}/reinstate`, { method: "POST", token: admin, body: { reason: "probe" } });
      assert.equal(ri.status, 403, JSON.stringify(ri.data));

      // ...while the technical routes a platform admin genuinely needs still work
      for (const p2 of ["/api/audit/verify", "/api/queue", "/api/integrations", "/api/audit-events"]) {
        assert.equal((await h.api(p2, { token: admin })).status, 200, `${p2} must stay open to the technical admin`);
      }
      // ...and the named business role still decides
      const reviewer = await h.staffToken("reviewer@example.test");
      assert.equal((await h.api(`/api/entries/${entry.id}/disqualify`, { method: "POST", token: reviewer, body: { reason: "genuine reviewer decision" } })).status, 200);
      const wops = await h.staffToken("fulfilment@example.test");
      const ok = await h.api(`/api/participants/${p.id}/reveal-identity`, { method: "POST", token: wops, body: { reason: "prize handover" } });
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.identity, "TESTAZ6ID1");
    } finally { await h.close(); }
  });
});

describe("crosscut — an unsigned audit checkpoint says so (ops-4)", () => {
  it("no AUDIT_CHECKPOINT_KEY means no signature, and nothing reports it as verified", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-ckp-"));
    try {
      const db = openDb(path.join(dir, "a.db"));
      migrate(db, undefined, () => {});
      const unkeyed = createAudit(db, { checkpointKey: "" });
      unkeyed.record({ actorType: "system", actorId: "sys", action: "draw.executed", targetType: "draw", targetId: "drw_1", payload: {} });
      const ckp = unkeyed.checkpoint("usr_auditor");
      assert.equal(ckp.signed, false);
      assert.equal(ckp.signature, null, "an unkeyed deployment must not fabricate an HMAC a stranger can recompute");
      // the literal fallback key "unsigned" must not verify anything
      const forged = crypto.createHmac("sha256", "unsigned").update(`${ckp.uptoId}|${ckp.headHash}`).digest("hex");
      assert.notEqual(forged, ckp.signature);
      const v = unkeyed.verifyCheckpoint({ ...ckp, signature: forged });
      assert.equal(v.signatureOk, false, "a signature computed with the public fallback key is not a signature");
      const own = unkeyed.verifyCheckpoint(ckp);
      assert.equal(own.signatureOk, false);
      assert.equal(own.headMatches, true, "the head it pins is still the head; only the signature is missing");
      assert.equal(db.prepare(`select signature from audit_checkpoints where id=?`).get(ckp.id).signature.startsWith("UNSIGNED"), true, "the retained row explains itself");
      // ...while a keyed deployment is unchanged
      const keyed = createAudit(db, { checkpointKey: "test-checkpoint-key" });
      const k = keyed.checkpoint("usr_auditor");
      assert.match(k.signature, /^[0-9a-f]{64}$/);
      assert.deepEqual(keyed.verifyCheckpoint(k), { signatureOk: true, headMatches: true });
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("crosscut — swapping the live rules is an activation too (ops-7)", { timeout: 120_000 }, () => {
  it("a production campaign's rules cannot be replaced by a version that fails the content/rules checks", async () => {
    const h = await buildApp({ seed: true });
    try {
      const manager = await h.staffToken("manager@example.test");
      // a live campaign with a rule set that passes the four content/rules checks
      const clean = { products: [{ code: "P1", name: "Qualifying pack 2kg", aliases: ["qualifying pack"], pack_grams: 2000, qualifying: true }], primary_rule: { min_packs: 2, pack_grams: 2000, min_total_grams: 4000 } };
      const content = { terms_url: "https://promo.example.com/terms", terms_version: "T1", privacy_version: "P1", winner_template_name: "winner_contact_v1" };
      const good = (await h.api(`/api/campaigns/${h.campaign.id}/versions`, { method: "POST", token: manager, body: { content, rules: clean } })).data.versionId;
      assert.equal((await h.api(`/api/campaigns/${h.campaign.id}/versions/${good}/activate`, { method: "POST", token: manager })).status, 200);
      h.db.prepare(`update campaigns set status='active' where id=?`).run(h.campaign.id);
      h.db.prepare(`update schema_meta set value='production' where key='environment'`).run();
      try {
        // (a) the rules the client approved are dropped: no qualifying products
        const noProducts = (await h.api(`/api/campaigns/${h.campaign.id}/versions`, { method: "POST", token: manager, body: { content, rules: { primary_rule: { min_packs: 1 } } } })).data.versionId;
        const r1 = await h.api(`/api/campaigns/${h.campaign.id}/versions/${noProducts}/activate`, { method: "POST", token: manager });
        assert.equal(r1.status, 409, `the swap must be refused: ${JSON.stringify(r1.data)}`);
        assert.ok(r1.data.error.failures.some((f) => f.code === "RULES_PRODUCTS"), JSON.stringify(r1.data.error.failures));
        // (b) the terms URL disappears
        const noTerms = (await h.api(`/api/campaigns/${h.campaign.id}/versions`, { method: "POST", token: manager, body: { content: { terms_version: "T2" }, rules: clean } })).data.versionId;
        const r2 = await h.api(`/api/campaigns/${h.campaign.id}/versions/${noTerms}/activate`, { method: "POST", token: manager });
        assert.equal(r2.status, 409);
        assert.ok(r2.data.error.failures.some((f) => f.code === "CONTENT_TERMS"));
        // (c) sample product aliases are reintroduced
        const sample = (await h.api(`/api/campaigns/${h.campaign.id}/versions`, { method: "POST", token: manager, body: { content, rules: { ...clean, products: [{ code: "GC", name: "Goldcane Brown Sugar 2kg", aliases: ["goldcane brown sugar"], pack_grams: 2000, qualifying: true }] } } })).data.versionId;
        assert.equal((await h.api(`/api/campaigns/${h.campaign.id}/versions/${sample}/activate`, { method: "POST", token: manager })).status, 409);
        assert.equal(h.domain.getActiveVersion(h.campaign.id).id, good, "the live version is untouched by every refused swap");
        // ...and a legitimate mid-campaign correction still goes through, even
        // though the simulated transport/extractor would fail the full gate
        const fix = (await h.api(`/api/campaigns/${h.campaign.id}/versions`, { method: "POST", token: manager, body: { content: { ...content, terms_version: "T2" }, rules: clean } })).data.versionId;
        const ok = await h.api(`/api/campaigns/${h.campaign.id}/versions/${fix}/activate`, { method: "POST", token: manager });
        assert.equal(ok.status, 200, `a typo fix must not be blocked by an unrelated provider check: ${JSON.stringify(ok.data)}`);
      } finally { h.db.prepare(`update schema_meta set value='test' where key='environment'`).run(); }
    } finally { await h.close(); }
  });
});

describe("crosscut — one national ID on several phones is detected (tests-3)", { timeout: 180_000 }, () => {
  it("a second registration with an ID already on file raises an operator alert and is audited", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      // the same human, two SIMs, the same ID written differently (the channel
      // only accepts letters, digits and dashes): the fingerprint normalises
      // case and punctuation
      await h.register("263771000801", { first: "Dup", last: "Onefile", identity: "63-123456X07" });
      assert.equal(h.db.prepare(`select count(*) n from alerts where kind='participant.identity_reuse'`).get().n, 0, "the first registration is not suspicious");
      await h.register("263771000802", { first: "Dup", last: "Onefile", identity: "63123456X07" });
      const p1 = h.domain.getParticipantByPhone("263771000801"), p2 = h.domain.getParticipantByPhone("263771000802");
      assert.equal(p1.identity_fp, p2.identity_fp, "the fingerprint matches across the two spellings (63-123456X07 vs 63123456X07)");
      const alerts = h.db.prepare(`select kind, severity, message, detail_json from alerts where kind='participant.identity_reuse'`).all();
      assert.equal(alerts.length, 1, "the reuse is reported");
      assert.equal(alerts[0].severity, "warning");
      assert.deepEqual(JSON.parse(alerts[0].detail_json).participantIds.sort(), [p1.id, p2.id].sort());
      assert.ok(!/63.?123456X07/.test(alerts[0].message + alerts[0].detail_json), "and the alert never carries the plaintext ID");
      assert.equal(h.db.prepare(`select count(*) n from audit_events where action='participant.identity_reuse'`).get().n, 1);
      // the decision-neutral part: nothing is blocked, because D-08/D-10/D-16 are open
      assert.equal(p2.status, "active");
      const third = await h.register("263771000803", { first: "Dup", last: "Onefile", identity: "63123456X07" });
      assert.ok(third, "a third registration still succeeds; the client decides whether it should not");
      assert.match(h.db.prepare(`select message from alerts where kind='participant.identity_reuse'`).get().message, /3 phone numbers/, "the alert is refreshed, not swallowed");
    } finally { await h.close(); }
  });
});

describe("crosscut — handoff really does suspend automated outbound (conversation-7)", { timeout: 240_000 }, () => {
  it("a receipt outcome decided during a support handoff is held, then delivered when the operator releases", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000996";
      await h.register(phone, { first: "Paused", last: "Replies", identity: "TESTCV7ID1" });
      await h.selectOutlet(phone);
      // the image arrives, and the participant asks for a human before the OCR
      // job runs: the copy promises "Automatic replies are paused until they
      // close the conversation"
      const img = await h.simImage(h.simReceipt({ no: "660011", packs: 2 }));
      await h.say(phone, "", { image: img, drain: false });
      const sup = await h.say(phone, "support");
      assert.match(sup.replies.join(" "), /Automatic replies are paused/);
      assert.equal(h.domain.getSession(h.campaign.id, phone).handoff_owner, "queue");
      // the worker now decides the receipt
      await h.app.intake.drain(); await h.app.worker.tick(); await h.app.worker.tick();
      const receiptId = h.db.prepare(`select id from receipts where participant_id=? order by intake_at desc limit 1`).get(h.domain.getParticipantByPhone(phone).id).id;
      const outcome = () => h.db.prepare(`select status, next_attempt_at, error_code from outbound_messages where idempotency_key like ? order by created_at desc limit 1`).get(`receipt:${receiptId}:outcome:%`);
      const row = outcome();
      assert.ok(row, "the outcome message is queued");
      assert.equal(row.status, "pending", "...but not delivered while an operator owns the conversation");
      assert.equal(row.error_code, "HANDOFF_HELD");
      assert.ok(Date.parse(row.next_attempt_at) > Date.now(), "held, not merely retried");
      const delivered = () => h.app.transport.outbox.filter((m) => /entry has been added|does not qualify/i.test(String(m.payload || ""))).length;
      assert.equal(delivered(), 0, "nothing contradicts the participant mid-dispute");
      // the operator picks it up, answers, and hands the conversation back
      const support = await h.staffToken("support@example.test");
      assert.equal((await h.api(`/api/conversations/${phone}/claim`, { method: "POST", token: support })).status, 200);
      await h.app.worker.tick();
      assert.equal(delivered(), 0, "still held while the operator holds the conversation");
      assert.equal((await h.api(`/api/conversations/${phone}/release`, { method: "POST", token: support })).status, 200);
      assert.equal(outcome().next_attempt_at, null, "release un-holds it");
      await h.app.worker.tick();
      assert.equal(outcome().status, "sent");
      assert.equal(delivered(), 1, "the held outcome is delivered once the conversation is handed back");
    } finally { await h.close(); }
  });
});

describe("crosscut — housekeeping consistency checks (round2-worker-review-check, schema-4 residue)", { timeout: 180_000 }, () => {
  it("a receipt stuck in REVIEW_REQUIRED with no open review task is reported to operators", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000997";
      await h.register(phone, { first: "Orphan", last: "Review", identity: "TESTWR1ID1" });
      const sub = await h.submit(phone, await h.simImage(h.simReceipt({ no: "550011", packs: 2 })));
      h.app.worker.housekeeping();
      assert.equal(h.db.prepare(`select count(*) n from alerts where kind='review.orphaned'`).get().n, 0, "a healthy tree raises nothing");
      // the state the fix_note names: the receipt is back in REVIEW_REQUIRED while
      // its review task is already decided, so no reviewer can see it and the
      // period's freeze barrier counts it as unresolved for ever
      h.db.prepare(`update receipts set status='REVIEW_REQUIRED' where id=?`).run(sub.receiptId);
      h.db.prepare(`insert into review_tasks (id, receipt_id, state, decision, decided_by, decided_at, sla_due_at, created_at) values ('rvw_orphan', ?, 'decided', 'QUALIFIED', 'rev_1', ?, ?, ?)`).run(sub.receiptId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      h.app.worker.housekeeping();
      const a = h.db.prepare(`select severity, message, runbook from alerts where kind='review.orphaned'`).get();
      assert.ok(a, "the inconsistency is named");
      assert.equal(a.severity, "warning");
      assert.match(a.message, /no open review task/);
    } finally { await h.close(); }
  });

  it("planner statistics are refreshed by housekeeping, not only at a boot that saw an empty database", async () => {
    const h = await buildApp({ extractor: "simulator" });
    try {
      // migrate() runs PRAGMA optimize at boot, when the database is still empty:
      // it writes no usable statistics, so the duplicate-image index stayed inert
      // until the process was restarted. The data below arrived after that boot.
      const before = h.db.prepare(`select count(*) n from sqlite_stat1`).get().n;
      h.app.worker.housekeeping();
      const after = h.db.prepare(`select count(*) n from sqlite_stat1`).get().n;
      assert.ok(after > before, `statistics must be picked up without a restart (${before} -> ${after})`);
      // ...and it is bounded to one pass a day, not one per housekeeping tick
      const again = h.db.prepare(`select count(*) n from sqlite_stat1`).get().n;
      h.app.worker.housekeeping();
      assert.equal(h.db.prepare(`select count(*) n from sqlite_stat1`).get().n, again);
    } finally { await h.close(); }
  });
});
