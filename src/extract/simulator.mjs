import { ReceiptExtractor } from "./receipt-extractor.mjs";

/**
 * Simulator extractor (dev + tests): the fixture PNG carries an embedded JSON
 * receipt fact block (media.mjs encodeReceiptText). A vision provider would
 * implement the same contract by OCR-ing the image (see vision.mjs pattern).
 */
export class SimulatorExtractor extends ReceiptExtractor {
  constructor({ minConfidence = 0.9, model = "simulator-receipt-v1" } = {}) {
    super();
    this.minConfidence = minConfidence;
    this.model = model;
  }

  parseEmbedded(imageBytes) {
    const s = imageBytes.toString("latin1");
    const m = s.match(/WPP_RECEIVED:([A-Za-z0-9+/=]+):/);
    if (!m) return null;
    try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
    catch { return null; }
  }

  async extract({ imageBytes }) {
    const facts = this.parseEmbedded(imageBytes);
    if (!facts) {
      return {
        extracted: null,
        confidence: 0.01,
        provider: this.model,
        model: this.model,
        hint: "review_or_reupload",
        error: "no_text_detected",
      };
    }
    const confidence = Number(facts._confidence ?? 0.9);
    return {
      extracted: {
        outlet: facts.outlet || null,
        date: facts.date || null,
        receiptNo: facts.receiptNo || null,
        currency: facts.currency || "USD",
        total: Number(facts.total ?? 0),
        lineItems: Array.isArray(facts.lineItems) ? facts.lineItems : [],
      },
      confidence,
      provider: this.model,
      model: this.model,
      hint: confidence < this.minConfidence ? "review" : "decide",
      raw: facts,
    };
  }
}

/** Embed structured receipt facts into a synthetic PNG-suffix buffer. */
export function encodeReceiptFacts(facts) {
  const json = JSON.stringify(facts);
  const b64 = Buffer.from(json).toString("base64");
  return Buffer.from(`WPP_RECEIVED:${b64}:`, "latin1");
}