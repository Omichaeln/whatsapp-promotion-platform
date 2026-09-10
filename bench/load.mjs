// Engineering load benchmark (spec §18). Declared assumptions (D-21, NOT a
// client forecast): 5k registrations, 20k receipts over 8 weeks, peak 200
// receipts/hour with bursts of 20 concurrent uploads. This harness drives the
// real HTTP webhook + durable intake + worker + REAL OCR on one machine and
// reports webhook ack latency, decision latency, throughput and integrity.
// Usage: node bench/load.mjs [--receipts 60] [--concurrency 10] [--out file.json]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/server.mjs";
import { loadConfig, ROOT } from "../src/config.mjs";
import { ensureDemoSeed, fixtureBytes } from "../src/demo-seed.mjs";

const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("--receipts", 60)), C = Number(opt("--concurrency", 10)), outFile = opt("--out", null);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-load-"));
const cfg = loadConfig({ ENVIRONMENT: "test", DATABASE: path.join(dir, "load.db"), MEDIA_DIR: path.join(dir, "media"), PORT: "5777", HOST: "127.0.0.1", ADMIN_EMAIL: "load@x.test", ADMIN_PASSWORD: "LoadTestPassword123", IDENTITY_KEY: "load-key-0123456789", WHATSAPP_TRANSPORT: "simulator", RECEIPT_EXTRACTOR: "tesseract" });
const app = await createServer({ config: cfg, log: { log() {}, error() {}, warn() {} } });
ensureDemoSeed(app.db, { log: null }); await app.listen(); app.worker.start();
const base = `http://127.0.0.1:${cfg.port}`;
const fixtures = ["valid-two-pack-A", "valid-two-pack-B", "valid-two-pack-C", "one-pack", "wrong-sku", "valid-multi-line"].map((f) => fixtureBytes(f));
const t0 = Date.now(); const ackLat = []; const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;
async function hook(events, media) { const s = Date.now(); const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events, media }) }); ackLat.push(Date.now() - s); return r.json(); }
let seq = 0; const mid = () => `load_${++seq}`;
const settled = async (phone) => { for (let i = 0; i < 600; i++) { if (!app.db.prepare(`select count(*) n from channel_events where wa_phone_uid=? and status in ('received','processing')`).get(phone).n) return; await new Promise((r) => setTimeout(r, 100)); } };
async function participant(i) {
  const phone = `26377200${String(i).padStart(4, "0")}`;
  const alpha = (n) => String(n).split("").map((d) => "ABCDEFGHIJ"[Number(d)]).join("");   // names must be letters only
  for (const t of ["hi", "1", `Load${alpha(i)}`, "Tester", `TESTLOAD${i}X`, "Harare", "yes", "yes"]) await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: t }]);
  await settled(phone);   // webhook acks before processing: wait for the queued events of this phone to be handled
  if (!app.domain.getParticipantByPhone(phone)) throw new Error(`load harness: participant ${phone} did not register`);
  const per = Math.ceil(N / C);
  for (let k = 0; k < per; k++) {
    await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: "2" }]); await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: "sunrise westgate harare" }]); await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: "1" }]);
    // make each image unique bytes (append a marker) so canonical identity, not bytes, decides duplicates
    const img = Buffer.concat([fixtures[(i + k) % fixtures.length], Buffer.from(`#${i}-${k}`)]);
    const id = mid(); await hook([{ providerMessageId: id, phoneUid: phone, type: "message.image", text: "" }], { [id]: img.toString("base64") });
  }
}
await Promise.all(Array.from({ length: C }, (_, i) => participant(i + 1)));
const tIngest = Date.now();
// wait for the worker to finish all receipts
let pending = 1; while (pending) { await new Promise((r) => setTimeout(r, 500)); pending = app.db.prepare(`select count(*) n from receipts where status in ('received','processing','delayed')`).get().n + app.db.prepare(`select count(*) n from channel_events where status in ('received','processing')`).get().n; if (Date.now() - tIngest > 600_000) break; }
const tDone = Date.now();
const receipts = app.db.prepare(`select r.intake_at, r.decided_at, r.status from receipts r`).all();
const decLat = receipts.filter((r) => r.decided_at).map((r) => Date.parse(r.decided_at) - Date.parse(r.intake_at));
const byStatus = Object.fromEntries(app.db.prepare(`select status, count(*) n from receipts group by status`).all().map((r) => [r.status, r.n]));
const dupCheck = app.db.prepare(`select count(*) n from (select canonical_receipt_id, count(*) c from entries where status='active' group by canonical_receipt_id having c>1)`).get().n;
const report = {
  generated_at: new Date().toISOString(), machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 1e9), node: process.version },
  assumptions: { note: "engineering benchmark, NOT a client forecast (D-21)", receipts: N, concurrent_participants: C, extractor: "tesseract.js (real OCR, single WASM worker)", transport: "simulator (no provider latency)" },
  results: { inbound_events: app.db.prepare(`select count(*) n from channel_events`).get().n, ingest_seconds: Number(((tIngest - t0) / 1000).toFixed(1)), total_seconds: Number(((tDone - t0) / 1000).toFixed(1)), webhook_ack_ms: { p50: pct(ackLat, 0.5), p95: pct(ackLat, 0.95), max: Math.max(...ackLat) }, decision_ms_from_intake: { p50: pct(decLat, 0.5), p95: pct(decLat, 0.95), max: decLat.length ? Math.max(...decLat) : null }, receipts_per_minute: Number((receipts.length / ((tDone - t0) / 60000)).toFixed(1)), by_status: byStatus, double_credits: dupCheck, outbound: app.outbox.stats().byStatus, dead_letters: app.db.prepare(`select count(*) n from jobs where status='dead'`).get().n },
  bottleneck: "OCR is CPU-bound and serialised on one WASM worker (~1 s per clear image); scale by running N worker processes or a tesseract worker pool; webhook acknowledgement is independent of OCR (durable intake).",
};
if (receipts.length < N) report.error = `only ${receipts.length}/${N} receipts were created; harness or flow problem`;
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await app.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(report.results.double_credits || report.error ? 1 : 0);
