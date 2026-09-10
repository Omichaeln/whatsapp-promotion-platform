import { ReceiptExtractor, EXTRACTION_SCHEMA_VERSION } from "./receipt-extractor.mjs";
import { parseReceiptText } from "./parse-receipt.mjs";

/**
 * SIMULATED extractor — TEST ONLY. Reads a text block embedded in the upload
 * bytes (`WPP_TEXT:<base64 receipt text>:`) instead of pixels. It exists so
 * unit tests for the rules/ledger/draw layers can run without OCR latency.
 * The production activation validator rejects this extractor (mode
 * "simulated"), and the readiness page labels it. It must never be used as
 * evidence of receipt processing.
 */
export class SimulatorExtractor extends ReceiptExtractor {
  get name() { return "simulator"; }
  get mode() { return "simulated"; }
  async extract({ imageBytes, context = {} }) {
    const s = Buffer.from(imageBytes).toString("latin1");
    const m = s.match(/WPP_TEXT:([A-Za-z0-9+/=]+):/);
    const text = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
    const parsed = parseReceiptText(text, { outlets: context.outlets || [], dateOrder: context.dateOrder || "DMY", quality: context.quality || {} });
    return { schemaVersion: EXTRACTION_SCHEMA_VERSION, provider: this.name, model: "simulator/2", promptVersion: "parser/2", latencyMs: 0, ...parsed, raw: { simulated: true } };
  }
  async health() { return { provider: this.name, mode: "simulated", ok: true, note: "TEST ONLY — does not read pixels" }; }
}

/** Test helper: embed receipt TEXT (not facts) so the same parser runs. */
export function encodeReceiptText(text) {
  return Buffer.from(`WPP_TEXT:${Buffer.from(text, "utf8").toString("base64")}:`, "latin1");
}
