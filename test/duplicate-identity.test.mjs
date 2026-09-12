// The printed receipt number is not an identity on its own.
//
// A till counter repeats: two genuinely different purchases at one branch on
// one day can print the same number, and the TOTAL is then the only field that
// separates them. Resolving a canonical claim on outlet + date + number alone
// (the fix that stopped one slip photographed twice minting two identities)
// collapsed those two purchases into one, so the second buyer's real receipt
// was answered "already used" and earned nothing.
//
// Both halves are asserted here: the automatic path routes the disagreement to
// a person instead of deciding it, and the reviewer looking at both slips can
// credit the second one.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

describe("one till number, two purchases", () => {
  let h, reviewer;
  before(async () => { h = await buildApp({ extractor: "simulator" }); reviewer = h.app.auth.listUsers().find((u) => u.email === "reviewer@example.test"); });
  after(async () => { await h.close(); });

  it("a repeated receipt number with a different total is reviewed, not refused", async () => {
    const phone = "263771970777";
    await h.register(phone, { first: "Till", last: "Repeat", identity: "TESTTILL01" });
    const outlet = { outlet: "sunrise westgate harare" };

    const a = await h.submit(phone, await h.simImage(h.simReceipt({ no: "907001", packs: 2 })), outlet);
    assert.equal(a.receipt.status, "QUALIFIED");

    // Same branch, same day, same printed number — a different purchase: 3
    // packs at 3.10 is 9.30, not 6.20.
    const b = await h.submit(phone, await h.simImage(h.simReceipt({ no: "907001", packs: 3 })), outlet);
    assert.equal(b.receipt.status, "REVIEW_REQUIRED", "a different total at the same till is a person's call, not a refusal");
    assert.equal(b.receipt.reason_code, "possible_duplicate_same_outlet");

    // The reviewer is shown the claim it resembles.
    const kinds = h.db.prepare(`select kind from duplicate_candidates where receipt_id=?`).all(b.receiptId).map((x) => x.kind);
    assert.ok(kinds.includes("printed_identity"), `evidence recorded for the reviewer: ${kinds.join(",") || "none"}`);

    // Two identities, one credited: the second is pending a decision.
    const rows = h.db.prepare(`select status, total_minor from canonical_receipts where campaign_id=? and receipt_no_norm='907001' order by total_minor`).all(h.campaign.id);
    assert.deepEqual(rows.map((r) => [r.total_minor, r.status]), [[620, "credited"], [930, "pending"]]);

    // A reviewer with both slips in front of them can credit the second.
    const out = h.app.pipeline.review(b.receiptId, { reviewer: reviewer.id, decision: "QUALIFIED", note: "two separate purchases, the till repeated its number" });
    assert.equal(out.decision, "QUALIFIED");
    const active = h.db.prepare(`select count(*) n from entries where participant_id=(select id from participants where wa_phone_uid=?) and status='active'`).get(phone).n;
    assert.equal(active, 2, "two purchases, two entries");
  });

  it("the same slip photographed twice still resolves to one identity when only one total was read", async () => {
    // The guard above must not undo the fix it sits on top of: a MISSING total
    // is not a disagreement, so an unreadable TOTAL line still resolves to the
    // claim already held rather than minting a second one.
    const phone = "263771970778";
    await h.register(phone, { first: "Faded", last: "Total", identity: "TESTTILL02" });
    const outlet = { outlet: "sunrise westgate harare" };
    const legible = h.simReceipt({ no: "907002", packs: 2 });
    const faded = legible.replace(/TOTAL 6\.20\n/, "");

    const a = await h.submit(phone, await h.simImage(legible), outlet);
    assert.equal(a.receipt.status, "QUALIFIED");
    const b = await h.submit(phone, await h.simImage(faded), outlet);
    assert.notEqual(b.receipt.reason_code, "possible_duplicate_same_outlet", "an unread total is not a different purchase");
    const active = h.db.prepare(`select count(*) n from entries where participant_id=(select id from participants where wa_phone_uid=?) and status='active'`).get(phone).n;
    assert.equal(active, 1, "one purchase is one entry");
  });
});
