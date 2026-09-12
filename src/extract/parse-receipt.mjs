/**
 * Deterministic receipt text parser (spec §10 steps 4, 6, 7).
 * Input: OCR text (untrusted). Output: structured facts with nulls for
 * unknowns. No value here is ever "guessed": if a date or number cannot be
 * parsed unambiguously it stays null and a review reason is recorded.
 *
 * Text from the receipt is DATA. Nothing in it is interpreted as an
 * instruction; the parser only pattern-matches numbers, dates, and keywords.
 */

const RECEIPT_KEYWORDS = ["total", "cash", "change", "vat", "tax", "receipt", "invoice", "till", "cashier", "tel", "thank you", "subtotal", "qty", "amount", "tender", "balance", "card", "item"];
const NON_RECEIPT_HINTS = ["approve", "qualify this", "ignore previous", "system prompt", "instruction"];

export function classifyDocument(text, quality = {}) {
  const t = String(text || "").toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const kw = RECEIPT_KEYWORDS.filter((k) => t.includes(k)).length;
  const priceLines = (t.match(/\d+[.,]\d{2}\b/g) || []).length;
  const dateLike = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t);
  const injection = NON_RECEIPT_HINTS.filter((k) => t.includes(k)).length;
  // score: keyword density + price lines + date presence; bounded 0..1
  let score = 0;
  score += Math.min(kw, 5) * 0.1;
  score += Math.min(priceLines, 4) * 0.1;
  score += dateLike ? 0.1 : 0;
  if (words.length < 6) score = Math.min(score, 0.15);
  score = Math.min(1, score);
  const kind = score >= 0.5 ? "receipt" : score <= 0.2 ? "non_receipt" : "unknown";
  return { kind, score: Number(score.toFixed(2)), signals: { keywords: kw, priceLines, dateLike, words: words.length, injectionHints: injection, ...quality } };
}

// --- money -------------------------------------------------------------------
export function parseMoneyMinor(s) {
  if (s == null) return null;
  const m = String(s).replace(/[,$\s]/g, "").match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0"));
}

