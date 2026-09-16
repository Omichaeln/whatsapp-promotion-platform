// Regression tests for the adjudicated "rules" defects: the deterministic
// parser (src/extract/parse-receipt.mjs) and the eligibility engine
// (src/eligibility.mjs). Every test here failed against the code before the
// fix. The end-to-end cases go through the real pipeline with the SIMULATED
// extractor (it runs the same parser on embedded text, without OCR latency).
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { defaultRules, evaluateEligibility, matchProduct, DISPOSITION, REASONS } from "../src/eligibility.mjs";
import { parseTotal, parseReceiptNo, parseLineItems, matchOutlets, parseReceiptText } from "../src/extract/parse-receipt.mjs";

const PRODUCTS = [
  { code: "GC-BS-2KG", name: "Goldcane Brown Sugar 2kg", aliases: ["goldcane brown sugar", "brown sugar 2kg", "gc brown sugar"], pack_grams: 2000, qualifying: true },
  { code: "GC-BS-1KG", name: "Goldcane Brown Sugar 1kg", aliases: ["brown sugar 1kg"], pack_grams: 1000, qualifying: true },
];
const RULES = { products: PRODUCTS, primary_rule: { min_packs: 2, pack_grams: 2000, min_total_grams: 4000 }, allow_pack_combinations: false, date_order: "DMY" };
const WINDOW = { start: "2026-09-01T00:00:00.000Z", end: "2026-12-31T00:00:00.000Z" };
const OUTLETS = [
  { id: "out_sun", retailer: "Sunrise Supermarket", branch: "Westgate", town: "Harare", aliases_json: JSON.stringify(["Sunrise Westgate"]) },
  { id: "out_cnr", retailer: "Corner Choice", branch: "Hillside", town: "Harare", aliases_json: "[]" },
];
const ctx = (over = {}) => ({ selectedOutletId: "out_sun", windowStart: WINDOW.start, windowEnd: WINDOW.end, campaignOpen: true, enrolled: true, ...over });
/** A receipt in the sample till layout; body/footer are supplied per case. */
function receiptText({ no = "004512", date = "05/10/2026", merchant = "SUNRISE SUPERMARKET\nWestgate Branch, Harare", body, footer = "TOTAL                    6.20\nCASH                    10.00\nCHANGE                   3.80" }) {
  return `${merchant}\nTel 0242 000000\nReceipt No: ${no}  Till 03\nDate: ${date} 14:22\n--------------------------------\n${body}\n${footer}\nThank you`;
}
const SUGAR_2KG_X2 = "GOLDCANE BROWN SUGAR 2KG\n  2 x 3.10               6.20";
const evaluate = (text, over = {}) => evaluateEligibility(parseReceiptText(text, { outlets: OUTLETS, dateOrder: "DMY" }), RULES, ctx(over));

