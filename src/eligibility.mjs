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

/** Default rule set shape (rules_json v2). All thresholds are explicit. */
export function defaultRules(overrides = {}) {
  return {
    rules_version: 2,
    products: [],                                  // [{ code, name, aliases[], pack_grams, qualifying }]
    primary_rule: { min_packs: 2, pack_grams: 2000, min_total_grams: 4000 },
    allow_pack_combinations: false,                // D-06: any approved pack sizes totalling min_total_grams
    award: { entries_per_receipt: 1 },             // D-07: no multiplier unless approved
    caps: { per_participant_per_period: null },    // D-08: null = unlimited
    date_order: "DMY",
    outlet_match: { required: true, min_score: 0.5 },
    review_thresholds: { min_document_score: 0.5, min_ocr_confidence: 0.35 },
    ...overrides,
  };
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }

/** Match a line to a catalogue product by code/name/alias token containment. */
export function matchProduct(line, products) {
  const desc = norm(line.description);
  for (const p of products) {
    if (p.qualifying === false) continue;
    const keys = [p.code, p.name, ...(p.aliases || [])].map(norm).filter(Boolean);
    for (const k of keys) {
      if (k && desc.includes(k)) return { code: p.code, packGrams: Number(p.pack_grams) || null, basis: k };
    }
  }
  return null;
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
  const inWin = (d) => { const t = new Date(d + "T12:00:00Z"); return (!ws || t >= startOfDay(ws)) && (!we || t < we); };
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
    const packGrams = li.packGrams || m.packGrams || null;
    if (li.quantity == null || !packGrams) { qtyUnknown = true; matched.push({ ...m, quantity: li.quantity, packGrams, grams: null, line: li.rawText }); continue; }
    matched.push({ ...m, quantity: li.quantity, packGrams, grams: li.quantity * packGrams, line: li.rawText });
  }
  const primaryPacks = matched.filter((m) => m.grams != null && m.packGrams === pr.pack_grams).reduce((a, m) => a + m.quantity, 0);
  const totalGrams = matched.reduce((a, m) => a + (m.grams || 0), 0);
  let meets = primaryPacks >= pr.min_packs && primaryPacks * pr.pack_grams >= pr.min_total_grams;
  if (!meets && rules.allow_pack_combinations) meets = totalGrams >= pr.min_total_grams;
  if (!matched.length) add("qualifying_product", "fail", REASONS.NO_PRODUCT, { lines: (x.lineItems || []).length });
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

function startOfDay(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
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
