// Engineering load benchmark (spec §18). Declared assumptions (D-21, NOT a
// client forecast): 5k registrations, 20k receipts over 8 weeks, peak 200
// receipts/hour with bursts of 20 concurrent uploads. This harness drives the
// real HTTP webhook + durable intake + worker + REAL OCR on one machine and
// reports webhook ack latency, decision latency, throughput and integrity.
// Usage: node bench/load.mjs [--receipts 60] [--concurrency 10] [--out file.json]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { ensureDemoSeed } from "../src/demo-seed.mjs";
import { receiptText, render } from "../scripts/gen-fixtures.mjs";

const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt("--receipts", 60)), C = Number(opt("--concurrency", 10)), outFile = opt("--out", null);

const SUGAR = (qty, unit) => ({ desc: "GOLDCANE BROWN SUGAR 2KG", qty, unit });
const BREAD = { desc: "BREAD WHITE 700G", qty: 1, unit: 1.2 };
const BRANCH = "Westgate Branch, Harare";
// The printed merchant must match the outlet the participant selects, or the
// rules route the receipt to review (outlet_selection_mismatch) and it never
// reaches the award path — which is what happened when every layout was
// submitted against the Sunrise branch.
const OUTLET_QUERY = { A: "sunrise westgate harare", B: "valuemart westgate harare", C: "kwikshop westgate harare" };
/** The one printed slip EVERY participant submits first (the concurrent canonical-claim race). */
export const RACE_SLIP = { no: "990100", date: "05/10/2026", unit: 3.1 };

/**
 * The printed receipt number for participant `i`'s upload `n`.
 *
 * `700000 + i * 100 + n` only stayed unique while a participant uploaded fewer
 * than 100 slips (per = ceil(N/C)): at --receipts 600 --concurrency 2 the
 * numbers of participants 1 and 2 overlapped, so the same number, date, layout
 * and outlet were printed for two phones and the slip silently became a
 * CROSS-PARTICIPANT duplicate — the run still gated green but the cohort counts
 * in the report described a corpus that was not the one submitted. A block of
 * 10 000 per participant, and a loud failure rather than a silent overlap if a
 * run ever exhausts it or reaches the shared race slip.
 */
export function slipNo(i, n) {
  const no = String(700000 + i * 10000 + n);
  if (n >= 10000 || no === RACE_SLIP.no) throw new Error(`load harness: slip number space exhausted at participant ${i}, upload ${n} (${no})`);
  return no;
}

/**
 * The receipt participant `i` submits on upload `k` of `per`, rendered fresh.
 *
 * Every participant used to cycle the SAME six fixture images, so all but the
 * first presentation of each was a duplicate: the committed evidence shows 2 of
 * 30 receipts reaching the award path, which means the decision percentiles
 * measured duplicate rejection rather than OCR + rules + awarding. Uploads are
 * now unique purchases (they award), except k=0, which is one shared slip so
 * the concurrent claim on a single canonical identity is still exercised, and
 * the last upload, which repeats this participant's own first unique slip.
 */
export async function loadReceipt(i, k, per) {
  // trailing marker: unique BYTES for every upload (decoders ignore data after
  // the JPEG end marker) so the canonical identity, not the image hash, is what
  // decides the duplicates below — the layer the race is about.
  const unique = (buf) => Buffer.concat([buf, Buffer.from(`#${i}-${k}`)]);
  if (k === 0) {
    const lines = receiptText({ layout: "A", branch: BRANCH, time: "14:22", no: RACE_SLIP.no, date: RACE_SLIP.date, items: [SUGAR(2, RACE_SLIP.unit), BREAD] });
    return { cohort: "race", no: RACE_SLIP.no, outletQuery: OUTLET_QUERY.A, bytes: unique(await render(lines)) };
  }
  const n = (per > 2 && k === per - 1) ? 1 : k;                    // last upload = this participant's own slip again
  const layout = ["A", "B", "C"][(i + n) % 3];
  const no = slipNo(i, n);
  const date = `${String(5 + (n % 5)).padStart(2, "0")}/10/2026`;
  const lines = receiptText({ layout, branch: BRANCH, time: "14:22", no, date, items: [SUGAR(2, 3.1 + (n % 4) * 0.05), BREAD] });
  return { cohort: n === k ? "unique" : "self_duplicate", no, outletQuery: OUTLET_QUERY[layout], bytes: unique(await render(lines)) };
}

/**
 * Integrity of the run: has any single PURCHASE been credited more than once?
 *
 * The old check counted two active entries sharing one canonical_receipt_id — a
 * shape `create unique index uq_entries_canonical` already forbids, so it read
 * 0 on every possible run and the only gate on this harness could never trip.
 * The shape that actually double-credits is one physical slip that minted TWO
 * canonical identities (concurrent OCR reading the total differently, or a
 * second outlet selection) with an entry under each, so group the entries by
 * the printed identity — outlet + date + receipt number, never the total —
 * exactly as the duplicate resolver does. `double_qualified` catches the other
 * half: one receipt decided QUALIFIED twice (receipts.status is overwritten per
 * decision, so validation_results is where a second award is visible).
 *
 * WHAT THIS CANNOT SEE, AND WHAT IT THEREFORE DOES NOT FAIL A RUN ON. Rows
 * whose printed identity is incomplete (the date or the receipt number was never
 * read — the review path can credit such a row) used to be dropped from the
 * grouping entirely, which is the very shape the race produces when one
 * concurrent worker reads the slip less well than the other. They are grouped
 * now, on the only evidence such a row carries: outlet, whatever of date/number
 * was read, and the TOTAL (a row with neither a number nor a total can be
 * matched to nothing, so it stands alone). But that evidence cannot tell one
 * purchase credited twice from TWO REAL PURCHASES at the same outlet, on the
 * same day, for the same total — the shapes are identical once the number is
 * gone — so such a group is reported as `suspected_double_credits` and is NOT
 * part of `double_credits`, which is what the gate exits on. Grouping them into
 * the gate made `node bench/load.mjs` exit 1 on a corpus with nothing wrong in
 * it. The MIXED pair — one row with the number, one without — cannot be grouped
 * at all, for the same reason. `unidentified_credits` counts every row with an
 * incomplete identity so both residual blind spots are numbers in the report
 * rather than silences.
 */