describe("rules package — deterministic parser and eligibility engine", () => {
  it("rules-8: a partial nested rule override keeps its sibling thresholds instead of wiping them", () => {
    // { primary_rule: { min_packs: 3 } } used to REPLACE the object, leaving
    // pack_grams/min_total_grams undefined -> every clean receipt rejected.
    assert.deepEqual(defaultRules({ primary_rule: { min_packs: 3 } }).primary_rule, { min_packs: 3, pack_grams: 2000, min_total_grams: 4000 });
    assert.deepEqual(defaultRules({ outlet_match: { required: true } }).outlet_match, { required: true, min_score: 0.5 });
    assert.deepEqual(defaultRules({ review_thresholds: { min_ocr_confidence: 0.5 } }).review_thresholds, { min_document_score: 0.5, min_ocr_confidence: 0.5 });
    assert.deepEqual(defaultRules({ award: {} }).award, { entries_per_receipt: 1 });
    // explicit values still win, and unrelated keys are untouched
    assert.deepEqual(defaultRules({ primary_rule: { min_packs: 2, pack_grams: 1000, min_total_grams: 2000 } }).primary_rule, { min_packs: 2, pack_grams: 1000, min_total_grams: 2000 });
    assert.equal(defaultRules({ outlet_match: { required: false } }).outlet_match.required, false);
    // a campaign whose only edit was min_packs still credits a clean 2 x 2kg
    const partial = { products: PRODUCTS, primary_rule: { min_packs: 2 } };
    const v = evaluateEligibility(parseReceiptText(receiptText({ body: SUGAR_2KG_X2 }), { outlets: OUTLETS }), partial, ctx());
    assert.equal(v.disposition, DISPOSITION.QUALIFIED, JSON.stringify(v.rules.filter((r) => r.outcome !== "pass")));
  });

  it("rules-5: a tax component is never the total, and a grouped total is read whole", () => {
    // Two regressions from widening parseTotal's label handling, both of which
    // record a WRONG total — and the total is part of the canonical identity
    // (outlet|date|number|total), so a wrong one also splits one purchase into
    // two claims.
    // (a) The denylist of qualifying words had no entry for a bare tax line, so
    // "TOTAL VAT 0.81" was read as the purchase total. "TOTAL INCL VAT" says the
    // opposite — the amount already contains the tax — and must still be read.
    assert.equal(parseTotal("TOTAL VAT 0.81").totalMinor, null);
    assert.equal(parseTotal("TOTAL TAX 0.81").totalMinor, null);
    assert.equal(parseTotal("SUBTOTAL 5.39\nTOTAL VAT 0.81\nTOTAL 6.20").totalMinor, 620);
    for (const line of ["TOTAL INCL VAT 6.20", "TOTAL (INCL VAT) 6.20", "TOTAL INC VAT 6.20"]) {
      assert.equal(parseTotal(line).totalMinor, 620, line);
    }
    // (b) The amount pattern had no left boundary, so a thousands-grouped total
    // was read from the middle of its own number: 1,480.00 became 480.00, which
    // a receipt could then be credited on.
    assert.equal(parseTotal("TOTAL 1,234.56").totalMinor, 123456);
    assert.equal(parseTotal("TOTAL          1,480.00").totalMinor, 148000);
    assert.equal(parseTotal("TOTAL 1 480.00").totalMinor, 148000);
    // The widening these two guard was itself a fix: unlisted currencies and
    // "AMOUNT" variants must still parse, and a decimal comma still means 6.20.
    for (const line of ["TOTAL AMOUNT DUE 6.20", "TOTAL AMOUNT 6.20", "TOTAL RTGS 6.20", "TOTAL ZAR 6.20", "TOTAL 6,20"]) {
      assert.equal(parseTotal(line).totalMinor, 620, line);
    }
  });

  it("rules-5: the total is the receipt's own total, not a trailing tender/VAT/discount line", () => {
    assert.equal(parseTotal("TOTAL 6.20\nTOTAL TENDERED 10.00\nCHANGE 3.80").totalMinor, 620);
    assert.equal(parseTotal("TOTAL 6.20\nCASH 10.00\nCHANGE 3.80\nVAT TOTAL 0.81").totalMinor, 620);
    assert.equal(parseTotal("TOTAL 6.20\nTOTAL DISCOUNT 1.00").totalMinor, 620);
    assert.equal(parseTotal("TOTAL 6.20\nCASH TOTAL 10.00").totalMinor, 620);
    assert.equal(parseTotal("SUB TOTAL 5.00\nTOTAL SAVINGS 1.00\nGRAND TOTAL 6.20\nCARD 6.20").totalMinor, 620);
    assert.equal(parseTotal("TOTAL CASH 10.00").totalMinor, null);
    assert.equal(parseTotal("TOTAL EXCL VAT 5.39\nTOTAL 6.20").totalMinor, 620);
    // labelled variants that ARE the total must still be read. Rejecting every
    // word between the label and the amount (a currency allowlist) turned these
    // common till layouts into total_unclear and sent the whole of such a
    // till's volume to the review queue.
    assert.equal(parseTotal("TOTAL DUE 6.20").totalMinor, 620);
    assert.equal(parseTotal("AMOUNT DUE USD 6.20").totalMinor, 620);
    assert.equal(parseTotal("TOTAL AMOUNT DUE          6.20").totalMinor, 620);
    assert.equal(parseTotal("TOTAL AMOUNT              6.20").totalMinor, 620);
    assert.equal(parseTotal("TOTAL INCL VAT            6.20").totalMinor, 620);
    assert.equal(parseTotal("TOTAL (INCL VAT)          6.20").totalMinor, 620);
    for (const cur of ["TOTAL RTGS 6.20", "TOTAL ZAR 6.20", "TOTAL Z$6.20"]) assert.equal(parseTotal(cur).totalMinor, 620, cur);
    assert.equal(parseTotal("Total                    7.40\nTender                   7.40").totalMinor, 740);
    assert.equal(parseTotal("no total here").totalMinor, null);
    // ...and end to end: such a receipt is decided, not queued for a human
    const dueTotal = evaluate(receiptText({ no: "004521", body: SUGAR_2KG_X2, footer: "TOTAL AMOUNT DUE         6.20\nCASH                    10.00\nCHANGE                   3.80" }));
    assert.equal(dueTotal.disposition, DISPOSITION.QUALIFIED, JSON.stringify(dueTotal.rules.filter((r) => r.outcome !== "pass")));
  });

  it("rules-3: the receipt number is the best-labelled number on the page, never a phone number or a date", () => {
    // one bad candidate used to abandon the whole pattern: the store phone
    // number became the identity of every receipt from that store
    assert.equal(parseReceiptNo("TAX INVOICE\n0242-123456\nSUNRISE SUPERMARKET\nWestgate Branch, Harare\nReceipt No: 004512").receiptNo, "004512");
    assert.equal(parseReceiptNo("REF: 12/10/2026").receiptNo, null, "a printed date is not an identifier");
    assert.equal(parseReceiptNo("GOODS RECEIVED WITH THANKS\nRECEIPT 004512").receiptNo, "004512", "'rec' must not match inside RECEIVED");
    assert.equal(parseReceiptNo("Receipt # 004512").receiptNo, "004512");
    // layouts that already worked keep working
    assert.equal(parseReceiptNo("Receipt No: 004512  Till 03").receiptNo, "004512");
    assert.equal(parseReceiptNo("INV 88213   POS 7\nKeep this slip for the promotion").receiptNo, "88213");
    assert.equal(parseReceiptNo("Slip # C-77120").receiptNo, "C77120");
    assert.equal(parseReceiptNo("SUNRISE SUPERMARKET\nTel 0242 000000").receiptNo, null);
    // a bare keyword with its "number" on the NEXT line is not evidence at all:
    // adopting it because it was the only candidate still gave every receipt
    // from that store one shared identity, so the second honest customer was
    // told DUPLICATE. No credible number -> missing_receipt_number -> review.
    assert.equal(parseReceiptNo("TAX INVOICE\n0242-123456\nSUNRISE SUPERMARKET").receiptNo, null);
  });

  it("rules-4: a cancellation that names no product cancels the line it follows, and returns boilerplate cancels nothing", () => {
    const voided = (v) => parseLineItems(receiptText({ body: `${SUGAR_2KG_X2}\n${v}`, footer: "TOTAL                    0.00" })).map((i) => i.voided);
    assert.deepEqual(voided("*** VOID ***"), [true]);
    assert.deepEqual(voided("VOID ITEM"), [true]);
    assert.deepEqual(voided("VOIDED BY SUPERVISOR"), [true]);
    assert.deepEqual(voided("VOID GOLDCANE BROWN SUGAR 2KG          -6.20"), [true], "the described shape still works");
    // cancellation printed as a negative amount cancels the matching line only
    const neg = parseLineItems(receiptText({ body: "GOLDCANE BROWN SUGAR 2KG              3.10\nGOLDCANE BROWN SUGAR 2KG              3.10\nVOID                                 -3.10", footer: "TOTAL                    3.10" }));
    assert.deepEqual(neg.map((i) => i.voided), [false, true]);
    // footer boilerplate must never void a real line
    for (const footerNote of ["NO RETURN WITHOUT THIS SLIP", "Goods returned within 7 days"]) {
      const items = parseLineItems(receiptText({ body: SUGAR_2KG_X2, footer: `TOTAL                    6.20\nCASH                    10.00\n${footerNote}` }));
      assert.deepEqual(items.map((i) => i.voided), [false], footerNote);
    }
    assert.equal(evaluate(receiptText({ body: `${SUGAR_2KG_X2}\n*** VOID ***`, footer: "TOTAL                    0.00" })).disposition, DISPOSITION.NOT_QUALIFIED);
    // a WHOLE-TRANSACTION cancellation voids the whole basket. Cancelling only
    // the nearest line left the rest of an abandoned purchase counted, so three
    // packs minus one still reached the two-pack minimum and earned an entry.
    const pack = "GOLDCANE BROWN SUGAR 2KG              3.10";
    for (const word of ["TRANSACTION CANCELLED", "SALE VOIDED", "TXN VOID"]) {
      const items = parseLineItems(receiptText({ body: `${pack}\n${pack}\n${pack}\n${word}`, footer: "TOTAL                    0.00" }));
      assert.deepEqual(items.map((i) => i.voided), [true, true, true], word);
    }
    const cancelled = evaluate(receiptText({ no: "004545", body: `${pack}\n${pack}\n${pack}\nTRANSACTION CANCELLED`, footer: "TOTAL                    0.00" }));
    assert.equal(cancelled.disposition, DISPOSITION.NOT_QUALIFIED, JSON.stringify(cancelled.rules.filter((r) => r.outcome !== "pass")));
    assert.equal(cancelled.primaryPacks, 0);
  });

  it("rules-6: the most specific catalogue key wins and an unstated pack size is never assumed to be the qualifying one", () => {
    assert.equal(matchProduct({ description: "GOLDCANE BROWN SUGAR 1KG" }, PRODUCTS).code, "GC-BS-1KG");
    assert.equal(matchProduct({ description: "GOLDCANE BROWN SUGAR 2KG" }, PRODUCTS).code, "GC-BS-2KG");
    assert.equal(matchProduct({ description: "GOLDCANE BROWN SUGAR" }, PRODUCTS).packAmbiguous, true, "the alias is shared across pack sizes");
    // the shipped catalogue's OTHER generic alias states no pack size and is a
    // substring of no other key, so a containment test between catalogue keys
    // never saw it and the 2kg pack size was borrowed for it anyway
    assert.equal(matchProduct({ description: "GC BROWN SUGAR" }, PRODUCTS).basis, "gc brown sugar");
    assert.equal(matchProduct({ description: "GC BROWN SUGAR" }, PRODUCTS).packAmbiguous, true, "a key that names no pack size cannot settle one");
    assert.equal(matchProduct({ description: "GOLDCANE BROWN SUGAR" }, [PRODUCTS[0]]).packAmbiguous, false, "one configured pack size stays decidable");
    // truncated description + the 1kg unit price: the catalogue pack size must
    // not be borrowed to make four 1kg packs look like the qualifying 2kg pack
    const v = evaluate(receiptText({ no: "004599", body: "GOLDCANE BROWN SUGAR\n  4 x 1.60               6.40", footer: "TOTAL                    6.40" }));
    assert.equal(v.disposition, DISPOSITION.REVIEW);
    assert.equal(v.reason, REASONS.QTY_UNKNOWN);
    assert.equal(v.primaryPacks, 0);
    // the same through the generic alias: four 1kg packs must never be credited
    // as the qualifying 2kg pack because the catalogue lists one for that alias
    const alias = evaluate(receiptText({ no: "004597", body: "GC BROWN SUGAR\n  4 x 1.60               6.40", footer: "TOTAL                    6.40" }));
    assert.equal(alias.disposition, DISPOSITION.REVIEW, JSON.stringify(alias.matched));
    assert.equal(alias.reason, REASONS.QTY_UNKNOWN);
    assert.equal(alias.primaryPacks, 0);
    assert.equal(alias.totalGrams, 0);
    // a stated pack size still decides by itself
    assert.equal(evaluate(receiptText({ no: "004598", body: SUGAR_2KG_X2 })).disposition, DISPOSITION.QUALIFIED);
  });

  it("rules-1: a location-only merchant match is a candidate for a reviewer, never automatic acceptance", () => {
    const header = "SUNRISE SUPERMARKET Westgate Branch, Harare Tel 0242 000000";
    const cands = matchOutlets(header, OUTLETS);
    assert.equal(cands.find((c) => c.outletId === "out_sun").score, 1);
    const other = cands.find((c) => c.outletId === "out_cnr");
    assert.ok(other && other.score <= 0.4, `a different retailer sharing only the town must stay below the 0.5 acceptance threshold: ${JSON.stringify(other)}`);
    const v = evaluate(receiptText({ body: SUGAR_2KG_X2 }), { selectedOutletId: "out_cnr" });
    assert.equal(v.disposition, DISPOSITION.REVIEW);
    assert.equal(v.reason, REASONS.OUTLET_MISMATCH);
  });

  it("rules-2: an unreadable item section goes to a reviewer; a readable one that matches nothing is still rejected", () => {
    for (const body of ["2 X GOLDCANE BROWN SUGAR 2KG   12.40", "2   GOLDCANE BROWN SUGAR 2KG   12.40"]) {
      const x = parseReceiptText(receiptText({ body, footer: "TOTAL                   12.40" }), { outlets: OUTLETS });
      assert.equal(x.lineItems.length, 0, body);
      assert.ok(x.quality.missing.includes("line_items"));
      const v = evaluateEligibility(x, RULES, ctx());
      assert.equal(v.disposition, DISPOSITION.REVIEW, body);
      assert.notEqual(v.reason, REASONS.NO_PRODUCT);
    }
    // the wrong-SKU case is a decided outcome, not a review: items parsed, none matched
    const wrong = evaluate(receiptText({ no: "004514", body: "GOLDCANE WHITE SUGAR 2KG\n  2 x 2.90               5.80", footer: "TOTAL                    5.80" }));
    assert.equal(wrong.disposition, DISPOSITION.NOT_QUALIFIED);
    assert.equal(wrong.reason, REASONS.NO_PRODUCT);
  });

  it("rules-7: the purchase window is compared as whole days in the zone the window was written in", () => {
    const on = (date) => evaluate(receiptText({ body: SUGAR_2KG_X2, date }), { windowStart: "2026-10-01T00:00:00+02:00", windowEnd: "2026-11-01T00:00:00+02:00" }).disposition;
    assert.equal(on("30/09/2026"), DISPOSITION.NOT_QUALIFIED, "the day before a local-time opening is outside the promotion");
    assert.equal(on("01/10/2026"), DISPOSITION.QUALIFIED);
    assert.equal(on("31/10/2026"), DISPOSITION.QUALIFIED, "the final local day is inside");
    assert.equal(on("01/11/2026"), DISPOSITION.NOT_QUALIFIED);
    // windows expressed as UTC instants keep their existing day boundaries
    const utc = (date) => evaluate(receiptText({ body: SUGAR_2KG_X2, date }), { windowStart: "2026-10-01T14:00:00Z", windowEnd: "2026-10-31T23:59:59Z" }).disposition;
    assert.equal(utc("01/10/2026"), DISPOSITION.QUALIFIED, "a start later in the day still admits that day");
    assert.equal(utc("30/09/2026"), DISPOSITION.NOT_QUALIFIED);
    assert.equal(utc("31/10/2026"), DISPOSITION.QUALIFIED);
  });
});

