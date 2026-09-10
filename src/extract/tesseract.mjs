import path from "node:path";
import { createRequire } from "node:module";
import { ReceiptExtractor, emptyExtraction, EXTRACTION_SCHEMA_VERSION } from "./receipt-extractor.mjs";
import { parseReceiptText } from "./parse-receipt.mjs";
import { normaliseForOcr } from "../media.mjs";

const require = createRequire(import.meta.url);

/**
 * Real, offline OCR extractor: tesseract.js (WASM Tesseract 5) with the
 * English model bundled from npm (@tesseract.js-data/eng). Reads the actual
 * pixels of every upload through the normal pipeline — no fixture lookup, no
 * filename or hash rules. Works on Railway/Nixpacks without system packages.
 *
 * Bounded: one worker, per-call timeout, image already size-bounded by
 * media.mjs. Recognised text is parsed deterministically (parse-receipt.mjs).
 * Tesseract's word confidence is recorded as `quality.confidence` for
 * information only; it is not a calibrated probability and never qualifies
 * a receipt by itself.
 */
export class TesseractExtractor extends ReceiptExtractor {
  constructor({ timeoutMs = 45_000, langPath = null, log = console } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.langPath = langPath || path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    this.log = log;
    this.worker = null;
    this.version = null;
    this.busy = Promise.resolve();
  }
  get name() { return "tesseract.js"; }
  get mode() { return "real"; }

  async ensureWorker() {
    if (this.worker) return this.worker;
    const { createWorker } = await import("tesseract.js");
    this.version = require("tesseract.js/package.json").version;
    this.worker = await createWorker("eng", 1, { langPath: this.langPath, cachePath: this.langPath, gzip: true, logger: () => {} });
    await this.worker.setParameters({ preserve_interword_spaces: "1" });
    return this.worker;
  }

  async recognise(pngBytes) {
    const w = await this.ensureWorker();
    // serialise: one WASM worker
    const run = this.busy.then(async () => {
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ocr timeout")), this.timeoutMs); });
      try { return await Promise.race([w.recognize(pngBytes), timeout]); }
      finally { clearTimeout(timer); }
    });
    this.busy = run.catch(() => {});
    return run;
  }

  async extract({ imageBytes, normalisedBytes, context = {} }) {
    const t0 = Date.now();
    const model = `tesseract.js@${this.version || "?"}/eng-best-int`;
    let png = normalisedBytes;
    try { if (!png) png = await normaliseForOcr(imageBytes); }
    catch (e) { return emptyExtraction(this.name, model, { latencyMs: Date.now() - t0, quality: { missing: ["image"], warnings: [`normalise_failed:${e.message}`], confidence: null }, document: { kind: "unknown", score: 0, signals: { error: "normalise_failed" } } }); }
    let data, parsed, rotation = 0;
    const parse = (text) => parseReceiptText(text || "", { outlets: context.outlets || [], dateOrder: context.dateOrder || "DMY", quality: context.quality || {} });
    try {
      const t1 = Date.now();
      ({ data } = await this.recognise(png));
      parsed = parse(data.text);
      // Bounded orientation retry: receipts photographed sideways have no EXIF
      // orientation. Only when the upright pass does not look like a receipt
      // AND was cheap (noise images are slow and never improve by rotating).
      if (parsed.document.kind !== "receipt" && Date.now() - t1 < 8000) {
        const sharp = (await import("sharp")).default;
        for (const deg of [90, 270]) {
          const rotated = await sharp(png).rotate(deg).png().toBuffer();
          const alt = await this.recognise(rotated);
          const altParsed = parse(alt.data.text);
          if (altParsed.document.score > parsed.document.score) { data = alt.data; parsed = altParsed; rotation = deg; }
          if (parsed.document.kind === "receipt") break;
        }
      }
    } catch (e) {
      const err = new Error(`ocr failed: ${e.message}`); err.code = "OCR_UNAVAILABLE"; err.transient = true; throw err;
    }
    return {
      schemaVersion: EXTRACTION_SCHEMA_VERSION, provider: this.name, model, promptVersion: "parser/2", latencyMs: Date.now() - t0,
      ...parsed,
      quality: { ...parsed.quality, confidence: Number.isFinite(data.confidence) ? Number((data.confidence / 100).toFixed(2)) : null },
      raw: { engine: "tesseract.js", confidence: data.confidence, textLength: (data.text || "").length, rotation },
    };
  }

  async health() {
    try { await this.ensureWorker(); return { provider: this.name, mode: "real", ok: true, model: `tesseract.js@${this.version}` }; }
    catch (e) { return { provider: this.name, mode: "real", ok: false, error: e.message }; }
  }
  async close() { try { await this.worker?.terminate(); } catch { /* ignore */ } this.worker = null; }
}
