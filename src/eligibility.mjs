/**
 * Deterministic, versioned eligibility rules (spec §11). Pure function:
 * same (extraction, rules, context) -> same result. Quantities are integer
 * grams; money is integer minor units. Every rule reports pass|fail|unknown
 * with a stable participant-safe reason code and internal evidence.
 *
 * Dispositions: QUALIFIED | NOT_QUALIFIED | REVIEW_REQUIRED | REUPLOAD_REQUIRED
 * (DUPLICATE is decided by the pipeline's canonical-receipt claim, not here).
 * Precedence: any fail -> NOT_QUALIFIED (document/quality failures ->
 * REUPLOAD_REQUIRED); else any unknown -> REVIEW_REQUIRED; else QUALIFIED.
 */
import { packGramsFrom } from "./extract/parse-receipt.mjs";

export const REASONS = {
  OK: "ok",
  NOT_RECEIPT: "not_a_valid_receipt",
  IMAGE_QUALITY: "image_quality_insufficient",
  CAMPAIGN_INACTIVE: "campaign_not_open",
  NOT_ENROLLED: "participant_not_enrolled",
  PARTICIPANT_BLOCKED: "participant_not_eligible",
  MISSING_RECEIPT_NO: "missing_receipt_number",
  MISSING_DATE: "missing_transaction_date",
  DATE_AMBIGUOUS: "transaction_date_unclear",
  OUT_OF_WINDOW: "receipt_date_outside_campaign",
  OUTLET_UNKNOWN: "outlet_not_readable",
  OUTLET_MISMATCH: "outlet_selection_mismatch",
  OUTLET_NOT_PARTICIPATING: "outlet_not_participating",
  NO_PRODUCT: "no_qualifying_product",
  QTY_UNKNOWN: "quantity_unclear",
  BELOW_MIN: "below_minimum_quantity",
  CAP_REACHED: "entry_limit_reached",
  TOTAL_MISSING: "total_unclear",
};