describe("rules package — through the whole pipeline", { timeout: 120_000 }, () => {
  let h; const P1 = "263771990101", P2 = "263771990102";
  before(async () => { h = await buildApp({ extractor: "simulator" }); await h.register(P1, { first: "Rules", last: "One", identity: "TESTRULE1X" }); await h.register(P2, { first: "Rules", last: "Two", identity: "TESTRULE2X" }); });
  after(async () => { await h.close(); });
  const send = async (phone, text, opts = {}) => h.submit(phone, await h.simImage(text), opts);

  it("rules-3: two different receipts from a store whose header prints its phone number are both credited", async () => {
    const head = "TAX INVOICE\n0242-123456\nSUNRISE SUPERMARKET\nWestgate Branch, Harare";
    const one = await send(P1, receiptText({ merchant: head, no: "004512", body: SUGAR_2KG_X2 }));
    assert.equal(one.receipt.status, "QUALIFIED", JSON.stringify(one.receipt));
    const two = await send(P2, receiptText({ merchant: head, no: "004987", body: SUGAR_2KG_X2 }));
    assert.equal(two.receipt.status, "QUALIFIED", "a second genuine purchase must not collapse onto the first receipt's identity");
    const keys = h.db.prepare(`select canonical_key from canonical_receipts where credited_receipt_id in (?,?)`).all(one.receiptId, two.receiptId).map((r) => r.canonical_key);
    assert.equal(new Set(keys).size, 2, keys.join(" | "));
  });

  it("rules-5: the credited identity carries the receipt's own total, not the cash tendered", async () => {
    const r = await send(P1, receiptText({ no: "004520", body: SUGAR_2KG_X2, footer: "TOTAL                    6.20\nTOTAL TENDERED          10.00\nCHANGE                   3.80" }));
    assert.equal(r.receipt.status, "QUALIFIED");
    const c = h.db.prepare(`select total_minor, canonical_key from canonical_receipts where credited_receipt_id=?`).get(r.receiptId);
    assert.equal(c.total_minor, 620, c.canonical_key);
  });

  it("rules-1: selecting a different retailer that only shares the town is reviewed, not credited", async () => {
    const r = await send(P1, receiptText({ no: "004530", body: SUGAR_2KG_X2 }), { outlet: "corner choice hillside harare" });
    assert.equal(r.receipt.status, "REVIEW_REQUIRED", JSON.stringify(r.receipt));
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(r.receiptId).n, 0);
  });

  it("rules-4: a receipt whose qualifying line was voided at the till earns no entry", async () => {
    const r = await send(P1, receiptText({ no: "004540", body: `${SUGAR_2KG_X2}\n*** VOID ***`, footer: "TOTAL                    0.00" }));
    assert.equal(r.receipt.status, "NOT_QUALIFIED");
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(r.receiptId).n, 0);
  });

  it("rules-2: an unreadable item section reaches a reviewer instead of telling the buyer there was no product", async () => {
    const r = await send(P1, receiptText({ no: "004550", body: "2 X GOLDCANE BROWN SUGAR 2KG   12.40", footer: "TOTAL                   12.40" }));
    assert.equal(r.receipt.status, "REVIEW_REQUIRED", JSON.stringify(r.receipt));
    assert.notEqual(r.receipt.reason_code, "no_qualifying_product");
    assert.equal(h.db.prepare(`select count(*) n from review_tasks where receipt_id=?`).get(r.receiptId).n, 1, "a human must see it");
  });

  it("rules-6: a truncated description at the 1kg price is reviewed, not credited as the qualifying pack", async () => {
    const r = await send(P1, receiptText({ no: "004560", body: "GOLDCANE BROWN SUGAR\n  4 x 1.60               6.40", footer: "TOTAL                    6.40" }));
    assert.equal(r.receipt.status, "REVIEW_REQUIRED", JSON.stringify(r.receipt));
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(r.receiptId).n, 0);
    // the SEEDED catalogue's other generic alias, against the live campaign
    const g = await send(P1, receiptText({ no: "004561", body: "GC BROWN SUGAR\n  4 x 1.60               6.40", footer: "TOTAL                    6.40" }));
    assert.equal(g.receipt.status, "REVIEW_REQUIRED", JSON.stringify(g.receipt));
    assert.equal(h.db.prepare(`select count(*) n from entries where receipt_id=?`).get(g.receiptId).n, 0);
  });
});

