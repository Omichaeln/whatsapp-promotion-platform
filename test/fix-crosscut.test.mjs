// Cross-cutting round: the residue nobody could fix because the correct change
// spanned files owned by different engineers, plus the problems a verifier
// raised against round-two fixes in those files. Every test here was confirmed
// to FAIL against the tree before the fix that accompanies it.
import { describe, it, assert, buildApp } from "./helpers.mjs";
import { createAttemptThrottle } from "../src/server.mjs";

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