export const DISPOSITION = { QUALIFIED: "QUALIFIED", NOT_QUALIFIED: "NOT_QUALIFIED", REVIEW: "REVIEW_REQUIRED", REUPLOAD: "REUPLOAD_REQUIRED", DUPLICATE: "DUPLICATE" };

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Default rule set shape (rules_json v2). All thresholds are explicit. */
export function defaultRules(overrides = {}) {
  const base = {
    rules_version: 2,
    products: [],                                  // [{ code, name, aliases[], pack_grams, qualifying }]
    primary_rule: { min_packs: 2, pack_grams: 2000, min_total_grams: 4000 },
    allow_pack_combinations: false,                // D-06: any approved pack sizes totalling min_total_grams
    award: { entries_per_receipt: 1 },             // D-07: no multiplier unless approved
    caps: { per_participant_per_period: null },    // D-08: null = unlimited
    date_order: "DMY",
    outlet_match: { required: true, min_score: 0.5 },
    review_thresholds: { min_document_score: 0.5, min_ocr_confidence: 0.35 },
  };
  const out = { ...base, ...overrides };
  // The nested rule objects are MERGED, never replaced. A partial override —
  // the natural shape of a console edit or of a prospective version patch
  // ({ primary_rule: { min_packs: 3 } }) — used to wipe the sibling keys, which
  // left pack_grams / min_total_grams / min_score undefined: every clean receipt
  // was then rejected as below_minimum_quantity (packGrams === undefined matches
  // nothing) or sent to review as outlet_selection_mismatch (score >= undefined
  // is always false), silently, with a participant-visible wrong reason.
  for (const k of Object.keys(base)) {
    if (isPlainObject(base[k]) && isPlainObject(overrides?.[k])) out[k] = { ...base[k], ...overrides[k] };
  }
  return out;
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
const productKeys = (p) => [p.code, p.name, ...(p.aliases || [])].map(norm).filter(Boolean);

/**
 * Match a line to a catalogue product by code/name/alias containment.
 * The MOST SPECIFIC (longest) matching key wins, not the first product in the
 * list: "GOLDCANE BROWN SUGAR 1KG" used to match the 2kg SKU's generic alias
 * "goldcane brown sugar" purely because that product is listed first.
 * `packAmbiguous` says the matched key cannot settle the pack size on its own,
 * so a description that prints no pack size must not be credited with the
 * qualifying pack (see the fallback in evaluateEligibility).
 */
export function matchProduct(line, products, catalogue = products) {
  const desc = norm(line.description);
  let best = null;
  for (const p of products || []) {
    if (p.qualifying === false) continue;
    for (const k of productKeys(p)) {
      if (desc.includes(k) && (!best || k.length > best.basis.length)) best = { code: p.code, packGrams: Number(p.pack_grams) || null, basis: k };
    }
  }
  if (!best) return null;
  // The key itself must settle the pack size. Deciding this by asking whether
  // ANOTHER catalogue key lexically CONTAINS the matched one missed the common
  // shape: the seeded 2kg SKU also answers to the generic alias "gc brown
  // sugar", which states no size and is a substring of nothing, so a truncated
  // till line "GC BROWN SUGAR" + "4 x 1.60" borrowed the 2kg catalogue pack and
  // credited four 1kg packs as the qualifying purchase (D-06). A key that names
  // no pack size is therefore ambiguous whenever the catalogue sells more than
  // one pack size; a catalogue with a single pack size stays decidable, so a
  // one-size campaign does not send every truncated line to review.
  const packSizes = new Set((catalogue || []).map((p) => Number(p.pack_grams)).filter((g) => Number.isFinite(g) && g > 0));
  const keySaysPack = packGramsFrom(best.basis) != null;
  // ...and a key another SKU with a different pack size also answers to cannot
  // settle it either, whatever size the key itself states.
  const sharedAcrossSizes = (catalogue || []).some((p) => {
    const g = Number(p.pack_grams) || null;
    return g && g !== best.packGrams && productKeys(p).some((k) => k.includes(best.basis));
  });
  return { ...best, packAmbiguous: sharedAcrossSizes || (!keySaysPack && packSizes.size > 1) };
}

export function evaluateEligibility(extraction, rulesIn = {}, context = {}) {
  const rules = defaultRules(rulesIn);
  const R = [];
  const add = (rule, outcome, reason, evidence) => R.push({ rule, outcome, reason: outcome === "pass" ? REASONS.OK : reason, evidence: evidence ?? null });
  const x = extraction || {};
  const doc = x.document || { kind: "unknown", score: 0 };
  const q = x.quality || {};
  const tx = x.transaction || {};

  // 1. Document classification + image quality
  if (doc.kind === "non_receipt") add("document_is_receipt", "fail", REASONS.NOT_RECEIPT, { score: doc.score });
  else if (doc.kind === "unknown" || (doc.score ?? 0) < rules.review_thresholds.min_document_score) add("document_is_receipt", "unknown", REASONS.NOT_RECEIPT, { score: doc.score });
  else add("document_is_receipt", "pass", null, { score: doc.score });
  // Image quality is a signal for the re-upload message, never a reason to hold
  // a receipt whose text and facts were read: poor quality + not a readable
  // receipt -> re-upload; otherwise the document/fact rules decide.
  const iq = context.imageQuality || {};
  if ((iq.blurry || iq.tooDark || iq.lowContrast) && doc.kind !== "receipt") add("image_quality", "fail", REASONS.IMAGE_QUALITY, iq);
  else add("image_quality", "pass", null, iq);

  // 2. Campaign + participant
  add("campaign_open", context.campaignOpen === false ? "fail" : "pass", REASONS.CAMPAIGN_INACTIVE, { intakeAt: context.intakeAt });
  add("participant_enrolled", context.enrolled === false ? "fail" : "pass", REASONS.NOT_ENROLLED, null);
  add("participant_eligible", context.participantBlocked ? "fail" : "pass", REASONS.PARTICIPANT_BLOCKED, null);

  // 3. Receipt identity
  add("receipt_number_present", tx.receiptNo ? "pass" : "unknown", REASONS.MISSING_RECEIPT_NO, { receiptNo: tx.receiptNo });
  add("total_present", tx.totalMinor != null ? "pass" : "unknown", REASONS.TOTAL_MISSING, { totalMinor: tx.totalMinor });

  // 4. Purchase date inside window (half-open [start, end))
  const ws = context.windowStart ? new Date(context.windowStart) : null, we = context.windowEnd ? new Date(context.windowEnd) : null;
  // A receipt date is a calendar DAY, the window is an instant range, so the day
  // is compared as the range it covers in the zone the window was expressed in.
  // The old code floored the start instant in UTC: a window opening
  // "2026-10-01T00:00:00+02:00" floored to 2026-09-30T00:00Z and credited
  // receipts dated the day BEFORE the promotion opened.
  const offStart = zoneOffsetMinutes(context.windowStart), offEnd = zoneOffsetMinutes(context.windowEnd);
  const dayStart = (d, off) => { const [y, mo, dd] = String(d).split("-").map(Number); return Date.UTC(y, mo - 1, dd) - off * 60_000; };
  const inWin = (d) => (!ws || dayStart(d, offStart) + 86_400_000 > ws.getTime()) && (!we || dayStart(d, offEnd) < we.getTime());
  if (!tx.date) add("purchase_date_in_window", "unknown", REASONS.MISSING_DATE, { dateRaw: tx.dateRaw });
  else if (tx.dateAmbiguous) {
    // Day/month order comes from the campaign's configured date_order (D-09).
    // The configured reading governs; review only when the two readings
    // DISAGREE about the window (configured reading out, alternative in).
    const alt = swapDayMonth(tx.date);
    const a = inWin(tx.date), b = alt ? inWin(alt) : a;
    if (a) add("purchase_date_in_window", "pass", null, { date: tx.date, alt, ambiguous: true, dateOrder: rules.date_order });
    else if (!b) add("purchase_date_in_window", "fail", REASONS.OUT_OF_WINDOW, { date: tx.date, alt, ambiguous: true });
    else add("purchase_date_in_window", "unknown", REASONS.DATE_AMBIGUOUS, { date: tx.date, alt, dateOrder: rules.date_order });
  } else add("purchase_date_in_window", inWin(tx.date) ? "pass" : "fail", REASONS.OUT_OF_WINDOW, { date: tx.date, windowStart: context.windowStart, windowEnd: context.windowEnd });

  // 5. Outlet: selected outlet must participate; extracted merchant must credibly match it
  if (context.selectedOutletParticipating === false) add("outlet_participating", "fail", REASONS.OUTLET_NOT_PARTICIPATING, { selected: context.selectedOutletId });
  else add("outlet_participating", "pass", null, { selected: context.selectedOutletId });
  const cands = (x.merchant?.candidates || []);
  const hit = cands.find((c) => c.outletId === context.selectedOutletId && c.score >= rules.outlet_match.min_score);
  if (!rules.outlet_match.required) add("outlet_match", "pass", null, { skipped: true });
  else if (hit) add("outlet_match", "pass", null, { score: hit.score, basis: hit.basis });
  else if (!cands.length) add("outlet_match", "unknown", REASONS.OUTLET_UNKNOWN, { merchantText: x.merchant?.rawText });
  else add("outlet_match", "unknown", REASONS.OUTLET_MISMATCH, { merchantText: x.merchant?.rawText, top: cands[0] });

  // 6. Product + quantity (integer grams; voided lines excluded; "2KG" is pack size not qty)
  const products = rules.products || [];
  const pr = rules.primary_rule;
  const matched = [];
  let qtyUnknown = false;
  for (const li of (x.lineItems || [])) {
    if (li.voided) continue;
    const m = matchProduct(li, products);
    if (!m) continue;
    // Only fall back to the catalogue pack size when the matched key identifies
    // ONE pack size. A truncated till description ("GOLDCANE BROWN SUGAR", no
    // size) otherwise inherited the qualifying 2kg pack and credited a purchase
    // of four 1kg packs; the ambiguity now goes to a reviewer instead of being
    // resolved in the participant's favour.
    const packGrams = li.packGrams || (m.packAmbiguous ? null : m.packGrams) || null;
    if (li.quantity == null || !packGrams) { qtyUnknown = true; matched.push({ ...m, quantity: li.quantity, packGrams, grams: null, line: li.rawText }); continue; }
    matched.push({ ...m, quantity: li.quantity, packGrams, grams: li.quantity * packGrams, line: li.rawText });
  }
  const primaryPacks = matched.filter((m) => m.grams != null && m.packGrams === pr.pack_grams).reduce((a, m) => a + m.quantity, 0);
  const totalGrams = matched.reduce((a, m) => a + (m.grams || 0), 0);
  let meets = primaryPacks >= pr.min_packs && primaryPacks * pr.pack_grams >= pr.min_total_grams;
  if (!meets && rules.allow_pack_combinations) meets = totalGrams >= pr.min_total_grams;
  // No item line could be read at all (unsupported till layout, damaged print):
  // that is an UNKNOWN, not a business rejection. Telling a genuine buyer of
  // 2 x 2kg that "no qualifying product was found" — with no human ever seeing
  // the receipt, because only REVIEW_REQUIRED creates a review task — is the
  // failure this guards. A receipt whose items DID parse and match nothing is
  // still the wrong-SKU case and stays a hard fail.
  if (!matched.length && !(x.lineItems || []).length && (q.missing || []).includes("line_items")) add("qualifying_product", "unknown", REASONS.QTY_UNKNOWN, { lines: 0, unreadableItems: true });
  else if (!matched.length) add("qualifying_product", "fail", REASONS.NO_PRODUCT, { lines: (x.lineItems || []).length });
  else if (meets) add("qualifying_product", "pass", null, { primaryPacks, totalGrams, matched });
  else if (qtyUnknown) add("qualifying_product", "unknown", REASONS.QTY_UNKNOWN, { primaryPacks, totalGrams, matched });
  else add("qualifying_product", "fail", REASONS.BELOW_MIN, { primaryPacks, totalGrams, required: pr, combinationsAllowed: !!rules.allow_pack_combinations, matched });

  // 7. Caps (business caps only if approved; null = unlimited)
  const cap = rules.caps?.per_participant_per_period;
  if (cap != null && Number(cap) > 0) add("entry_cap", Number(context.periodEntryCount || 0) < Number(cap) ? "pass" : "fail", REASONS.CAP_REACHED, { count: context.periodEntryCount, cap });
  else add("entry_cap", "pass", null, { unlimited: true });

  // 8. OCR confidence (information only; low -> review, never fail)
  if (q.confidence != null && q.confidence < rules.review_thresholds.min_ocr_confidence) add("ocr_confidence", "unknown", REASONS.IMAGE_QUALITY, { confidence: q.confidence });
  else add("ocr_confidence", "pass", null, { confidence: q.confidence });

  const fails = R.filter((r) => r.outcome === "fail");
  const unknowns = R.filter((r) => r.outcome === "unknown");
  let disposition, reason;
  if (fails.length) {
    // A non-receipt / unusable image is a re-upload case, whatever else failed:
    // there is no receipt to judge, so no business reason may be reported.
    const docFail = fails.find((r) => ["document_is_receipt", "image_quality"].includes(r.rule));
    const first = docFail || fails[0];
    disposition = docFail ? DISPOSITION.REUPLOAD : DISPOSITION.NOT_QUALIFIED;
    reason = first.reason;
  } else if (unknowns.length) { disposition = DISPOSITION.REVIEW; reason = unknowns[0].reason; }
  else { disposition = DISPOSITION.QUALIFIED; reason = REASONS.OK; }
  return { disposition, reason, rules: R, rulesVersion: rules.rules_version, primaryPacks, totalGrams, matched, awardUnits: disposition === DISPOSITION.QUALIFIED ? Number(rules.award?.entries_per_receipt || 1) : 0 };
}

/**
 * Minutes east of UTC of the zone an ISO window bound was written in
 * ("...+02:00" -> 120). "Z", a missing offset or a non-string bound -> UTC, so
 * windows stored as UTC instants keep their existing day boundaries.
 */
function zoneOffsetMinutes(v) {
  const m = typeof v === "string" ? v.match(/([+-])(\d{2}):?(\d{2})$/) : null;
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
function swapDayMonth(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  if (d > 12) return null;
  return `${y}-${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}`;
}

/** Period code for an intake timestamp from configured half-open periods. */
export function periodFor(periods, intakeIso) {
  const t = new Date(intakeIso).getTime();
  for (const p of periods) if (t >= new Date(p.starts_at).getTime() && t < new Date(p.ends_at).getTime()) return p;
  return null;
}