export function integrityFindings(db) {
  const groups = db.prepare(`select cr.campaign_id, cr.outlet_id, coalesce(cr.txn_date, '?') as txn_date,
      coalesce(cr.receipt_no_norm, upper(cr.receipt_no)) as no,
      case when cr.txn_date is null or coalesce(cr.receipt_no_norm, cr.receipt_no) is null
           then coalesce(cast(cr.total_minor as text), 'row:' || cr.id) else '' end as tie,
      count(*) c, group_concat(e.id) entries
    from entries e join canonical_receipts cr on cr.id = e.canonical_receipt_id
    where e.status = 'active'
    group by cr.campaign_id, cr.outlet_id, txn_date, no, tie having c > 1`).all();
  // `tie` is non-empty exactly when the printed identity is incomplete, i.e.
  // when the grouping rests on the total and cannot distinguish one purchase
  // from two. Those groups are evidence for a human, never a gate failure.
  const purchases = groups.filter((g) => g.tie === "");
  const suspected = groups.filter((g) => g.tie !== "");
  const qualifiedTwice = db.prepare(`select receipt_id, count(*) c from validation_results where decision = 'QUALIFIED' group by receipt_id having c > 1`).all();
  const unidentified = db.prepare(`select count(*) n from entries e join canonical_receipts cr on cr.id = e.canonical_receipt_id
    where e.status = 'active' and (cr.txn_date is null or coalesce(cr.receipt_no_norm, cr.receipt_no) is null)`).get().n;
  return {
    double_credits: purchases.length,
    suspected_double_credits: suspected.length,
    double_qualified: qualifiedTwice.length,
    unidentified_credits: unidentified,
    detail: { purchases: purchases.slice(0, 5), suspected: suspected.slice(0, 5), receipts: qualifiedTwice.slice(0, 5).map((r) => r.receipt_id) },
  };
}

const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-load-"));
  const cfg = loadConfig({ ENVIRONMENT: "test", DATABASE: path.join(dir, "load.db"), MEDIA_DIR: path.join(dir, "media"), PORT: "5777", HOST: "127.0.0.1", ADMIN_EMAIL: "load@x.test", ADMIN_PASSWORD: "LoadTestPassword123", IDENTITY_KEY: "load-key-0123456789", WHATSAPP_TRANSPORT: "simulator", RECEIPT_EXTRACTOR: "tesseract" });
  const app = await createServer({ config: cfg, log: { log() {}, error() {}, warn() {} } });
  ensureDemoSeed(app.db, { log: null }); await app.listen(); app.worker.start();
  const base = `http://127.0.0.1:${cfg.port}`;
  const t0 = Date.now(); const ackLat = []; const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;
  const cohorts = {};
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
      const slip = await loadReceipt(i, k, per);
      await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: "2" }]); await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: slip.outletQuery }]); await hook([{ providerMessageId: mid(), phoneUid: phone, type: "message.text", text: "1" }]);
      cohorts[slip.cohort] = (cohorts[slip.cohort] || 0) + 1;
      const id = mid(); await hook([{ providerMessageId: id, phoneUid: phone, type: "message.image", text: "" }], { [id]: slip.bytes.toString("base64") });
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
  const integrity = integrityFindings(app.db);
  const report = {
    generated_at: new Date().toISOString(), machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, mem_gb: Math.round(os.totalmem() / 1e9), node: process.version },
    assumptions: { note: "engineering benchmark, NOT a client forecast (D-21)", receipts: N, concurrent_participants: C, extractor: "tesseract.js (real OCR, single WASM worker)", transport: "simulator (no provider latency)", corpus: "freshly rendered receipts: one shared slip per participant (concurrent claim race), the rest unique purchases, the last a repeat of the participant's own slip", cohorts },
    results: { inbound_events: app.db.prepare(`select count(*) n from channel_events`).get().n, ingest_seconds: Number(((tIngest - t0) / 1000).toFixed(1)), total_seconds: Number(((tDone - t0) / 1000).toFixed(1)), webhook_ack_ms: { p50: pct(ackLat, 0.5), p95: pct(ackLat, 0.95), max: Math.max(...ackLat) }, decision_ms_from_intake: { p50: pct(decLat, 0.5), p95: pct(decLat, 0.95), max: decLat.length ? Math.max(...decLat) : null }, receipts_per_minute: Number((receipts.length / ((tDone - t0) / 60000)).toFixed(1)), by_status: byStatus, double_credits: integrity.double_credits, suspected_double_credits: integrity.suspected_double_credits, double_qualified: integrity.double_qualified, unidentified_credits: integrity.unidentified_credits, integrity_detail: integrity.detail, outbound: app.outbox.stats().byStatus, dead_letters: app.db.prepare(`select count(*) n from jobs where status='dead'`).get().n },
    bottleneck: "OCR is CPU-bound and serialised on one WASM worker (~1 s per clear image); scale by running N worker processes or a tesseract worker pool; webhook acknowledgement is independent of OCR (durable intake).",
  };
  if (receipts.length < N) report.error = `only ${receipts.length}/${N} receipts were created; harness or flow problem`;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await app.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(report.results.double_credits || report.results.double_qualified || report.error ? 1 : 0);
}
