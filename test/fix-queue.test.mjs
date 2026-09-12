// Regression tests for the audited queue/outbox/transport defects.
// Each test was first run against the pre-fix code and observed to fail.
import { buildApp, test, describe, it, assert, before, after } from "./helpers.mjs";
import { createWorker } from "../src/worker.mjs";
import { EVENT_MAX_ATTEMPTS, JOB_MAX_ATTEMPTS } from "../src/intake.mjs";
import { CloudApiTransport } from "../src/transport/cloud-api.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const past = (ms) => new Date(Date.now() - ms).toISOString();

/** Make the transport behave like the Cloud API for the 24h-window rules. */
function needsTemplateOutsideWindow(transport, on = true) {
  Object.defineProperty(transport, "requiresTemplateOutsideWindow", { get: () => on, configurable: true });
}
function asLiveProvider(transport, on = true) {
  Object.defineProperty(transport, "isLiveProvider", { get: () => on, configurable: true });
}

describe("fix-queue: durable intake", () => {
  let h;
  before(async () => { h = await buildApp({ extractor: "simulator" }); });
  after(async () => { await h.close(); });

  it("durability-1: events/jobs abandoned mid-processing at the attempts cap are dead-lettered, alerted and recoverable", async () => {
    const phone = "263771000901";
    const ev = h.app.intake.receive({ provider: "simulator", providerMessageId: `stranded_${Date.now()}`, phoneUid: phone, type: "message.text", text: "hi" });
    // Five leases taken by a worker that was killed (OOM/redeploy) before the
    // try/catch could run: attempts is at the cap and the lease has expired.
    h.db.prepare(`update channel_events set status='processing', attempts=5, lease_until=? where id=?`).run(past(60_000), ev.id);
    assert.equal(await h.app.intake.processNext(), null, "the selector cannot see a row at the attempts cap");

    // backlog must be visible before the sweep runs
    assert.ok(h.app.intake.stats().oldestEvent, "a stuck 'processing' row is backlog the inbound alert must see");

    const job = `job_stranded_${Date.now()}`;
    h.db.prepare(`insert into jobs (id, kind, payload_json, status, attempts, lease_until, created_at) values (?,?,?,?,?,?,?)`)
      .run(job, "receipt.process", JSON.stringify({ receiptId: "rcpt_missing" }), "processing", 6, past(60_000), new Date().toISOString());
    assert.equal(await h.app.intake.processNextJob(), null, "same for jobs at their cap");

    h.db.prepare(`delete from alerts where kind in ('inbound.dead_letter','jobs.dead_letter')`).run();
    h.app.worker.housekeeping();

    const e2 = h.db.prepare(`select status, attempts, lease_until, error from channel_events where id=?`).get(ev.id);
    assert.equal(e2.status, "dead", "stranded event is terminated, not hidden for ever");
    assert.equal(e2.lease_until, null, "the stale lease is cleared");
    assert.match(e2.error || "", /abandoned mid-processing/);
    assert.ok(h.db.prepare(`select 1 from alerts where kind='inbound.dead_letter'`).get(), "operators are told");
    const j2 = h.db.prepare(`select status, lease_until from jobs where id=?`).get(job);
    assert.equal(j2.status, "dead");
    assert.equal(j2.lease_until, null);
    assert.ok(h.db.prepare(`select 1 from alerts where kind='jobs.dead_letter'`).get());

    // and the console recovery actions now work on them
    assert.equal(h.app.intake.replay(ev.id, "adm"), true, "a dead-lettered event can be replayed");
    assert.equal(h.app.intake.retryJob(job, "adm"), true, "a dead-lettered job can be retried");
    h.db.prepare(`update jobs set status='done' where id=?`).run(job); // payload points at no receipt; keep the suite queue clean
  });

  it("durability-1: an operator can recover a row still stranded in 'processing' before the sweep runs", async () => {
    const ev = h.app.intake.receive({ provider: "simulator", providerMessageId: `stuck_${Date.now()}`, phoneUid: "263771000902", type: "message.text", text: "hi" });
    h.db.prepare(`update channel_events set status='processing', attempts=5, lease_until=? where id=?`).run(past(60_000), ev.id);
    assert.equal(h.app.intake.replay(ev.id, "adm"), true, "an expired 'processing' lease is a crashed worker, never a live one");
    assert.equal(h.db.prepare(`select status from channel_events where id=?`).get(ev.id).status, "received");
    await h.app.intake.drain();
  });

  it("durability-1: work a live worker is holding right now is not counted as backlog", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      const ev = h2.app.intake.receive({ provider: "simulator", providerMessageId: `live_${Date.now()}`, phoneUid: "263771000903", type: "message.text", text: "hi" });
      const job = `job_live_${Date.now()}`;
      h2.db.prepare(`insert into jobs (id, kind, payload_json, status, attempts, lease_until, created_at) values (?,?,?,?,?,?,?)`)
        .run(job, "media.purge", "{}", "processing", 1, new Date(Date.now() + 90_000).toISOString(), new Date().toISOString());
      // leased by a worker that is still running: one OCR pass legitimately
      // holds a lease for minutes, and inbound.backlog warns at five.
      h2.db.prepare(`update channel_events set status='processing', attempts=1, lease_until=? where id=?`).run(new Date(Date.now() + 90_000).toISOString(), ev.id);
      const live = h2.app.intake.stats();
      assert.equal(live.oldestEvent, null, "a live lease is work in progress, not backlog");
      assert.equal(live.oldestJob, null, "same for jobs");

      // once the lease expires it IS a crashed worker, and that must be backlog
      h2.db.prepare(`update channel_events set lease_until=? where id=?`).run(past(1000), ev.id);
      h2.db.prepare(`update jobs set lease_until=? where id=?`).run(past(1000), job);
      const stale = h2.app.intake.stats();
      assert.ok(stale.oldestEvent, "an expired lease is a crashed worker: that is backlog");
      assert.ok(stale.oldestJob, "same for jobs");
    } finally { await h2.close(); }
  });

  it("durability-1: one attempts cap governs the selector and the sweeper, so no row falls between them", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      h2.db.prepare(`delete from jobs`).run();
      // One attempt below the cap: still the selector's business, not the
      // sweeper's — terminating it here would throw away a legitimate retry.
      const a = h2.app.intake.receive({ provider: "simulator", providerMessageId: `cap_a_${Date.now()}`, phoneUid: "263771000904", type: "message.text", text: "hi" });
      h2.db.prepare(`update channel_events set status='processing', attempts=?, lease_until=? where id=?`).run(EVENT_MAX_ATTEMPTS - 1, past(60_000), a.id);
      assert.equal(h2.app.intake.sweepStranded().events, 0, "below the cap a retry is still owed");
      assert.equal((await h2.app.intake.processNext())?.id, a.id, "below the cap the selector must re-take the abandoned lease");

      // At the cap the selector must refuse it and the sweeper must take it. A
      // row neither of them covers is invisible for ever: no decision, no reply
      // to the participant, no dead-letter alert.
      const b = h2.app.intake.receive({ provider: "simulator", providerMessageId: `cap_b_${Date.now()}`, phoneUid: "263771000905", type: "message.text", text: "hi" });
      h2.db.prepare(`update channel_events set status='processing', attempts=?, lease_until=? where id=?`).run(EVENT_MAX_ATTEMPTS, past(60_000), b.id);
      assert.equal(await h2.app.intake.processNext(), null, "at the cap the selector is done with it");
      assert.equal(h2.app.intake.sweepStranded().events, 1, "so the sweeper must terminate it");
      assert.equal(h2.db.prepare(`select status from channel_events where id=?`).get(b.id).status, "dead");

      const mk = (attempts) => { const jid = `job_cap_${attempts}_${Date.now()}`; h2.db.prepare(`insert into jobs (id, kind, payload_json, status, attempts, lease_until, created_at) values (?,?,?,?,?,?,?)`).run(jid, "media.purge", "{}", "processing", attempts, past(60_000), new Date().toISOString()); return jid; };
      const ja = mk(JOB_MAX_ATTEMPTS - 1);
      assert.equal(h2.app.intake.sweepStranded().jobs, 0, "below the cap a job retry is still owed");
      assert.equal((await h2.app.intake.processNextJob())?.id, ja, "below the cap the job selector must re-take it");
      const jb = mk(JOB_MAX_ATTEMPTS);
      assert.equal(await h2.app.intake.processNextJob(), null, "at the cap the job selector is done with it");
      assert.equal(h2.app.intake.sweepStranded().jobs, 1, "so the sweeper must terminate it");
      assert.equal(h2.db.prepare(`select status from jobs where id=?`).get(jb).status, "dead");
    } finally { await h2.close(); }
  });
});

