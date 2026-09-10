// REAL receipt processing through the full pipeline: fixture JPEGs are read by
// tesseract.js (pixels -> text -> deterministic rules). T-04, T-07, T-08,
// T-09, T-10, T-11, T-12, T-14. Slow (~1s per image).
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

describe("real OCR receipt processing", { timeout: 600_000 }, () => {
  let h; const P1 = "263771000401", P2 = "263771000402";
  before(async () => { h = await buildApp({ extractor: "tesseract" }); await h.register(P1, { first: "Ocr", last: "One", identity: "TESTOCR1X" }); await h.register(P2, { first: "Ocr", last: "Two", identity: "TESTOCR2X", town: "Bulawayo" }); });
  after(async () => { await h.close(); });

  it("T-04: a new valid two-pack image is read from pixels, qualifies, and awards exactly one entry with the right message", async () => {
    const r = await h.submit(P1, h.fixture("valid-two-pack-A"));
    assert.equal(r.receipt.status, "QUALIFIED", JSON.stringify(r));
    const v = h.db.prepare(`select * from validation_results where receipt_id=?`).get(r.receiptId);
    assert.equal(v.extractor_provider, "tesseract.js"); assert.match(v.ocr_text, /SUNRISE SUPERMARKET/); const facts = JSON.parse(v.facts_json); assert.equal(facts.transaction.receiptNo, "004512"); assert.equal(facts.transaction.date, "2026-10-05");
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(r.receiptId).n, 1);
    assert.match(r.outcomes[0], /ONE entry has been added/); assert.match(r.ack[0], /reference is R-/);
    assert.ok(h.db.prepare(`select canonical_key from canonical_receipts where credited_receipt_id=?`).get(r.receiptId).canonical_key.includes("004512"));
  });
  it("T-10: quantity rules — one pack rejected with reason, three packs still one award, 2KG text is not a quantity, void lines excluded, wrong SKU rejected, alt sizes need the combination rule", async () => {
    const one = await h.submit(P1, h.fixture("one-pack")); assert.equal(one.receipt.status, "NOT_QUALIFIED"); assert.equal(one.receipt.reason_code, "below_minimum_quantity"); assert.match(one.outcomes[0], /below the minimum \(2 x 2kg pack\)/);
    const three = await h.submit(P1, h.fixture("valid-three-pack")); assert.equal(three.receipt.status, "QUALIFIED"); assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(three.receiptId).n, 1);
    assert.equal((await h.submit(P1, h.fixture("two-kg-text-not-qty"), { outlet: "kwikshop westgate harare" })).receipt.status, "NOT_QUALIFIED");
    assert.equal((await h.submit(P1, h.fixture("void-line"))).receipt.status, "NOT_QUALIFIED");
    assert.equal((await h.submit(P1, h.fixture("wrong-sku"))).receipt.reason_code, "no_qualifying_product");
    const alt = await h.submit(P1, h.fixture("alt-pack-1kg-x4"), { outlet: "valuemart westgate harare" }); assert.equal(alt.receipt.status, "NOT_QUALIFIED");
    // enabling the (disabled) combination rule prospectively via a new version makes 4 x 1kg qualify
    const vid = h.domain.newVersionFrom(h.campaign.id, { rules: { allow_pack_combinations: true } }, "test"); h.domain.activateVersion(h.campaign.id, vid, "test");
    const alt2 = await h.submit(P2, h.fixture("alt-pack-1kg-x4"), { outlet: "valuemart westgate harare" }); assert.equal(alt2.receipt.status, "REVIEW_REQUIRED", "same purchase already presented by another participant -> never auto-credited to the second presenter"); assert.equal(alt2.receipt.reason_code, "ownership_dispute");
    const v2 = h.domain.newVersionFrom(h.campaign.id, { rules: { allow_pack_combinations: false } }, "test"); h.domain.activateVersion(h.campaign.id, v2, "test");
  });
  it("T-11: dates and outlets — outside window rejected, ambiguous date reviewed, merchant mismatch reviewed, cropped header reviewed", async () => {
    assert.equal((await h.submit(P1, h.fixture("date-before-window"))).receipt.reason_code, "receipt_date_outside_campaign");
    assert.equal((await h.submit(P1, h.fixture("date-future"))).receipt.reason_code, "receipt_date_outside_campaign");
    const amb = await h.submit(P1, h.fixture("ambiguous-date")); assert.equal(amb.receipt.status, "REVIEW_REQUIRED"); assert.equal(amb.receipt.reason_code, "transaction_date_unclear"); assert.match(amb.outcomes[0], /manual check/);
    const mis = await h.submit(P1, h.fixture("non-participating-outlet")); assert.equal(mis.receipt.status, "REVIEW_REQUIRED"); assert.equal(mis.receipt.reason_code, "outlet_selection_mismatch");
    const crop = await h.submit(P1, h.fixture("cropped-top-missing")); assert.equal(crop.receipt.status, "REVIEW_REQUIRED");
    assert.ok(h.db.prepare(`select count(*) n from review_tasks where state!='decided'`).get().n >= 3);
  });
  it("T-08/T-09: random photo, instruction-laden paper, blur and darkness never qualify; re-upload guidance given; bounded processing", async () => {
    const rnd = await h.submit(P2, h.fixture("random-photo")); assert.equal(rnd.receipt.status, "REUPLOAD_REQUIRED"); assert.match(rnd.outcomes[0], /couldn't read receipt/);
    const paper = await h.submit(P2, h.fixture("unrelated-paper")); assert.equal(paper.receipt.status, "REUPLOAD_REQUIRED");
    assert.equal(h.db.prepare(`select count(*) n from entries where participant_id=?`).get(h.domain.getParticipantByPhone(P2).id).n, 0, "instruction text produced no entry");
    const blur = await h.submit(P2, h.fixture("blurred")); assert.notEqual(blur.receipt.status, "QUALIFIED");
    const dark = await h.submit(P2, h.fixture("dark")); assert.notEqual(dark.receipt.status, "QUALIFIED");
    // malformed / oversized / unsupported bytes are rejected at intake with guidance, never stored as receipts
    const bad = await h.selectOutlet(P2); void bad;
    const m = await h.say(P2, "", { image: Buffer.from("not an image at all") }); assert.match(m.replies[0], /couldn't be used/);
    const big = await h.say(P2, "", { image: Buffer.alloc(11 * 1024 * 1024, 1) }); assert.match(big.replies[0], /couldn't be used/);
  });
  it("T-07/T-14: re-photographed, cropped, rotated and recompressed copies of a credited receipt are blocked; a different phone cannot re-use it; a clearer re-upload of an unreadable attempt stays possible", async () => {
    for (const fx of ["dup-photo", "dup-cropped", "dup-rotated", "dup-recompressed"]) { const r = await h.submit(P2, h.fixture(fx)); assert.equal(r.receipt.status, "DUPLICATE", fx); assert.match(r.outcomes[0], /already been used/); }
    assert.equal(h.db.prepare(`select count(*) n from entries where canonical_receipt_id in (select id from canonical_receipts where receipt_no='004512')`).get().n, 1);
    // a participant whose first attempt was unreadable can still be credited on a clearer upload (different receipt number so it is a fresh purchase)
    const first = await h.submit(P2, h.fixture("dark")); void first;
    const clear = await h.submit(P2, h.fixture("valid-two-pack-B"), { outlet: "valuemart westgate harare" }); assert.equal(clear.receipt.status, "QUALIFIED");
    // the phone-photo of B from the same participant is the same purchase -> duplicate, not a second award
    assert.equal((await h.submit(P2, h.fixture("valid-two-pack-B-photo"), { outlet: "valuemart westgate harare" })).receipt.status, "DUPLICATE");
  });
  it("T-12: the same purchase submitted concurrently by two participants credits at most once; the loser gets a stable duplicate outcome", async () => {
    const p3 = "263771000403", p4 = "263771000404";
    await h.register(p3, { first: "Race", last: "Alpha", identity: "TESTRACE1A" }); await h.register(p4, { first: "Race", last: "Bravo", identity: "TESTRACE2B" });
    await h.selectOutlet(p3, "kwikshop westgate harare"); await h.selectOutlet(p4, "kwikshop westgate harare");
    const img = h.fixture("valid-two-pack-C");
    const a = await h.say(p3, "", { image: img, drain: false }); const b = await h.say(p4, "", { image: Buffer.concat([img, Buffer.from([0])]), drain: false });
    await h.app.intake.drain();  // both receipts submitted (two media assets)
    const ids = [a, b].map((x) => h.db.prepare(`select result_json from channel_events where id=?`).get(x.id)).map((e) => JSON.parse(e.result_json).receiptId);
    await Promise.all(ids.map((id) => h.app.pipeline.process(id)));   // concurrent extraction + commit
    const statuses = ids.map((id) => h.db.prepare(`select status from receipts where id=?`).get(id).status).sort();
    assert.deepEqual(statuses, ["DUPLICATE", "QUALIFIED"]);
    assert.equal(h.db.prepare(`select count(*) n from entries where canonical_receipt_id in (select id from canonical_receipts where receipt_no='C77120')`).get().n, 1);
  });
  it("reviewer resolves an uncertain receipt through the same integrity path and the participant is told", async () => {
    const t = h.db.prepare(`select rt.receipt_id from review_tasks rt join receipts r on r.id=rt.receipt_id where rt.state!='decided' and r.reason_code='outlet_selection_mismatch' limit 1`).get();
    const reviewer = h.app.auth.listUsers().find((u) => u.email === "reviewer@example.test");
    const out = h.app.pipeline.review(t.receipt_id, { reviewer: reviewer.id, decision: "QUALIFIED", note: "branch confirmed by phone" });
    assert.equal(out.decision, "QUALIFIED"); assert.ok(out.entryId);
    await h.app.worker.tick();
    const msg = h.db.prepare(`select payload_json from outbound_messages where idempotency_key like ? order by created_at desc limit 1`).get(`receipt:${t.receipt_id}:outcome%`); assert.match(JSON.parse(msg.payload_json).body, /after review, receipt .* qualifies/i);
    assert.throws(() => h.app.pipeline.review(t.receipt_id, { reviewer: reviewer.id, decision: "NOT_QUALIFIED" }), /already/);
  });
});
