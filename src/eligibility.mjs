/**
 * Deterministic, versioned eligibility rules (G-08, spec 11.3).
 * Pure function: same (facts, rules, context) -> same result. The campaign
 * version is immutable; receipts bind to the version active at creation.
 *
 * Rule outcomes: "pass" | "fail" | "review" with a stable reason code.
 * Final receipt decision aggregation:
 *   any fail            -> NOT_QUALIFIED (first stable reason)
 *   any review          -> NEEDS_REVIEW  (no silent qualification)
 *   all pass + confidence>=threshold -> QUALIFIED
 */

export const REASONS = {
  // participant-facing stable reason codes (never leak fraud signals)
  OUT_OF_CAMPAIGN_WINDOW: "receipt_date_outside_campaign",
  NON_PARTICIPATING_OUTLET: "outlet_not_participating",
  OUTLET_MISMATCH: "outlet_selection_mismatch",
  NO_PRODUCT_MATCH: "no_qualifying_product",
  BELOW_MIN_QTY: "below_minimum_quantity",
  TOTAL_TOO_LOW: "below_minimum_spend",
  MISSING_RECEIPT_NO: "missing_receipt_number",
  MISSING_DATE: "missing_transaction_date",
  MISSING_OUTLET: "missing_outlet",
  LOW_CONFIDENCE: "receipt_unclear",
  NOT_RECEIPT: "not_a_valid_receipt",
  CAP_REACHED: "weekly_entry_limit_reached",
  PARTICIPANT_BLOCKED: "participant_not_eligible",
  OVER_MAX_MEDIA: "image_too_large",
  UNSUPPORTED_MEDIA: "unsupported_media_type",
  WITHDRAWN_CONSENT: "consent_withdrawn",
  OK: "ok",
};

export const QUALIFIED = "QUALIFIED";
export const NOT_QUALIFIED = "NOT_QUALIFIED";
export const NEEDS_REVIEW = "NEEDS_REVIEW";
export const DUPLICATE = "DUPLICATE";
export const ERROR_STATE = "ERROR";

function rule(name, ok, reason, detail) {
  return { rule: name, outcome: ok ? "pass" : ok === null ? "review" : "fail", reason: ok ? REASONS.OK : reason, detail };
}

/**
 * facts:    normalized extraction {outlet, date, receiptNo, total, lineItems[], confidence}
 * rules:    campaign version rules {
 *             products: [{sku, aliases[], packWeightKg}],
 *             min_total_qty_kg: 4,
 *             min_packs: 2, pack_weight_kg: 2,
 *             min_total_amount, currencies: ["USD"],
 *             weekly_caps: {participant: 3},
 *             exclude_outlets: [], allow_outlets: [] or null,
 *             window: {start, end} ISO
 *           }
 * context:  {campaignStart, campaignEnd, selectedOutletId, outletParticipating,
 *            participantBlocked, weeklyEntryCount, consentValid, mediaOk}
 */
export function evaluateEligibility(facts, rules = {}, context = {}, opts = {}) {
  const { minConfidence = 0.6 } = opts;
  const results = [];
  const add = (n, ok, r, d) => results.push(rule(n, ok, r, d));

  // 1. Document quality
  if (!facts.receiptNo || !facts.date) add("receipt_identity", null, REASONS.MISSING_RECEIPT_NO, "missing receipt no/date");
  const total = Number(facts.total || 0);
  if (total <= 0) add("total_present", null, REASONS.TOTAL_TOO_LOW, "total missing or zero");

  // 2 - Campaign window: missing date -> review, never silent fail
    const dt = new Date(facts.date || "");
    const inWindow = !facts.date ? null
      : (!context.campaignStart || !context.campaignEnd
          || (dt >= new Date(context.campaignStart) && dt <= new Date(context.campaignEnd)));
    add("campaign_window", inWindow, REASONS.OUT_OF_CAMPAIGN_WINDOW, `receipt ${facts.date}`);

  // 3. Outlet
  const outletOk = !context.outletParticipating
    ? null
    : !!context.selectedOutletId && context.outletParticipating(context.selectedOutletId, facts.outlet, rules);
  add("outlet", outletOk, REASONS.NON_PARTICIPATING_OUTLET, `selected=${context.selectedOutletId} extracted=${facts.outlet}`);

  // 4. Product + threshold (D-03 safe default: 2 x 2kg packs or 4kg total)
  const lines = Array.isArray(facts.lineItems) ? facts.lineItems : [];
  const products = rules.products || [];
  const thresholdKg = Number(rules.min_total_qty_kg || 4);
  const matchLine = (line, p) => {
    const desc = String(line.description || "").toLowerCase();
    const parts = [];
    if (p.sku) parts.push(String(p.sku).toLowerCase());
    for (const a of (p.aliases || [])) if (a) parts.push(String(a).toLowerCase());
    if (p.name) parts.push(String(p.name).toLowerCase());
    return parts.some((pt) => pt && desc.includes(pt));
  };
  const matched = [];
  for (const line of lines) {
    for (const p of products) {
      if (matchLine(line, p)) {
        const qty = Number(line.quantity || 0);
        const kg = qty * (Number(p.packWeightKg ?? p.pack_weight_kg) || 0);
        matched.push({ sku: p.sku, qty, kg, line });
        break;
      }
    }
  }
  const totalKg = matched.reduce((a, m) => a + m.kg, 0);
  const minPacks = Number(rules.min_packs || 2);
  const packs = matched.reduce((a, m) => a + m.qty, 0);
  const meets = totalKg >= thresholdKg && packs >= minPacks;
  add("product_qualification", meets ? true : (matched.length ? false : null),
    REASONS.NO_PRODUCT_MATCH, `matched=${JSON.stringify(matched)} thresholdKg=${thresholdKg}`);

  // 5. Participant caps
  const cap = Number(rules.weekly_caps?.participant || 0);
  const capOk = cap <= 0 || Number(context.weeklyEntryCount || 0) < cap;
  add("participant_cap", capOk, REASONS.CAP_REACHED, `count=${context.weeklyEntryCount} cap=${cap}`);

  // 6. Participant state
  add("participant_active", !context.participantBlocked, REASONS.PARTICIPANT_BLOCKED, "");
  add("consent_valid", context.consentValid !== false, REASONS.WITHDRAWN_CONSENT, "");

  // 7. Confidence -> review instead of silent pass
  if (Number(facts.confidence || 1) < minConfidence) add("extraction_confidence", null, REASONS.LOW_CONFIDENCE, `conf=${facts.confidence}`);

  const hasFail = results.some((r) => r.outcome === "fail");
  const hasReview = results.some((r) => r.outcome === "review");
  const decision = hasFail ? NOT_QUALIFIED : hasReview ? NEEDS_REVIEW : QUALIFIED;
  const reason = decision === NOT_QUALIFIED
    ? results.find((r) => r.outcome === "fail").reason
    : decision === NEEDS_REVIEW ? results.find((r) => r.outcome === "review").reason : REASONS.OK;
  return { decision, reason, ruleResults: results, totalKg, packs, matchedLines: matched.length };
}

/** Group a receipt into an ISO-8601 week period (e.g. 2026-W38). */
export function drawPeriodOf(dateIso) {
  const d = new Date(dateIso);
  // ISO week: Thursday's year, days since Thursday / 7
  const cd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = cd.getUTCDay() || 7;
  cd.setUTCDate(cd.getUTCDate() + 4 - day);           // Thursday of this week
  const yearStart = new Date(Date.UTC(cd.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((cd - yearStart) / 86400000 + 1) / 7);
  return `${cd.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}