// --- dates ---------------------------------------------------------------------
/**
 * Parse common till date formats. Returns { date: "YYYY-MM-DD", raw, ambiguous }
 * or null. Day/month order: if either part > 12 it is unambiguous; otherwise
 * the campaign's `dateOrder` ("DMY" default for the client's market) is used and
 * `ambiguous` is flagged so the rules engine can route to review when the two
 * readings straddle the campaign window.
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
export function parseDate(text, { dateOrder = "DMY" } = {}) {
  const t = String(text || "");
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return valid(m[1], m[2], m[3], m[0], false);
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]); let y = Number(m[3]); if (y < 100) y += 2000;
    let d, mo, ambiguous = false;
    if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { d = b; mo = a; }
    else { ambiguous = a !== b && a <= 12 && b <= 12; if (dateOrder === "MDY") { mo = a; d = b; } else { d = a; mo = b; } }
    return valid(y, mo, d, m[0], ambiguous);
  }
  m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,4})\.?\s+(\d{4}|\d{2})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) { let y = Number(m[3]); if (y < 100) y += 2000; return valid(y, MONTHS[m[2].toLowerCase()], m[1], m[0], false); }
  return null;
}
function valid(y, mo, d, raw, ambiguous) {
  y = Number(y); mo = Number(mo); d = Number(d);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return { date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, raw, ambiguous };
}
export function parseTime(text) {
  const m = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

// --- receipt number / till -----------------------------------------------------------
// Every candidate on the page is scored and the best-evidenced one wins.
// Groups are (keyword, label, separator, value) in both patterns. The keyword
// alternation is boundary-anchored — an un-anchored "rec" used to match inside
// "RECEIVED" — and longer alternatives come first.
const RCPT_PATTERNS = [
  /\b(receipt|rcpt|rec|invoice|inv|slip|document|doc|transaction|trans|txn|reference|ref)\s*(no|nr|number|#)?(?![a-z])\s*([:#.])?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/gi,
  /\b(no|nr)()\s*([:#.])\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi,
];
const RCPT_KEY_WEIGHT = { receipt: 3, rcpt: 3, rec: 3, slip: 3, invoice: 2, inv: 2, no: 2, nr: 2, document: 1, doc: 1, transaction: 1, trans: 1, txn: 1, reference: 1, ref: 1 };
export function parseReceiptNo(text) {
  const t = String(text || "");
  let best = null;
  for (const p of RCPT_PATTERNS) {
    for (const m of t.matchAll(p)) {
      const [raw, kw, label, sep, value] = m;
      const v = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      // A receipt number must carry at least one digit; "TILL", "DATE" etc. are
      // labels, and a printed date is not an identifier. Reject THIS candidate
      // and keep scanning: the old code gave up on the whole pattern after its
      // first match, so a header "TAX INVOICE / 0242-123456" made the store's
      // phone number the receipt number of every receipt from that store — one
      // canonical identity for every purchase, so honest customers were refused
      // as duplicates.
      if (!/\d/.test(v) || /^(TILL|DATE|TIME|NO|NR|POS)$/.test(v)) continue;
      if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      let score = (RCPT_KEY_WEIGHT[kw.toLowerCase()] || 1) + (label ? 2 : 0) + (sep ? 1 : 0);
      // A bare keyword whose value sits on ANOTHER line is weak evidence (a
      // header word followed by whatever number is printed next); it must never
      // beat a labelled number printed beside its label.
      if (/\n/.test(raw) && !label && !sep) score -= 5;
      if (!best || score > best.score) best = { receiptNo: v, raw: raw.trim(), score };
    }
  }
  // Positive evidence is required. A candidate whose only support is a bare
  // keyword on ANOTHER line scores below zero and used to be adopted anyway
  // when it was the only one on the page, so a store header printing "TAX
  // INVOICE" above its phone number still minted ONE canonical identity for
  // every receipt it issued and the second honest customer was refused as a
  // DUPLICATE. With no credible number the receipt goes to a reviewer
  // (missing_receipt_number) instead.
  return best && best.score > 0 ? { receiptNo: best.receiptNo, raw: best.raw } : { receiptNo: null, raw: null };
}
export function parseTill(text) {
  const m = String(text || "").match(/\b(?:till|terminal|pos|register|lane)\s*(?:no|#)?\s*[:#.]?\s*([A-Z0-9]{1,6})\b/i);
  return m ? m[1].toUpperCase() : null;
}
// The total is labelled at the START of its line and the label is the total
// itself, not a qualified variant of it ("SUB TOTAL", "VAT TOTAL", "CASH TOTAL",
// "TOTAL TENDERED", "TOTAL DISCOUNT"); "TOTAL DUE" / "AMOUNT DUE" are the total.
// Only non-alphanumerics may precede the label, so OCR noise ("| TOTAL") is
// tolerated while a qualifying word before it ("CASH TOTAL") is not.
const TOTAL_LABEL = /^[^0-9A-Za-z]*(?:grand\s+|net\s+|invoice\s+|sale\s+)?(?:total(?:\s+(?:due|payable))?|amount\s+(?:due|payable))/i;
// Words between the label and the amount that make the line a settlement, an
// aggregate or a component rather than the receipt's own total. This is a
// DENYLIST on purpose: an allowlist of currency tokens rejected the very common
// "TOTAL AMOUNT DUE", "TOTAL AMOUNT", "TOTAL INCL VAT" and unlisted currencies
// ("TOTAL RTGS", "TOTAL ZAR"), so every receipt from such a till — and any
// receipt where OCR left a stray letter after TOTAL — lost its total and landed
// in the review queue as total_unclear.
const TOTAL_NOT_THE_TOTAL = /\b(?:tender(?:ed)?|paid|cash|card|change|due\s*-?\s*back|discount|savings?|round(?:ing|ed)?|items?|qty|quantity|points?|excl(?:uding)?\.?\s*vat|ex\.?\s*vat)\b/i;
// A tax word between the label and the amount makes the line a COMPONENT of the
// total ("TOTAL VAT 0.81"), and with first-match-wins that component was being
// read as the purchase total: a wrong total both misjudges the receipt and moves
// the canonical identity (outlet|date|number|total), so two photographs of one
// slip stop resolving to one claim. "TOTAL INCL VAT" is the opposite statement —
// it says the amount already contains the tax — so an inclusive qualifier lifts
// the rejection.
const TOTAL_COMPONENT = /\b(?:vat|tax|levy|duty)\b/i;
const TOTAL_INCLUSIVE = /\b(?:inc|incl|including|inclusive)\b/i;
// The amount must start at its own left edge. Without the lookbehind, a
// thousands-grouped total was read from the middle: "TOTAL 1,480.00" matched
// "480.00" and a 1,480.00 purchase was recorded — and qualified — as 480.00.
// The first alternative takes the grouped form whole; the second is the plain
// one. A trailing digit (or separator-then-digit) after the match means we
// stopped inside a longer number, so it is not the amount.
const TOTAL_AMOUNT = /(?<![\d.,])(\d{1,3}(?:[,\s]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?!\d)(?![.,]\d)/;
// "6,20" is a decimal comma; "1,234.56" is a thousands comma. The presence of a
// dot decides which, so a grouped total is not mangled into "1.234.56".
const normaliseAmount = (s) => (s.includes(".") ? s.replace(/[,\s]/g, "") : s.replace(",", "."));
export function parseTotal(text) {
  for (const l of String(text || "").split(/\r?\n/)) {
    const lab = l.match(TOTAL_LABEL);
    if (!lab) continue;
    const rest = l.slice(lab[0].length);
    const m = rest.match(TOTAL_AMOUNT);
    if (!m) continue;
    const between = rest.slice(0, m.index);
    if (TOTAL_NOT_THE_TOTAL.test(between)) continue;
    if (TOTAL_COMPONENT.test(between) && !TOTAL_INCLUSIVE.test(between)) continue;
    const v = parseMoneyMinor(normaliseAmount(m[1]));
    // FIRST valid total wins. Taking the last total-like line let trailing
    // "TOTAL TENDERED" / "VAT TOTAL" / "TOTAL DISCOUNT" lines overwrite the real
    // total: the stored total was wrong and the canonical receipt identity
    // (outlet|date|number|total) moved with whether that footer line happened to
    // be read, so two photos of one purchase could each be credited.
    if (v != null) return { totalMinor: v, raw: l.trim() };
  }
  return { totalMinor: null, raw: null };
}

// --- line items ------------------------------------------------------------------------
const VOID_RE = /\b(void|voided|refund|return|reversal|cancel(?:led)?)\b/i;
// words a cancellation line carries about ITSELF — they never name a product,
// so a void line left with none of its own words is a bare cancellation
const VOID_CONTEXT_WORD = /^(void|voided|refund|refunded|return|returned|reversal|reversed|cancel|cancelled|item|items|line|sale|transaction|txn|entry|last|previous|correction|supervisor|manager|cashier|operator|override)$/;
// a bare cancellation that names the TRANSACTION rather than a line
const VOID_WHOLE_TXN = /\b(?:transaction|txn|sale)\b/i;
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|g|gr|grams?|kilograms?)\b/i;

export function packGramsFrom(desc) {
  const m = String(desc || "").match(PACK_RE);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return /^k/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Line item extraction. Supports:
 *   "GOLDCANE BROWN SUGAR 2KG" + next line "2 x 3.10   6.20"
 *   "BROWN SUGAR 2KG 2 @ 3.10 6.20"
 *   "BROWN SUGAR 2KG           6.20"  (qty defaults to 1 only when a price is present)
 * A "2KG" in the description is a pack size, NEVER a quantity of two (§11).
 */