describe("rules package — a partial rule patch on a live campaign", { timeout: 120_000 }, () => {
  it("rules-8: a prospective version that only changes min_packs keeps the rest of the rule set", async () => {
    const g = await buildApp({ extractor: "simulator" });
    try {
      const phone = "263771990103";
      await g.register(phone, { first: "Patch", last: "Rules", identity: "TESTPATCH1" });
      // the documented way to make a prospective change: patch one nested value.
      // The CUSTOMISED-sibling case (which this one cannot prove, because the
      // seeded values equal the platform defaults) is the test below.
      const vid = g.domain.newVersionFrom(g.campaign.id, { rules: { primary_rule: { min_packs: 2 } } }, "test");
      g.domain.activateVersion(g.campaign.id, vid, "test");
      const rules = g.domain.versionRules(g.campaign.id);
      assert.equal(rules.primary_rule.pack_grams, 2000, "the sibling thresholds survive the patch");
      assert.equal(rules.primary_rule.min_total_grams, 4000);
      const r = await g.submit(phone, await g.simImage(receiptText({ no: "770011", body: SUGAR_2KG_X2 })));
      assert.equal(r.receipt.status, "QUALIFIED", `a clean 2 x 2kg receipt must still qualify: ${JSON.stringify(r.receipt)}`);
    } finally { await g.close(); }
  });
});

