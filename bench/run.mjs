// Receipt benchmark (spec §20 "Receipt-quality evidence").
// Runs every fixture image through the REAL extractor (pixels -> OCR ->
// parser -> rules) and compares with the labelled manifest. The pipeline never
// sees the manifest. Output: JSON report + markdown summary.
// Usage: node bench/run.mjs [--extractor tesseract|vision] [--out docs/testing/evidence/receipt-benchmark.json]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, loadConfig } from "../src/config.mjs";
import { createExtractor } from "../src/extract/vision.mjs";
import { evaluateEligibility, defaultRules } from "../src/eligibility.mjs";
import { inspectImage, normaliseForOcr, qualitySignals, imageHashes, hamming } from "../src/media.mjs";
import { canonicalKeyOf } from "../src/duplicates.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const extractorName = opt("--extractor", "tesseract");
const outFile = opt("--out", null);

const FIX = path.join(ROOT, "fixtures", "receipts");
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.json"), "utf8"));

// Test campaign context (mirrors the seeded TEST ONLY campaign)
const outlets = [
  { id: "out_SUN-HRE-01", retailer: "Sunrise Supermarket", branch: "Westgate", town: "Harare", aliases_json: JSON.stringify(["sunrise westgate"]) },
  { id: "out_VAL-HRE-01", retailer: "Valuemart", branch: "Westgate", town: "Harare", aliases_json: "[]" },
  { id: "out_KWK-HRE-01", retailer: "Kwikshop Express", branch: "Westgate", town: "Harare", aliases_json: "[]" },
];
const selectedFor = (id) => id.includes("-B") ? "out_VAL-HRE-01" : id.includes("-C") || id.startsWith("two-kg") ? "out_KWK-HRE-01" : "out_SUN-HRE-01";
const rules = defaultRules({ products: [{ code: "GC-BS-2KG", name: "Goldcane Brown Sugar 2kg", aliases: ["goldcane brown sugar", "brown sugar 2kg"], pack_grams: 2000, qualifying: true }, { code: "GC-BS-1KG", name: "Goldcane Brown Sugar 1kg", aliases: ["brown sugar 1kg"], pack_grams: 1000, qualifying: true }] });
const context = { windowStart: "2026-09-28T00:00:00Z", windowEnd: "2026-11-23T00:00:00Z", campaignOpen: true, enrolled: true };

/**
 * Verdict for ONE fixture, given what the pipeline produced for it.
 * The reason code is part of the contract, not decoration: a receipt refused
 * as `no_qualifying_product` when it is actually outside the campaign window
 * tells the participant the wrong thing and routes the review queue wrongly,
 * so a reason mismatch must FAIL even when the disposition happens to match.
 * (The manifest declares a reason for ten fixtures; it was printed on every
 * result line but never compared.)
 */
export function fixturePass(f, obs) {
  const expect = f.expect || {};
  const expected = String(expect.disposition || "").split("|");
  const dupOf = f.duplicateOf || expect.duplicateOf || null;
  const dupBy = obs.dupBy || [];
  return (expect.neverQualify ? obs.standalone !== "QUALIFIED" : expected.includes(obs.standalone))
    && (dupOf ? (obs.disposition === "DUPLICATE" || (dupBy.length === 0 && obs.standalone !== "QUALIFIED")) : obs.disposition === obs.standalone)
    && (expect.document ? expect.document === obs.document : true)
    && (expect.packs == null || expect.packs === obs.packs)
    && (expect.receiptNo == null || expect.receiptNo === obs.receiptNo)
    && (expect.date == null || expect.date === obs.date)
    && (expect.reason == null || expect.reason === obs.reason);
}

/**
 * Exit code for the release gate (`npm run ci` runs this benchmark, and the
 * rollout checklist requires it green). Only a false ACCEPT used to fail the
 * run: a parser regression that rejected every genuine receipt printed 40 FAIL
 * lines, wrote failed:40 / false_rejects:19 into the evidence file and still
 * exited 0, so the checklist passed on a broken build. Any failed fixture — a
 * false reject above all — now fails the gate; 2 is kept for false accepts so
 * existing tooling can still tell the two apart.
 */
export function gateExitCode(totals) {
  if ((totals.false_accepts || []).length) return 2;
  if (totals.failed || (totals.false_rejects || []).length) return 1;
  return 0;
}