export function parseLineItems(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => cleanOcrLine(l)).filter(Boolean);
  const items = [];
  const at = [];                                  // source line index per item; the void post-pass needs page order
  const push = (it, idx) => { items.push(it); at.push(idx); };
  // "2 x 3.10 6.20" / "3 X 3.10 9.30" / OCR noise like "3 X01 3.19°9_30" -> qty is the leading integer
  const qtyLine = /^(\d{1,3})\s*(?:x|@|\*)/i;
  const inlineQty = /^(.*?[A-Za-z]{3,}.*?)\s+(\d{1,3})\s*(?:x|@|\*)\s*(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s*$/i; // "DESC 2 x 3.10 6.20"
  const descPrice = /^(.*?[A-Za-z]{3,}.*?)\s+(\d+[.,]\d{2})\d?\s*$/;                               // "DESC 6.20" (tolerates one stray OCR digit)
  const stop = /\b(sub\s*total|total|cash|change|tender|vat|tax|balance|card|thank|receipt|invoice|slip|till|date|tel|cashier|pos)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (stop.test(l) && !/\d\s*(kg|g)\b/i.test(l)) continue;
    let m = l.match(inlineQty);
    if (m) { push(item(m[1], Number(m[2]), m[3], m[4], l), i); continue; }
    m = l.match(descPrice);
    if (m && !/^\d/.test(l)) {
      const next = lines[i + 1] || "";
      const q = next.match(qtyLine);
      if (q) { const [unit, amount] = moneyTokens(next); push(item(m[1], Number(q[1]), unit, amount, `${l} | ${next}`), i + 1); i++; continue; }
      push(item(m[1], 1, null, m[2], l), i);
      continue;
    }
    // description line followed by quantity line
    if (/[A-Za-z]{3,}/.test(l) && !/\d+[.,]\d{2}\s*$/.test(l)) {
      const next = lines[i + 1] || "";
      const q = next.match(qtyLine);
      if (q) { const [unit, amount] = moneyTokens(next); push(item(l, Number(q[1]), unit, amount, `${l} | ${next}`), i + 1); i++; }
    }
  }
  // Post-pass: a VOID/REFUND line printed after an item cancels the nearest
  // preceding item whose description it repeats, or — when it names no product
  // at all — the item it follows.
  const totalsAt = lines.findIndex((l) => /^\s*(?:grand\s+|net\s+|sale\s+)?(?:sub\s*)?total\b|^\s*amount\s+(?:due|payable)\b|^\s*balance\b/i.test(l));
  const itemBlockEnd = totalsAt === -1 ? lines.length : totalsAt;
  for (let i = 0; i < lines.length; i++) {
    if (!VOID_RE.test(lines[i])) continue;
    const toks = norm(lines[i]).split(" ").filter((w) => w.length > 2 && !VOID_CONTEXT_WORD.test(w));
    let target = null;
    for (let j = items.length - 1; j >= 0; j--) {
      if (at[j] > i) continue;                                  // a void cancels what was printed BEFORE it
      const d = norm(items[j].description).split(" ");
      if (toks.some((t) => d.includes(t))) { target = items[j]; break; }
    }
    // Bare cancellations — "*** VOID ***", "VOID ITEM", "VOIDED BY SUPERVISOR",
    // "VOID  -3.10" — used to cancel nothing, so a customer whose sugar was
    // voided at the till still got an entry (D-09). They carry no product word,
    // so they cancel the line they follow (matching the printed negative amount
    // when there is one). Restricted to the item block: a returns-policy footer
    // ("NO RETURN WITHOUT THIS SLIP") must never silently void a real line.
    if (!target && !toks.length && i < itemBlockEnd) {
      const neg = lines[i].match(/-\s*(\d+[.,]\d{2})\b/);
      const negMinor = neg ? parseMoneyMinor(neg[1].replace(",", ".")) : null;
      // A WHOLE-TRANSACTION cancellation ("TRANSACTION CANCELLED", "SALE
      // VOIDED") printed with no amount voids the whole basket, not just the
      // line above it: cancelling one of three qualifying packs still left two
      // counted, so an abandoned purchase was credited with an entry (D-09).
      if (negMinor == null && VOID_WHOLE_TXN.test(lines[i])) {
        for (let j = 0; j < items.length; j++) if (at[j] <= i) items[j].voided = true;
        continue;
      }
      for (let j = items.length - 1; j >= 0; j--) {
        if (at[j] > i) continue;
        if (negMinor != null && items[j].amountMinor !== negMinor) continue;
        target = items[j]; break;
      }
    }
    if (target) target.voided = true;
  }
  return items;
  function item(desc, qty, unit, amount, raw) {
    const description = desc.replace(/\s+/g, " ").trim();
    return {
      rawText: raw, description, quantity: Number.isFinite(qty) && qty > 0 && qty < 1000 ? qty : null,
      unitPriceMinor: unit ? parseMoneyMinor(unit) : null,
      amountMinor: amount ? parseMoneyMinor(amount) : null,
      packGrams: packGramsFrom(description), voided: VOID_RE.test(raw), productMatch: null,
    };
  }
}
/** OCR noise repair limited to number punctuation: "3:19" "3_19" "3°19" "1-20" -> "3.19". */
export function cleanOcrLine(l) {
  return String(l || "").trim()
    .replace(/(\d)[:_°'‘’`\-](\d{2})(?!\d)/g, "$1.$2")
    .replace(/(\d[.,])([0-9OoIl]{2})(?![0-9A-Za-z])/g, (_, a, b) => a + b.replace(/[Oo]/g, "0").replace(/[Il]/g, "1"))
    .replace(/\s+/g, " ");
}
function moneyTokens(line) {
  const toks = (String(line).match(/\d+\.\d{2}(?!\d)/g) || []);
  if (toks.length >= 2) return [toks[toks.length - 2], toks[toks.length - 1]];
  if (toks.length === 1) return [null, toks[0]];
  return [null, null];
}

// --- merchant matching -------------------------------------------------------------------
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
/**
 * Rank outlets against the receipt header. Score = 0.4 * retailer-name match
 * + 0.6 * location match (branch, town or an alias). A retailer-only match
 * (0.4) is below the default acceptance threshold (0.5): the same chain has
 * many branches, so the branch must also be legible for automatic acceptance.
 * A location-only match is capped the same way: many chains share a branch
 * name and a town, so the retailer must be legible too. Both remain
 * CANDIDATES a reviewer can accept; neither is automatic acceptance.
 */
export function matchOutlets(headerText, outlets) {
  const header = norm(headerText);
  if (!header) return [];
  const htoks = new Set(header.split(" ").filter((w) => w.length > 2));
  const overlap = (name) => { const toks = norm(name).split(" ").filter((w) => w.length > 2); if (!toks.length) return 0; return toks.filter((t) => htoks.has(t)).length / toks.length; };
  const out = [];
  for (const o of outlets) {
    let aliases = []; try { aliases = JSON.parse(o.aliases_json || "[]"); } catch { /* ignore */ }
    const r = overlap(o.retailer);
    const local = Math.max(overlap(o.branch), overlap(o.town), ...aliases.map((a) => overlap(a) >= 0.99 ? 1 : 0));
    const aliasFull = aliases.some((a) => overlap(a) >= 0.99);
    const raw = aliasFull ? 1 : Number((0.4 * r + 0.6 * local).toFixed(2));
    // A location-only match cannot identify a shop: different retailers have a
    // "Westgate" branch in the same town, and a bare town token alone used to
    // score 0.60 — above the 0.5 acceptance threshold — so a receipt was
    // auto-credited against an outlet the participant never visited, and the
    // same purchase could mint a second canonical identity under another
    // branch. Without the retailer the match is evidence for a reviewer
    // (candidate), never grounds for automatic acceptance.
    const score = !aliasFull && r < 0.5 ? Math.min(raw, 0.4) : raw;
    if (score >= 0.4) out.push({ outletId: o.id, score, basis: `retailer=${r.toFixed(2)} local=${local.toFixed(2)}` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** Full parse of OCR text into the extraction contract's fact groups. */
export function parseReceiptText(text, { outlets = [], dateOrder = "DMY", quality = {} } = {}) {
  const document = classifyDocument(text, quality);
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.slice(0, 5).join(" ");
  const rn = parseReceiptNo(text);
  const d = parseDate(text, { dateOrder });
  const total = parseTotal(text);
  const items = parseLineItems(text);
  const missing = [];
  if (!rn.receiptNo) missing.push("receipt_number");
  if (!d) missing.push("transaction_date");
  if (total.totalMinor == null) missing.push("total");
  if (!items.length) missing.push("line_items");
  const warnings = [];
  if (d?.ambiguous) warnings.push("date_day_month_ambiguous");
  if (document.signals.injectionHints) warnings.push("instruction_like_text_ignored");
  return {
    ocrText: String(text || ""),
    document,
    merchant: { rawText: header || null, candidates: matchOutlets(header, outlets) },
    transaction: { receiptNo: rn.receiptNo, receiptNoRaw: rn.raw, till: parseTill(text), date: d?.date || null, dateRaw: d?.raw || null, dateAmbiguous: !!d?.ambiguous, time: parseTime(text), currency: /\bUSD\b|\$/.test(text) ? "USD" : /\bZWG\b|\bZiG\b/i.test(text) ? "ZWG" : null, totalMinor: total.totalMinor, totalRaw: total.raw },
    lineItems: items,
    quality: { missing, warnings, confidence: null },
  };
}