describe("crosscut — a prospective patch over a CUSTOMISED rule set (round2-version-merge)", () => {
  it("editing one nested threshold does not revert its customised siblings to the platform defaults", async () => {
    const g = await buildApp({ extractor: "simulator" });
    try {
      // A campaign configured for 1kg packs: none of these three values is the
      // platform default (2 / 2000 / 4000).
      const custom = { products: PRODUCTS, primary_rule: { min_packs: 2, pack_grams: 1000, min_total_grams: 2000 }, allow_pack_combinations: false, date_order: "DMY" };
      const v0 = g.domain.createVersion(g.campaign.id, { content: g.domain.versionContent(g.campaign.id), rules: custom }, "test");
      g.domain.activateVersion(g.campaign.id, v0, "test");
      assert.equal(g.domain.versionRules(g.campaign.id).primary_rule.pack_grams, 1000, "the campaign is live on 1kg packs");
      // a manager edits ONLY min_packs through the console
      const v1 = g.domain.newVersionFrom(g.campaign.id, { rules: { primary_rule: { min_packs: 2 } } }, "test");
      g.domain.activateVersion(g.campaign.id, v1, "test");
      const rules = g.domain.versionRules(g.campaign.id);
      assert.equal(rules.primary_rule.pack_grams, 1000, "a shallow spread put the patch's primary_rule over the live one WHOLE, and defaultRules then refilled pack_grams from the platform default: every 1kg receipt stopped qualifying");
      assert.equal(rules.primary_rule.min_total_grams, 2000);
      // ...and the receipt the campaign was configured for still earns its entry
      const r = evaluateEligibility(parseReceiptText(receiptText({ no: "770022", body: "GOLDCANE BROWN SUGAR 1KG\n  2 x 1.60               3.20", footer: "TOTAL                    3.20" }), { outlets: OUTLETS }), rules, ctx());
      assert.equal(r.disposition, DISPOSITION.QUALIFIED, JSON.stringify(r.rules.filter((x) => x.outcome !== "pass")));
    } finally { await g.close(); }
  });
});