const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const extractor = createExtractor({ ...loadConfig({}), receiptExtractor: extractorName });
  const results = [];
  const seen = [];
  for (const f of manifest.fixtures) {
    const bytes = fs.readFileSync(path.join(FIX, f.file));
    const t0 = Date.now();
    let row = { id: f.id, expect: f.expect };
    try {
      const info = await inspectImage(bytes);
      const quality = await qualitySignals(bytes);
      const hashes = await imageHashes(bytes);
      const normalised = await normaliseForOcr(bytes);
      const x = await extractor.extract({ imageBytes: bytes, normalisedBytes: normalised, context: { outlets, dateOrder: "DMY", quality } });
      const sel = selectedFor(f.id);
      const v = evaluateEligibility(x, rules, { ...context, selectedOutletId: sel, selectedOutletParticipating: true, imageQuality: quality });
      const key = canonicalKeyOf({ outletId: sel, date: x.transaction.date, receiptNo: x.transaction.receiptNo, totalMinor: x.transaction.totalMinor });
      // duplicate signals against fixtures already processed
      const dupBy = seen.filter((s) => s.key && s.key === key).map((s) => s.id);
      const near = seen.filter((s) => hamming(s.hashes.phash, hashes.phash) <= 10 || hamming(s.hashes.dhash, hashes.dhash) <= 10).map((s) => s.id);
      seen.push({ id: f.id, key, hashes });
      const disposition = dupBy.length ? "DUPLICATE" : v.disposition;
      row = { ...row, format: info.format, ms: Date.now() - t0, ocrMs: x.latencyMs, document: x.document.kind, docScore: x.document.score, receiptNo: x.transaction.receiptNo, date: x.transaction.date, totalMinor: x.transaction.totalMinor, packs: v.primaryPacks, grams: v.totalGrams, disposition, reason: v.reason, canonicalDupOf: dupBy, nearHash: near, ocrConfidence: x.quality.confidence, quality,
        standalone: v.disposition,
        pass: fixturePass(f, { disposition, standalone: v.disposition, reason: v.reason, document: x.document.kind, packs: v.primaryPacks, receiptNo: x.transaction.receiptNo, date: x.transaction.date, dupBy }) };
    } catch (e) { row = { ...row, error: e.message, pass: false, disposition: "ERROR" }; }
    results.push(row);
    console.error(`${row.pass ? "PASS" : "FAIL"} ${f.id.padEnd(26)} -> ${row.disposition}${row.standalone && row.standalone !== row.disposition ? ` (standalone ${row.standalone})` : ""} ${row.reason || ""} (${row.ms}ms) expected ${f.expect.disposition}${f.duplicateOf ? ` dup-of ${f.duplicateOf}` : ""}`);
  }
  await extractor.close?.();

  const auto = results.filter((r) => r.disposition === "QUALIFIED");
  const falseAccept = results.filter((r) => r.disposition === "QUALIFIED" && (!String(r.expect.disposition).includes("QUALIFIED") || r.expect.neverQualify || manifest.fixtures.find((f) => f.id === r.id)?.duplicateOf));
  // A false reject is the rules verdict on the fixture's own merits (not the
  // duplicate layer's relabelling), so a genuine two-pack that the parser starts
  // refusing is still counted when its manifest row lists alternatives.
  const falseReject = results.filter((r) => r.standalone === "NOT_QUALIFIED" && !r.expect?.neverQualify && String(r.expect?.disposition || "").split("|").includes("QUALIFIED"));
  const review = results.filter((r) => r.disposition === "REVIEW_REQUIRED" || r.disposition === "REUPLOAD_REQUIRED");
  const lat = results.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b);
  const report = {
    generated_at: new Date().toISOString(), extractor: extractor.name, mode: extractor.mode, corpus: { size: results.length, provenance: "synthetic fictional fixtures (scripts/gen-fixtures.mjs); NOT client receipts", split: "all held-out: parser/rules were written before these images were rendered; duplicate variants grouped with their source" },
    totals: { passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, auto_qualified: auto.length, false_accepts: falseAccept.map((r) => r.id), false_rejects: falseReject.map((r) => r.id), review_rate: Number((review.length / results.length).toFixed(2)), p50_ms: lat[Math.floor(lat.length * 0.5)], p95_ms: lat[Math.floor(lat.length * 0.95)] },
    by_layout: ["A", "B", "C"].map((L) => { const rs = results.filter((r) => manifest.fixtures.find((f) => f.id === r.id)?.spec?.layout === L); return { layout: L, n: rs.length, passed: rs.filter((r) => r.pass).length }; }),
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, json); console.error(`wrote ${outFile}`); }
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  process.exit(gateExitCode(report.totals));
}
