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
export function parseReceiptNo(text) {
  const t = String(text || "");
  const pats = [
    /(?:receipt|rcpt|rec|invoice|inv|slip|doc(?:ument)?|trans(?:action)?|txn|ref)\s*(?:no|nr|number|#)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /\b(?:no|nr)\s*[:#.]\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (!m) continue;
    const v = m[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
    // a receipt number must carry at least one digit; "TILL", "DATE" etc. are labels, not numbers
    if (!/\d/.test(v) || /^(TILL|DATE|TIME|NO|NR|POS)$/.test(v)) continue;
    return { receiptNo: v, raw: m[0] };
  }
  return { receiptNo: null, raw: null };
}
export function parseTill(text) {
  const m = String(text || "").match(/\b(?:till|terminal|pos|register|lane)\s*(?:no|#)?\s*[:#.]?\s*([A-Z0-9]{1,6})\b/i);
  return m ? m[1].toUpperCase() : null;
}
export function parseTotal(text) {
  const lines = String(text || "").split(/\r?\n/);
  let best = null;
  for (const l of lines) {
    if (/sub\s*total|total\s*items|total\s*qty|total\s*savings/i.test(l)) continue;
    const m = l.match(/\b(?:grand\s+)?total\b[^0-9]*(\d+[.,]\d{2})\b/i);
    if (m) { const v = parseMoneyMinor(m[1].replace(",", ".")); if (v != null) best = { totalMinor: v, raw: l.trim() }; }
  }
  return best || { totalMinor: null, raw: null };
}

// --- line items ------------------------------------------------------------------------
const VOID_RE = /\b(void|voided|refund|return|reversal|cancel(?:led)?)\b/i;
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
  // "2 x 3.10 6.20" / "3 X 3.10 9.30" / OCR noise like "3 X01 3.19°9_30" -> qty is the leading integer
  const qtyLine = /^(\d{1,3})\s*(?:x|@|\*)/i;
  const inlineQty = /^(.*?[A-Za-z]{3,}.*?)\s+(\d{1,3})\s*(?:x|@|\*)\s*(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s*$/i; // "DESC 2 x 3.10 6.20"
  const descPrice = /^(.*?[A-Za-z]{3,}.*?)\s+(\d+[.,]\d{2})\d?\s*$/;                               // "DESC 6.20" (tolerates one stray OCR digit)
  const stop = /\b(sub\s*total|total|cash|change|tender|vat|tax|balance|card|thank|receipt|invoice|slip|till|date|tel|cashier|pos)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (stop.test(l) && !/\d\s*(kg|g)\b/i.test(l)) continue;
    let m = l.match(inlineQty);
    if (m) { items.push(item(m[1], Number(m[2]), m[3], m[4], l)); continue; }
    m = l.match(descPrice);
    if (m && !/^\d/.test(l)) {
      const next = lines[i + 1] || "";
      const q = next.match(qtyLine);
      if (q) { const [unit, amount] = moneyTokens(next); items.push(item(m[1], Number(q[1]), unit, amount, `${l} | ${next}`)); i++; continue; }
      items.push(item(m[1], 1, null, m[2], l));
      continue;
    }
    // description line followed by quantity line
    if (/[A-Za-z]{3,}/.test(l) && !/\d+[.,]\d{2}\s*$/.test(l)) {
      const next = lines[i + 1] || "";
      const q = next.match(qtyLine);
      if (q) { const [unit, amount] = moneyTokens(next); items.push(item(l, Number(q[1]), unit, amount, `${l} | ${next}`)); i++; }
    }
  }
  // Post-pass: a VOID/REFUND line printed after an item cancels the nearest
  // preceding item whose description it repeats (or the immediately preceding item).
  for (let i = 0; i < lines.length; i++) {
    if (!VOID_RE.test(lines[i])) continue;
    const toks = norm(lines[i]).split(" ").filter((w) => w.length > 2 && !/^(void|voided|refund|return|reversal|cancel|cancelled)$/.test(w));
    let target = null;
    for (let j = items.length - 1; j >= 0; j--) {
      const d = norm(items[j].description).split(" ");
      if (toks.some((t) => d.includes(t))) { target = items[j]; break; }
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
    const score = aliasFull ? 1 : Number((0.4 * r + 0.6 * local).toFixed(2));
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
