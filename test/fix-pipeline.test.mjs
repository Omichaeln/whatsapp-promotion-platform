// Regression tests for the `pipeline` audit package: receipts that re-enter
// review, reinstatement controls, awards into an already-drawn period, credit
// that is already held elsewhere, the total-independent receipt identity, a
// campaign paused while a receipt is queued, and a non-retryable extraction
// failure. Each assertion fails against the pre-fix pipeline.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

const TODAY = () => new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
/** One till slip; `total:false` is the faded TOTAL line the parser cannot read. */
const slip = (no, { total = true, packs = 2 } = {}) => {
  const amt = (packs * 3.1).toFixed(2);
  return `SUNRISE SUPERMARKET\nWestgate Branch, Harare\nTel 0242 000000\nReceipt No: ${no}  Till 03\nDate: ${TODAY()} 14:22\nGOLDCANE BROWN SUGAR 2KG\n${packs} x 3.10  ${amt}\n${total ? `TOTAL ${amt}\n` : ""}CASH 10.00\nThank you`;
};

describe("pipeline audit fixes", () => {
  let h, reviewer, approver, drawOfficer;
  const user = (email) => h.app.auth.listUsers().find((u) => u.email === email);
  const entryVersions = (entryId) => h.db.prepare(`select entity_version, payload_json from crm_events where entity_type='entry' and entity_id=? order by entity_version`).all(entryId);
  const entriesFor = (receiptId) => h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(receiptId).n;

  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    reviewer = user("reviewer@example.test"); approver = user("approver@example.test"); drawOfficer = user("draw@example.test");
  });
  after(async () => { await h.close(); });

  it("a receipt that returns to REVIEW_REQUIRED after a reprocess is back in the queue and still decidable", async () => {
    const ph = "263771000901"; await h.register(ph, { first: "Re", last: "Process", identity: "TESTRP01X" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "" })));   // no receipt number -> review
    assert.equal(r.receipt.status, "REVIEW_REQUIRED");
    const task = () => h.db.prepare(`select * from review_tasks where receipt_id=?`).get(r.receiptId);
    assert.equal(task().state, "open");

    h.app.pipeline.reprocess(r.receiptId, reviewer.id, "extractor rules corrected");
    await h.app.worker.tick();   // the queued receipt.process job re-runs and decides REVIEW again

    assert.equal(h.db.prepare(`select status from receipts where id=?`).get(r.receiptId).status, "REVIEW_REQUIRED");
    assert.equal(task().state, "open", "the task is reopened, not left 'decided' on a receipt in review");
    assert.equal(task().decision, null);
    // the same filter GET /api/reviews/queue and the console use
    assert.equal(h.db.prepare(`select count(*) n from review_tasks where receipt_id=? and state!='decided'`).get(r.receiptId).n, 1);
    const out = h.app.pipeline.review(r.receiptId, { reviewer: reviewer.id, decision: "NOT_QUALIFIED", reasonCode: "reviewer_decision" });
    assert.equal(out.decision, "NOT_QUALIFIED");
  });

  it("reinstating an entry carries the controls that removed it, and the CRM is told", async () => {
    const ph = "263771000902"; await h.register(ph, { first: "Rein", last: "State", identity: "TESTRS02X" });
    const r = await h.submit(ph, await h.simImage(slip("RS0001")));
    assert.equal(r.receipt.status, "QUALIFIED");
    const entry = h.db.prepare(`select * from entries where receipt_id=?`).get(r.receiptId);
    h.app.pipeline.disqualifyEntry(entry.id, { actorId: reviewer.id, reason: "refund found", approvedBy: approver.id });

    assert.throws(() => h.app.pipeline.reinstateEntry(entry.id, { actorId: reviewer.id }), /reason required/);
    assert.throws(() => h.app.pipeline.reinstateEntry(entry.id, { actorId: reviewer.id, reason: "cleared", approvedBy: reviewer.id }), /differ/);
    assert.throws(() => h.app.pipeline.reinstateEntry(entry.id, { actorId: reviewer.id, reason: "cleared" }), /independent approver/);
    assert.equal(h.db.prepare(`select status from entries where id=?`).get(entry.id).status, "excluded", "a refused reinstatement changes nothing");

    h.app.pipeline.reinstateEntry(entry.id, { actorId: reviewer.id, reason: "investigation cleared the participant", approvedBy: approver.id });
    assert.equal(h.db.prepare(`select status from entries where id=?`).get(entry.id).status, "active");
    const v = entryVersions(entry.id);
    assert.deepEqual(v.map((x) => x.entity_version), [1, 2, 3], "the reinstatement reaches the CRM as its own version");
    assert.match(v[2].payload_json, /"status":"active"/);
    const audited = h.db.prepare(`select payload_json from audit_events where action='entry.reinstated' and target_id=? order by id desc limit 1`).get(entry.id);
    assert.match(audited.payload_json, new RegExp(approver.id), "the approver is in the signed audit payload");

    h.app.pipeline.disqualifyEntry(entry.id, { actorId: reviewer.id, reason: "refund confirmed", approvedBy: approver.id });
    assert.deepEqual(entryVersions(entry.id).map((x) => x.entity_version), [1, 2, 3, 4], "a second disqualification is not dropped as a repeat of version 2");
  });

  it("a reviewer's QUALIFIED on a purchase already credited elsewhere is refused by name, not silently rewritten to DUPLICATE", async () => {
    const a = "263771000903", b = "263771000904";
    await h.register(a, { first: "Own", last: "Alpha", identity: "TESTOW03X" });
    await h.register(b, { first: "Own", last: "Bravo", identity: "TESTOW04X" });
    const ra = await h.submit(a, await h.simImage(slip("OWN7001")));
    assert.equal(ra.receipt.status, "QUALIFIED");
    const rb = await h.submit(b, await h.simImage(slip("OWN7001") + "\n"));   // same slip, other phone, different bytes
    assert.equal(rb.receipt.status, "DUPLICATE");
    const entryA = h.db.prepare(`select * from entries where receipt_id=?`).get(ra.receiptId);
    h.app.pipeline.disqualifyEntry(entryA.id, { actorId: reviewer.id, reason: "wrong claimant", approvedBy: approver.id });

    assert.throws(() => h.app.pipeline.review(rb.receiptId, { reviewer: reviewer.id, decision: "QUALIFIED", note: "B is the genuine shopper" }),
      (e) => e.code === "CONFLICT" && /already credited to receipt R-/.test(e.message));
    assert.equal(entriesFor(rb.receiptId), 0, "nothing was awarded behind the refusal");
  });

  it("a purchase whose total was unreadable on one photograph is credited once, not twice", async () => {
    const a = "263771000905", b = "263771000906";
    await h.register(a, { first: "Split", last: "Alpha", identity: "TESTSP05X" });
    await h.register(b, { first: "Split", last: "Bravo", identity: "TESTSP06X" });
    const ra = await h.submit(a, await h.simImage(slip("SPL0001", { total: false })));
    assert.equal(ra.receipt.status, "REVIEW_REQUIRED");
    assert.equal(ra.receipt.reason_code, "total_unclear");
    const out = h.app.pipeline.review(ra.receiptId, { reviewer: reviewer.id, decision: "QUALIFIED", note: "total legible in the image" });
    assert.equal(out.decision, "QUALIFIED"); assert.ok(out.entryId);

    // the same slip photographed again, this time with a readable total
    const rb = await h.submit(b, await h.simImage(slip("SPL0001", { total: true })));
    assert.notEqual(rb.receipt.status, "QUALIFIED", "the readable total must not mint a second identity");
    assert.equal(entriesFor(rb.receiptId), 0);
    assert.equal(h.db.prepare(`select count(*) n from canonical_receipts where campaign_id=? and receipt_no=?`).get(h.campaign.id, "SPL0001").n, 1, "one purchase, one canonical receipt");
    assert.equal(h.db.prepare(`select count(*) n from entries where status='active' and canonical_receipt_id in (select id from canonical_receipts where receipt_no=?)`).get("SPL0001").n, 1);
  });

  it("pausing the campaign while a receipt is queued does not retro-reject it as 'the promotion was not open'", async () => {
    const ph = "263771000907"; await h.register(ph, { first: "Paws", last: "Timing", identity: "TESTPA07X" });
    await h.selectOutlet(ph);
    const ev = await h.say(ph, "", { image: await h.simImage(slip("PAUSE001")), drain: false });
    // handle the inbound message ONLY (intake.drain would also run the job):
    // the receipt row carries an in-window intake_at and its receipt.process
    // job is still pending, which is the state a pause lands on.
    for (let i = 0; i < 10 && await h.app.intake.processNext(); i++) { /* events only */ }
    assert.ok(h.db.prepare(`select count(*) n from jobs where kind='receipt.process' and status='pending'`).get().n >= 1);
    const rid = JSON.parse(h.db.prepare(`select result_json from channel_events where id=?`).get(ev.id).result_json).receiptId;
    h.domain.setCampaignStatus(h.campaign.id, "paused", "adm_test", "supplier issue");
    try { await h.app.worker.tick(); } finally { h.domain.setCampaignStatus(h.campaign.id, "active", "adm_test", "resumed"); }
    const rec = h.db.prepare(`select * from receipts where id=?`).get(rid);
    assert.notEqual(rec.reason_code, "campaign_not_open", "eligibility is judged as at intake, not at processing time");
    assert.equal(rec.status, "QUALIFIED");
  });

  it("a non-retryable extraction failure alerts the operator immediately instead of re-queueing OCR for an hour", async () => {
    const ph = "263771000908"; await h.register(ph, { first: "Perm", last: "Fail", identity: "TESTPF08X" });
    assert.equal(h.db.prepare(`select count(*) n from alerts where kind='receipt.stuck'`).get().n, 0);
    const real = h.app.extractor.extract.bind(h.app.extractor);
    h.app.extractor.extract = async () => { throw Object.assign(new Error("provider rejected the API key"), { code: "EXTRACTOR_UNAVAILABLE", transient: false }); };
    let rid = null;
    try {
      const r = await h.submit(ph, await h.simImage(slip("PERM001")));
      rid = r.receiptId;
      assert.equal(r.receipt.status, "delayed", "the participant's receipt is never rejected for a platform fault");
    } finally { h.app.extractor.extract = real; }
    assert.equal(h.db.prepare(`select count(*) n from jobs where kind='receipt.process' and payload_json=?`).get(JSON.stringify({ receiptId: rid })).n, 1, "no retry queued for a failure that cannot succeed");
    assert.equal(h.db.prepare(`select count(*) n from alerts where kind='receipt.stuck'`).get().n, 1, "operator alerted at once");
  });

  it("no entry is awarded into a period whose draw is already frozen", async () => {
    const ph = "263771000909"; await h.register(ph, { first: "Late", last: "Award", identity: "TESTLA09X" });
    const rev = await h.submit(ph, await h.simImage(h.simReceipt({ no: "" })));
    assert.equal(rev.receipt.status, "REVIEW_REQUIRED");
    const period = h.domain.listPeriods(h.campaign.id).find((p) => p.code === rev.receipt.period_code);
    const draw = h.app.drawService.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: drawOfficer.id, override: { allow: ["PERIOD_OPEN", "UNRESOLVED_SUBMISSIONS", "NO_CANDIDATES", "INSUFFICIENT_CANDIDATES"], reason: "draw day" } });
    assert.equal(draw.status, "frozen");

    assert.throws(() => h.app.pipeline.review(rev.receiptId, { reviewer: reviewer.id, decision: "QUALIFIED" }),
      (e) => e.code === "CONFLICT" && /already been drawn/.test(e.message));
    assert.equal(entriesFor(rev.receiptId), 0);
    assert.equal(h.db.prepare(`select state from review_tasks where receipt_id=?`).get(rev.receiptId).state, "open", "the receipt is still decidable");

    // the automatic path sends the would-be award to a human instead of orphaning it
    const late = await h.submit(ph, await h.simImage(slip("LATE001")));
    assert.equal(late.receipt.status, "REVIEW_REQUIRED");
    assert.equal(late.receipt.reason_code, "period_already_drawn");
    assert.equal(entriesFor(late.receiptId), 0);
    assert.doesNotMatch(late.outcomes.join(" "), /ONE entry has been added/, "the participant is never promised an entry that can enter no draw");
  });
});
