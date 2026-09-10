/**
 * ReceiptExtractor contract (spec §10). OCR/vision output is EVIDENCE only;
 * the deterministic eligibility engine or an authorised reviewer decides.
 *
 * extract({ imageBytes, normalisedBytes, context }) resolves to:
 * {
 *   schemaVersion: "receipt-extraction/2",
 *   provider, model, promptVersion,      // provenance
 *   latencyMs,
 *   ocrText,                              // raw text evidence (may be "")
 *   document: { kind: "receipt"|"non_receipt"|"unknown", score: 0..1, signals: {...} },
 *   merchant: { rawText, candidates: [{ outletId, score, basis }] },
 *   transaction: { receiptNo, receiptNoRaw, till, date, dateRaw, time, currency, totalMinor, totalRaw },
 *   lineItems: [{ rawText, description, quantity, unitPriceMinor, amountMinor, packGrams, voided, productMatch }],
 *   quality: { missing: [], warnings: [], confidence: number|null },
 *   raw: provider raw result (protected; not logged)
 * }
 * Unknown values are null — never guessed. Confidence is only present when the
 * engine actually supplies one, and is NOT treated as a calibrated probability.
 */
export const EXTRACTION_SCHEMA_VERSION = "receipt-extraction/2";

export class ReceiptExtractor {
  get name() { return "abstract"; }
  get mode() { return "unconfigured"; }   // real|simulated|unconfigured
  async extract() { throw new Error("not implemented"); }
  async health() { return { provider: this.name, mode: this.mode, ok: false }; }
}

export function emptyExtraction(provider, model, extra = {}) {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION, provider, model, promptVersion: null, latencyMs: 0,
    ocrText: "", document: { kind: "unknown", score: 0, signals: {} },
    merchant: { rawText: null, candidates: [] },
    transaction: { receiptNo: null, receiptNoRaw: null, till: null, date: null, dateRaw: null, time: null, currency: null, totalMinor: null, totalRaw: null },
    lineItems: [], quality: { missing: [], warnings: [], confidence: null }, raw: null, ...extra,
  };
}