describe("fix-queue: outbound envelope, policy and delivery status", () => {
  let h;
  before(async () => { h = await buildApp({ extractor: "simulator" }); });
  after(async () => { await h.close(); });

  it("outbox-3: internal routing metadata never reaches the provider payload", async () => {
    const phone = "263771000910";
    const tpl = { name: "winner_notice", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Tendai" }] }] };
    const q = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "template", templateName: "winner_notice", purpose: "winner_contact", payload: tpl, idempotencyKey: `fixq:tpl:${Date.now()}` });
    const stored = JSON.parse(h.app.outbox.get(q.id).payload_json);
    assert.deepEqual(Object.keys(stored).sort(), ["components", "language", "name"], "payload_json holds the message only");

    await h.app.worker.tick();
    const sent = h.app.transport.outbox.at(-1);
    assert.equal(sent.kind, "template");
    assert.deepEqual(sent.payload, tpl, "Meta's template object must carry no waPhoneUid/kind/idempotencyKey");
    assert.equal(sent.waPhoneUid, phone, "the recipient still comes from its own column");

    // the console transcript reads payload_json.body for text rows
    const t = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "reply", payload: "hello there", idempotencyKey: `fixq:txt:${Date.now()}` });
    assert.equal(JSON.parse(h.app.outbox.get(t.id).payload_json).body, "hello there");
    await h.app.worker.tick();
    assert.equal(h.app.transport.outbox.at(-1).payload, "hello there");
  });

  it("outbox-1: outside the 24h window every free-form text is held, not only winner contact", async () => {
    const phone = "263771000911";
    needsTemplateOutsideWindow(h.app.transport, true);
    try {
      // an inbound message from three days ago: the service window is closed
      const ev = h.app.intake.receive({ provider: "simulator", providerMessageId: `old_${Date.now()}`, phoneUid: phone, type: "message.text", text: "hi" });
      h.db.prepare(`update channel_events set received_at=?, status='processed' where id=?`).run(past(3 * 86400_000), ev.id);

      const ids = {};
      for (const purpose of ["receipt_outcome", "support", "winner_contact"]) {
        ids[purpose] = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose, payload: `msg for ${purpose}`, idempotencyKey: `fixq:win:${purpose}:${Date.now()}` }).id;
      }
      const reply = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "reply", payload: "answer", idempotencyKey: `fixq:win:reply:${Date.now()}` }).id;
      await h.app.worker.tick();

      for (const purpose of ["receipt_outcome", "support", "winner_contact"]) {
        const row = h.app.outbox.get(ids[purpose]);
        assert.equal(row.error_code, "TEMPLATE_REQUIRED", `${purpose} must not be sent as free-form text outside the window`);
        assert.equal(row.sent_at, null);
      }
      // a reply to the message being processed is inside the window by construction
      assert.equal(h.app.outbox.get(reply).status, "sent", "conversation replies must not be swept into the gate");
    } finally { needsTemplateOutsideWindow(h.app.transport, false); }
  });

  it("outbox-4: a message held by policy eventually terminates and the hold is alerted", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000912";
      needsTemplateOutsideWindow(h2.app.transport, true);
      const q = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "winner_contact", payload: "you won", idempotencyKey: `fixq:hold:${Date.now()}` });
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(q.id).status, "retryable_failure", "still held while the window could reopen");

      // held for 40 minutes with nothing else wrong: the alert must fire
      h2.db.prepare(`update outbound_messages set created_at=?, next_attempt_at=null where id=?`).run(past(40 * 60_000), q.id);
      h2.app.worker.housekeeping();
      assert.ok(h2.db.prepare(`select 1 from alerts where kind='outbound.blocked'`).get(), "an indefinitely held message must raise an alert");
      assert.equal(h2.db.prepare(`select count(*) n from alerts where kind='outbound.failures'`).get().n, 0, "a policy hold is not a provider outage");

      // held for longer than the window itself: it can never be delivered as
      // free-form text, so it must reach a terminal, operator-visible state
      h2.db.prepare(`update outbound_messages set created_at=?, next_attempt_at=null where id=?`).run(past(25 * 3600_000), q.id);
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(q.id).status, "permanent_failure", "a hold must not be retried for ever");

      // a campaign pause, by contrast, must stay retryable however long it lasts
      const cid = h2.campaign.id;
      h2.domain.setSetting(`campaign:${cid}:pause`, { intake: false, auto_qualify: false, outbound: true, draws: false }, "test");
      const p = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "receipt_outcome", campaignId: cid, payload: "outcome", idempotencyKey: `fixq:pause:${Date.now()}` });
      h2.db.prepare(`update outbound_messages set created_at=? where id=?`).run(past(30 * 3600_000), p.id);
      await h2.app.worker.tick();
      const paused = h2.app.outbox.get(p.id);
      assert.equal(paused.error_code, "OUTBOUND_PAUSED");
      assert.equal(paused.status, "retryable_failure", "a pause must hold messages, never burn them");
    } finally { await h2.close(); }
  });

  it("outbox-5: a non-production deployment on a live provider sends nothing until recipients are allowlisted", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000913";
      asLiveProvider(h2.app.transport, true);
      const q = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "reply", payload: "hello", idempotencyKey: `fixq:allow:${Date.now()}` });
      await h2.app.worker.tick();
      const blocked = h2.app.outbox.get(q.id);
      assert.equal(blocked.error_code, "RECIPIENT_NOT_ALLOWED", "an empty allowlist must mean 'nobody', not 'everybody'");
      assert.equal(h2.app.transport.sentCount, 0);
      // A missing allowlist is a configuration gap, not a bad message: burning
      // the queue to permanent_failure would make an operator press Retry on
      // every row by hand once the setting lands.
      assert.equal(blocked.status, "retryable_failure", "an unset allowlist must HOLD the queue, not burn it");

      // ...and the hold releases itself the moment the setting lands: no
      // operator retry, only the backoff elapsing.
      h2.domain.setSetting("outbound.allowed_recipients", [phone], "test");
      h2.db.prepare(`update outbound_messages set next_attempt_at=null where id=?`).run(q.id);
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(q.id).status, "sent", "an explicitly designated test recipient is still reachable");

      // an allowlist that exists and says no is a different answer: terminal.
      const other = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000993", kind: "text", purpose: "reply", payload: "nope", idempotencyKey: `fixq:allow2:${Date.now()}` });
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(other.id).status, "permanent_failure", "a number the allowlist excludes must not be retried for ever");
    } finally { await h2.close(); }
  });

  it("outbox-7: consent is re-checked at dispatch; a withdrawn participant gets no more campaign messages", async () => {
    const phone = "263771000914";
    await h.register(phone, { first: "With", last: "Drawn", identity: "TESTWD01X" });
    const queued = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "receipt_outcome", payload: "your receipt qualified", idempotencyKey: `fixq:consent:${Date.now()}` });
    h.domain.withdrawParticipant(phone, "adm", "participant request");
    await h.app.worker.tick();
    const row = h.app.outbox.get(queued.id);
    assert.equal(row.error_code, "CONSENT_WITHDRAWN", "a message queued before withdrawal must not be delivered afterwards");
    assert.equal(row.sent_at, null);

    // but an answer to their own support request still goes out
    const support = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "support", payload: "you have been removed", idempotencyKey: `fixq:consent:sup:${Date.now()}` });
    await h.app.worker.tick();
    assert.equal(h.app.outbox.get(support.id).status, "sent");
  });

  it("outbox-8: a late 'failed' cannot overwrite a proven read, and provider codes keep one shape", async () => {
    const phone = "263771000915";
    const q = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "winner_contact", payload: "you won", idempotencyKey: `fixq:mono:${Date.now()}` });
    await h.app.worker.tick();
    const pmid = h.app.outbox.get(q.id).provider_message_id;
    assert.ok(pmid);
    h.app.outbox.markDelivery(pmid, "delivered", { at: new Date().toISOString() });
    h.app.outbox.markDelivery(pmid, "read", { at: new Date().toISOString() });
    assert.equal(h.app.outbox.get(q.id).status, "read");

    // Meta does not order status callbacks: a 'failed' can arrive after the read
    h.app.outbox.markDelivery(pmid, "failed", { errorCode: 131047 });
    const row = h.app.outbox.get(q.id);
    assert.equal(row.status, "read", "delivery already proven; the state must not regress");
    assert.ok(row.delivered_at && row.read_at);
    assert.equal(h.app.outbox.retry(q.id), false, "an already-read message must not become retryable");
    assert.equal(row.error_code, "META_131047", "one code shape, matching the send path (not '131047.0')");

    // a failure on a row that was never delivered is still terminal
    const f = h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "reply", payload: "x", idempotencyKey: `fixq:fail:${Date.now()}` });
    await h.app.worker.tick();
    h.app.outbox.markDelivery(h.app.outbox.get(f.id).provider_message_id, "failed", { errorCode: 470 });
    const failed = h.app.outbox.get(f.id);
    assert.equal(failed.status, "permanent_failure");
    assert.equal(failed.error_code, "META_470");
  });

  it("outbox-7: a withdrawal blocks the message without raising a provider-outage alert", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771000917";
      await h2.register(phone, { first: "No", last: "More", identity: "TESTWD02X" });
      const queued = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "receipt_outcome", payload: "your receipt qualified", idempotencyKey: `fixq:consent2:${Date.now()}` });
      h2.domain.withdrawParticipant(phone, "adm", "participant request");
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(queued.id).error_code, "CONSENT_WITHDRAWN");

      h2.db.prepare(`delete from alerts`).run();
      h2.app.worker.housekeeping();
      // Support processing a withdrawal is routine privacy work. Counting the
      // permanent_failure it produces as an outbound FAILURE pointed operators
      // at provider-outage.md — check Meta's status page, rotate the token,
      // retry the rows — every time someone opted out.
      assert.equal(h2.db.prepare(`select count(*) n from alerts where kind='outbound.failures'`).get().n, 0, "a withdrawal is not a provider failure");

      // a genuine provider failure on the same ledger still pages
      const bad = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000918", kind: "text", purpose: "reply", payload: "x", idempotencyKey: `fixq:prov:${Date.now()}` });
      h2.db.prepare(`update outbound_messages set status='permanent_failure', error_code='META_131026' where id=?`).run(bad.id);
      h2.app.worker.housekeeping();
      assert.ok(h2.db.prepare(`select 1 from alerts where kind='outbound.failures'`).get(), "a real provider failure must still page");
    } finally { await h2.close(); }
  });

  it("outbox-4: a paused campaign is held without paging, but a hold nobody can clear is alerted", async () => {
    const h2 = await buildApp({ extractor: "simulator" });
    try {
      const cid = h2.campaign.id;
      h2.domain.setSetting(`campaign:${cid}:pause`, { intake: false, auto_qualify: false, outbound: true, draws: false }, "test");
      const p = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000919", kind: "text", purpose: "receipt_outcome", campaignId: cid, payload: "outcome", idempotencyKey: `fixq:pause2:${Date.now()}` });
      await h2.app.worker.tick();
      assert.equal(h2.app.outbox.get(p.id).error_code, "OUTBOUND_PAUSED");

      // A pause holds messages for exactly as long as the operator wants it to.
      // Warning about it every hour, with the provider-outage runbook attached,
      // is noise that buries the alerts that mean something.
      h2.db.prepare(`update outbound_messages set created_at=? where id=?`).run(past(40 * 60_000), p.id);
      h2.db.prepare(`delete from alerts`).run();
      h2.app.worker.housekeeping();
      assert.equal(h2.db.prepare(`select count(*) n from alerts where kind like 'outbound.%'`).get().n, 0, "a deliberate pause must not raise an alert at all");

      // a transient provider retry sitting in backoff is not a hold either
      const t = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000922", kind: "text", purpose: "reply", payload: "x", idempotencyKey: `fixq:transient:${Date.now()}` });
      h2.db.prepare(`update outbound_messages set status='retryable_failure', error_code=null, created_at=? where id=?`).run(past(40 * 60_000), t.id);
      h2.app.worker.housekeeping();
      assert.equal(h2.db.prepare(`select count(*) n from alerts where kind like 'outbound.%'`).get().n, 0, "ordinary backoff is not an indefinite hold");

      // ...but a winner nobody can send to (window closed, no template) is
      needsTemplateOutsideWindow(h2.app.transport, true);
      try {
        const w = h2.app.outbox.enqueueWhatsApp({ waPhoneUid: "263771000921", kind: "text", purpose: "winner_contact", payload: "you won", idempotencyKey: `fixq:hold2:${Date.now()}` });
        await h2.app.worker.tick();
        assert.equal(h2.app.outbox.get(w.id).error_code, "TEMPLATE_REQUIRED");
        h2.db.prepare(`update outbound_messages set created_at=? where id=?`).run(past(40 * 60_000), w.id);
        h2.app.worker.housekeeping();
        assert.ok(h2.db.prepare(`select 1 from alerts where kind='outbound.blocked'`).get(), "a winner held with nothing sent must be surfaced");
      } finally { needsTemplateOutsideWindow(h2.app.transport, false); }
    } finally { await h2.close(); }
  });

  it("outbox-8: a delivery status for an unknown provider message id is counted, not silently dropped", async () => {
    const before = h.db.prepare(`select count(*) n from metrics_events where name='inbound.delivery_status_unmatched'`).get().n;
    h.app.intake.receive({ provider: "simulator", providerMessageId: `nosuch_${Date.now()}`, type: "delivery.status", status: "delivered", phoneUid: "263771000916" });
    await h.app.intake.drain();
    assert.equal(h.db.prepare(`select count(*) n from metrics_events where name='inbound.delivery_status_unmatched'`).get().n, before + 1);
  });
});

