// Labelled receipt corpus benchmark harness (spec G-07 / 17.2).
// Extends the simulator/vision extractor with a deterministic label set and
// reports precision/recall/latency/review-rate per retailer format. The
// production extractor must be benchmarked on the real client corpus before
// launch; this harness proves the reporting contract.
// Usage: node bench/run.mjs [--format table]
import { SimulatorExtractor, encodeReceiptFacts } from "../src/extract/simulator.mjs";

const extractor = new SimulatorExtractor({ minConfidence: 0.6 });

// Labelled corpus: { id, format (retailer), label: qualify|reject|review, facts? }
const corpus = [
  { id: "ok-01", format: "OK Mart", label: "qualify", facts: { outlet: "OK-HRE-01", date: "2026-10-05", receiptNo: "R-01", total: 10, _confidence: 0.95, lineItems: [{ description: "ZimSweet Brown Sugar 2kg", quantity: 2 }] } },
  { id: "ok-02", format: "OK Mart", label: "qualify", facts: { outlet: "OK-HRE-01", date: "2026-10-06", receiptNo: "R-02", total: 9, _confidence: 0.9, lineItems: [{ description: "brown sugar 2kg x2", quantity: 2 }] } },
  { id: "tm-01", format: "TM", label: "reject", facts: { outlet: "TM-HRE-01", date: "2026-10-05", receiptNo: "R-03", total: 4, _confidence: 0.9, lineItems: [{ description: "bread", quantity: 1 }] } },
  { id: "ss-01", format: "Spar", label: "review", facts: { outlet: "SSC-BUL-01", date: "", receiptNo: "", total: 0, _confidence: 0.2, lineItems: [] } },
  { id: "ss-02", format: "Spar", label: "reject", facts: { outlet: "SSC-BUL-01", date: "2026-10-07", receiptNo: "R-04", total: 3, _confidence: 0.85, lineItems: [{ description: "ZimSweet Brown Sugar 2kg", quantity: 1 }] } },
];

async function run() {
  const results = [];
  for (const c of corpus) {
    const t0 = Date.now();
    const out = await extractor.extract({ imageBytes: c.facts ? encodeReceiptFacts(c.facts) : Buffer.from("noise") });
    const latencyMs = Date.now() - t0;
    const extracted = out.extracted;
    // deterministic proxy decision (mirror of eligibility for the benchmark)
    const qualifies = Array.isArray(extracted?.lineItems) && extracted.lineItems.some((li) => {
      const desc = String(li.description || "").toLowerCase();
      return desc.includes("brown sugar") && Number(li.quantity) >= 2;
    });
    const decision = out.confidence < 0.25 ? "review" : qualifies ? "qualify" : "reject";
    results.push({ id: c.id, format: c.format, label: c.label, decision, latencyMs, confidence: out.confidence });
  }
  const tp = results.filter((r) => r.label === "qualify" && r.decision === "qualify").length;
  const fp = results.filter((r) => r.label !== "qualify" && r.decision === "qualify").length;
  const fn = results.filter((r) => r.label === "qualify" && r.decision !== "qualify").length;
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const reviewRate = results.filter((r) => r.decision === "review").length / results.length;
  const p95ms = results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.95)];
  console.log(JSON.stringify({ corpus: results.length, precision, recall, reviewRate, p95LatencyMs: p95ms, results }, null, 2));
}

await run();