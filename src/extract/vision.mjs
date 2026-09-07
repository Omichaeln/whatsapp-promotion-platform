import { ReceiptExtractor } from "./receipt-extractor.mjs";
import { SimulatorExtractor } from "./simulator.mjs";

/**
 * Vision extractor (G-07, P0-04) — production path behind the ReceiptExtractor
 * contract. Uses an OpenAI-compatible vision endpoint when configured.
 *
 * Until a real provider endpoint + labelled corpus are supplied (D-16/G-07),
 * this implementation FAILS CLOSED: it never qualifies anything and routes
 * every receipt to review with a transparent reason. Selecting
 * RECEIPT_EXTRACTOR=vision without a key or endpoint keeps that guarantee.
 */
export class VisionExtractor extends ReceiptExtractor {
  constructor({ apiKey = "", baseUrl = "https://api.openai.com/v1", model = "gpt-4o", minConfidence = 0.9 } = {}) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.minConfidence = minConfidence;
  }

  get configured() { return !!this.apiKey; }

  async extract({ imageBytes, mediaAssetId, selectedOutletId }) {
    if (!this.configured) {
      // Fail closed: no key -> review with an honest reason, zero confidence.
      return {
        extracted: null,
        confidence: 0,
        provider: "vision",
        model: this.model,
        hint: "review",
        error: "vision extractor not configured (RECEIPT_PROVIDER_OPENAI_API_KEY missing); routed to review by design",
      };
    }
    // Real implementation: base64 the image, call chat completions with a
    // vision message, parse a strict JSON payload (fields per contract 12.3),
    // return { extracted, confidence, provider, model, evidence }.
    // Not reachable until a provider key + labelled corpus are supplied.
    return {
      extracted: null,
      confidence: 0,
      provider: "vision",
      model: this.model,
      hint: "review",
      error: "vision extractor endpoint not yet implemented (blocked on D-16 / G-07 corpus)",
    };
  }
}

/** Select the extractor from configuration (P0-04: config was ignored before). */
export function createExtractor(cfg) {
  const mode = String(cfg?.receiptExtractor || "simulator").toLowerCase();
  const v = cfg?.receipt || {};
  if (mode === "vision") {
    return new VisionExtractor({
      apiKey: v.openaiApiKey || "",
      baseUrl: v.baseUrl,
      model: v.openaiModel || "gpt-4o",
      minConfidence: Number(v.autoQualifyMinConfidence || 0.9),
    });
  }
  // simulator | none | anything-else -> the deterministic simulator (dev/tests).
  return new SimulatorExtractor({ minConfidence: Number(v.autoQualifyMinConfidence || 0.6) });
}