describe("fix-queue: worker scheduling and watchdog", () => {
  let h;
  before(async () => { h = await buildApp({ extractor: "simulator" }); });
  after(async () => { await h.close(); });

  const stubs = (over = {}) => ({
    db: h.db, domain: h.domain, outbox: h.app.outbox, transport: h.app.transport, cfg: h.cfg,
    log: { error: () => {} },
    intake: { processNext: async () => null, processNextJob: async () => null, stats: () => ({}), sweepStranded: () => ({}) },
    crm: { deliverOne: async () => null, reconcile: async () => ({}), reconcileView: () => ({ provider: "none" }) },
    ...over,
  });

  it("durability-7: housekeeping runs on the wall clock, not on a tick counter", async () => {
    h.db.prepare(`delete from jobs where kind='winner.expire'`).run();
    const w = createWorker(stubs({ housekeepingMs: 0 }));
    await w.tick();
    assert.ok(h.db.prepare(`select 1 from jobs where kind='winner.expire'`).get(), "one tick after the interval elapsed must run housekeeping");
  });

  it("crm-4: unknown_outcome CRM events are reconciled by the worker and the backlog is alerted", async () => {
    let reconciled = 0;
    h.db.prepare(`delete from alerts where kind='crm.backlog'`).run();
    const w = createWorker(stubs({
      housekeepingMs: 0,
      crm: { deliverOne: async () => null, reconcile: async () => { reconciled++; return { checked: 1 }; }, reconcileView: () => ({ provider: "webhook", unknown_outcome: 2, permanent_failure: 0 }) },
    }));
    await w.tick();
    assert.equal(reconciled, 1, "the deployed process must resolve unknown_outcome itself, not only an admin button");
    assert.ok(h.db.prepare(`select 1 from alerts where kind='crm.backlog'`).get(), "a CRM backlog must be alerted");
  });

  it("crm-4: reconcile is not attempted when no CRM provider is configured", async () => {
    let reconciled = 0;
    const w = createWorker(stubs({ housekeepingMs: 0, crm: { deliverOne: async () => null, reconcile: async () => { reconciled++; }, reconcileView: () => ({ provider: "none" }) } }));
    await w.tick();
    assert.equal(reconciled, 0);
  });

  it("durability-5: a tick wedged on a never-settling await is reported and alerted", async () => {
    h.db.prepare(`delete from alerts where kind='worker.stalled'`).run();
    const w = createWorker(stubs({ stallAfterMs: 20, housekeepingMs: 10 * 60_000, intake: { processNext: () => new Promise(() => {}), processNextJob: async () => null, stats: () => ({}), sweepStranded: () => ({}) } }));
    void w.tick();            // never settles: the queue is now stopped
    await sleep(60);
    assert.equal(w.health().stalled, true, "the wedge must be visible from outside the tick");
    await w.tick();           // the interval keeps firing and finds the tick still running
    assert.ok(h.db.prepare(`select 1 from alerts where kind='worker.stalled'`).get(), "a stopped queue must raise an alert");
  });
});

describe("fix-queue: Cloud API transport", () => {
  const transport = (fetchImpl) => new CloudApiTransport({ meta: { accessToken: "PROD_TOKEN", phoneNumberId: "111", apiVersion: "v21.0" }, webhookToken: "verify-me", fetchImpl });

  it("outbox-10: the webhook handshake answers 403 for any token, including multi-byte ones", () => {
    const t = transport(async () => { throw new Error("no network"); });
    const q = (token) => new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" });
    assert.deepEqual(t.verifyHandshake(q("verify-me")), { status: 200, body: "42" });
    assert.equal(t.verifyHandshake(q("wrong")).status, 403);
    assert.equal(t.verifyHandshake(q("é")).status, 403, "a multi-byte token must not throw an unauthenticated 500");
    assert.equal(t.verifyHandshake(q("verify-me-and-more")).status, 403);
    assert.equal(t.verifyHandshake(q("verify-m")).status, 403);
  });

  it("outbox-9: a media url that is not really a Meta host is never fetched with the access token", async () => {
    const seen = [];
    const t = transport(async (url) => {
      seen.push(String(url));
      if (String(url).includes("/media_1")) return { ok: true, status: 200, json: async () => ({ url: "https://169.254.169.254/latest/meta-data/?a=.whatsapp.net/" }) };
      return { ok: true, status: 200, headers: { get: () => "10" }, arrayBuffer: async () => new ArrayBuffer(10) };
    });
    await assert.rejects(() => t.downloadMedia("media_1"), /not a Meta host/);
    assert.ok(!seen.some((u) => u.includes("169.254.169.254")), "the cloud metadata endpoint must never be requested");

    // a genuine Meta CDN host still works
    const t2 = transport(async (url) => {
      if (String(url).includes("/media_2")) return { ok: true, status: 200, json: async () => ({ url: "https://mmg.whatsapp.net/d/f/abc.enc" }) };
      return { ok: true, status: 200, headers: { get: () => "4" }, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
    });
    assert.equal((await t2.downloadMedia("media_2")).length, 4);
  });

  it("durability-5: the response body is read under the same deadline as the request", async () => {
    const t = new CloudApiTransport({ meta: { accessToken: "PROD_TOKEN", phoneNumberId: "111" }, webhookToken: "x", timeoutMs: 40, fetchImpl: async (url, init) => ({ ok: true, status: 200, json: () => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) }) });
    const settled = await Promise.race([
      t.send({ waPhoneUid: "263771000920", kind: "text", payload: "hi" }).then(() => "settled", () => "settled"),
      sleep(1000).then(() => "hung"),
    ]);
    assert.equal(settled, "settled", "a response body that never arrives must not hang the worker tick for ever");
  });
});

void test;
