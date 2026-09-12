// Regression tests for the extraction/media audit package.
//   extract-2  a failing OCR worker must fail ONE receipt, never the process
//   extract-3  one worker per extractor; a discarded worker is rebuilt
//   extract-4  a timed-out job must not keep the worker for the next receipt
//   extract-5  perceptual hashes must not report unrelated receipts as duplicates
//   extract-7  every value from the vision provider is type-checked before use
//   extract-8  the rotation-retry budget measures OCR, not time spent queueing
//   extract-9  media reuse is scoped to the campaign and to bytes still on disk
import fs from "node:fs";
import path from "node:path";
import { describe, it, before, after, assert, buildApp, sharp, ROOT } from "./helpers.mjs";
import { TesseractExtractor } from "../src/extract/tesseract.mjs";
import { VisionExtractor } from "../src/extract/vision.mjs";
import { imageHashes, hamming, PROBABLE_DUPLICATE_DIST, normaliseForOcr } from "../src/media.mjs";

const FIXTURES = path.join(ROOT, "fixtures/receipts");
const fixture = (id) => fs.readFileSync(path.join(FIXTURES, `${id}.jpg`));

/** A worker with tesseract's api shape whose recognition takes a known time. */
function fakeWorker(ms) {
  const w = {
    calls: 0, terminated: 0, finished: 0,
    recognize() {
      w.calls++;
      return new Promise((resolve) => setTimeout(() => { w.finished++; resolve({ jobId: `j${w.calls}`, data: { text: "SUNRISE SUPERMARKET", confidence: 80 } }); }, ms));
    },
    terminate() { w.terminated++; return Promise.resolve(); },
    async setParameters() {},
  };
  return w;
}
/** Extractor whose worker is a stub, rebuilt the same way the real one is. */
function stubbed(ms, opts = {}) {
  const x = new TesseractExtractor({ log: { warn() {}, error() {} }, ...opts });
  const made = [];
  x.ensureWorker = async () => { if (!x.worker) { x.worker = fakeWorker(ms); made.push(x.worker); } return x.worker; };
  return { x, made };
}

describe("extract: OCR worker failures are contained and the worker is never shared with a zombie job", () => {
  let x;
  before(() => { x = new TesseractExtractor({ log: { warn() {}, error() {} } }); });
  after(async () => { await x.close(); });

  it("extract-3: concurrent callers get ONE worker (a probe racing the first receipt leaked a 56 MB thread per call)", async () => {
    const [a, b, c] = await Promise.all([x.ensureWorker(), x.ensureWorker(), x.ensureWorker()]);
    assert.equal(a, b, "the second caller must get the worker the first one built");
    assert.equal(b, c);
    assert.equal(x.worker, a, "and the extractor must hold the same one (the losers were leaked, unreachable by close())");
  });

  it("extract-2: an image the engine cannot read fails that call instead of killing the process", async () => {
    // Pre-fix this did not reject at all: tesseract.js rethrew the worker's
    // rejection on the parent's message handler (createWorker.js:217), outside
    // any caller's try/catch, and node exited 1 — taking the HTTP server, the
    // job worker mid-lease and the outbox mid-send with it.
    await assert.rejects(() => x.recognise(Buffer.from("this is not an image")), (e) => e instanceof Error && !!e.message, "the caller must see the failure");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(true, "still running");
  });

  it("extract-2: an error event on the worker thread rejects the in-flight receipt and drops the worker", async () => {
    const png = await normaliseForOcr(fixture("valid-two-pack-A"));
    const w = await x.ensureWorker();
    const inFlight = x.recognise(png);
    await new Promise((r) => setTimeout(r, 120));   // let the image reach the worker
    const started = Date.now();
    // Node reports an uncaught exception inside the thread (ERR_WORKER_OUT_OF_MEMORY
    // included) as an 'error' EVENT. tesseract.js only sets `worker.onerror`,
    // which registers no listener on a worker_threads Worker, so EventEmitter
    // rethrew it in the parent: emitting it used to throw right here.
    w.worker.emit("error", new Error("simulated worker crash"));
    await assert.rejects(() => inFlight, /simulated worker crash/, "the receipt waiting on that worker must fail fast");
    assert.ok(Date.now() - started < 20_000, "and not hang until the 45s timeout");
    assert.equal(x.worker, null, "the dead worker must not be handed to the next receipt");
  });

  it("extract-3: the next receipt rebuilds the worker and OCR still reads the pixels", async () => {
    const png = await normaliseForOcr(fixture("valid-two-pack-A"));
    const r = await x.recognise(png);
    assert.match(r.data.text, /SUNRISE/, "OCR must recover after the worker was discarded");
    assert.ok(Number.isFinite(r.engineMs));
    assert.equal((await x.health()).ok, true);
  });
});

describe("extract: timeouts, serialisation and the retry budget", () => {
  it("extract-4: a timed-out job does not keep the worker — the next receipt gets a fresh one", async () => {
    const { x, made } = stubbed(400, { timeoutMs: 60 });
    await assert.rejects(() => x.recognise(Buffer.from("x")), /ocr timeout/);
    assert.equal(x.worker, null, "a timed-out worker is still running the old image; keeping it poisons the next receipt");
    assert.equal(made[0].terminated, 1, "and the abandoned worker must be terminated, not leaked");
    x.timeoutMs = 5_000;
    const ok = await x.recognise(Buffer.from("y"));
    assert.equal(made.length, 2, "the next receipt must run on a new worker");
    assert.equal(made[0].calls, 1, "the zombie must never be given a second image");
    assert.match(ok.data.text, /SUNRISE/);
  });

  it("extract-4: the serialisation chain only releases when the engine call really settles", async () => {
    const { x, made } = stubbed(300, { timeoutMs: 5_000 });
    const first = x.recognise(Buffer.from("a"));
    let settled = false; x.busy.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(settled, false, "the worker is still busy");
    await first;
    await x.busy;
    assert.equal(made[0].finished, 1, "busy released only after the engine finished");
  });

  it("extract-8: the retry budget measures the OCR pass, not the time the receipt spent queued", async () => {
    // t1 used to be taken before recognise(), which first waits its turn on the
    // single worker, so the 8s budget was spent on queue wait: whether a sideways
    // receipt got the rotation retry that rescues it depended on how busy the
    // worker was a moment earlier, and the participant was told to re-upload a
    // perfectly good receipt.
    const { x } = stubbed(250, { timeoutMs: 5_000 });
    const t0 = Date.now();
    const [, second] = await Promise.all([x.recognise(Buffer.from("a")), x.recognise(Buffer.from("b"))]);
    const wall = Date.now() - t0;
    assert.ok(wall >= 450, `the two calls must be serialised (wall ${wall}ms)`);
    assert.ok(Number.isFinite(second.engineMs), "recognise must report the engine time");
    assert.ok(second.engineMs < 400, `queued time must not be charged to the OCR budget (engine ${second.engineMs}ms of ${wall}ms wall)`);
  });

  it("extract-3: health() reports what the engine last did instead of ok:true for any live-looking handle", async () => {
    const { x } = stubbed(400, { timeoutMs: 40 });
    assert.equal((await x.health()).ok, true, "a healthy extractor still reports ok");
    for (let i = 0; i < 3; i++) await x.recognise(Buffer.from("x")).catch(() => {});
    const h = await x.health();
    assert.equal(h.ok, false, "three consecutive engine failures must not read as healthy on /health/ready");
    assert.equal(h.engineFailures, 3);
    assert.equal(h.lastRecogniseOk, false);
  });
});

describe("extract-7: the vision provider type-checks every value it is given", () => {
  const body = (payload) => ({ ok: true, status: 200, json: async () => ({ id: "r1", model: "m", choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }] }) });
  const base = {
    is_receipt: true, merchant_text: "SUNRISE SUPERMARKET",
    ocr_text: "SUNRISE SUPERMARKET\nWestgate Branch, Harare\nTel 0242 000000\nReceipt No: 004512  Till 03\nDate: 05/10/2026 14:22\nGOLDCANE BROWN SUGAR 2KG\n2 x 3.10  6.20\nTOTAL 6.20\nCASH 10.00\nThank you",
    receipt_number: "004512", till: "03", date_text: "05/10/2026", time_text: "14:22", currency: "USD", total_text: "6.20",
    line_items: [{ raw: "2 x GOLDCANE BROWN SUGAR 2KG", description: "GOLDCANE BROWN SUGAR 2KG", quantity: 2, unit_price_text: "3.10", amount_text: "6.20", voided: false }],
    quality_warnings: [],
  };
  const run = async (payload) => {
    const ex = new VisionExtractor({ apiKey: "k", fetchImpl: async () => body(payload) });
    return ex.extract({ imageBytes: Buffer.from("png"), context: {} });
  };

  it("a malformed line item is refused instead of crashing the extractor", async () => {
    // A bare TypeError has no .code and no .transient, so the pipeline retried
    // the same deterministic request 6 times and dead-lettered it: the receipt
    // sat in 'delayed' for ever with no review task ever created.
    for (const [label, items] of [["null item", [null]], ["string item", ["oops"]], ["object raw", [{ ...base.line_items[0], raw: {} }]], ["missing voided", [{ raw: "a", description: "b", quantity: null, unit_price_text: null, amount_text: null }]]]) {
      const out = await run({ ...base, line_items: items });
      assert.equal(out.document.kind, "unknown", `${label}: must fall back to the empty extraction`);
      assert.match(out.quality.warnings.join(","), /schema_invalid:line_items\[0\]/, `${label}: and say why`);
      assert.deepEqual(out.lineItems, [], `${label}: no invented items`);
    }
  });

  it("a non-string transaction field never reaches the facts", async () => {
    const out = await run({ ...base, till: { a: 1 } });
    assert.match(out.quality.warnings.join(","), /schema_invalid:till/);
    assert.equal(out.transaction.till, null, "an object must not be written into facts_json as the till");
  });

  it("a well-formed response is still extracted, and is marked as model-transcribed evidence", async () => {
    const out = await run(base);
    assert.equal(out.document.kind, "receipt");
    assert.equal(out.transaction.receiptNo, "004512");
    assert.equal(out.lineItems.length, 1);
    assert.equal(out.lineItems[0].quantity, 2);
    assert.ok(out.quality.warnings.includes("model_transcribed_not_pixel_verified"), "nothing on this path is derived from pixels; the reviewer must see that");
  });
});

describe("extract-5: perceptual hashes are evidence, so they must not match unrelated receipts", () => {
  it("a featureless capture produces no hash instead of one every flat image matches", async () => {
    const grey = await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#8a8a8a" } }).png().toBuffer();
    const black = await sharp({ create: { width: 900, height: 1400, channels: 3, background: "#303030" } }).png().toBuffer();
    const a = await imageHashes(grey), b = await imageHashes(black);
    assert.equal(a.phash, null, "a mean hash of a flat image is ffffffffffffffff for every flat image");
    assert.equal(a.dhash, null);
    assert.equal(hamming(a.phash, b.phash), 64, "two unrelated blank captures must not be duplicate candidates");
  });

  it("the shipped fixtures: fewer unrelated pairs flagged, and a re-photographed receipt now found", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"));
    const rows = [];
    for (const f of manifest.fixtures) rows.push({ id: f.id, dup: f.duplicateOf || null, ...(await imageHashes(fs.readFileSync(path.join(FIXTURES, f.file)))) });
    const dist = (a, b) => Math.min(hamming(a.phash, b.phash), hamming(a.dhash, b.dhash));   // the rule duplicates.mjs applies
    let flagged = 0, unrelated = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i], B = rows[j];
      if (A.dup === B.id || B.dup === A.id || (A.dup && A.dup === B.dup)) continue;
      unrelated++; if (dist(A, B) <= PROBABLE_DUPLICATE_DIST) flagged++;
    }
    // The 8x8 mean hash flagged 25.3% of these pairs, several at distance 0, and
    // those rows are what a reviewer reads before deciding DUPLICATE (which
    // voids the entry). The fixtures are all rendered from one template, so this
    // rate is an upper bound rather than a field measurement.
    assert.ok(flagged / unrelated < 0.15, `${flagged}/${unrelated} unrelated fixture pairs flagged as probable duplicates`);
    const by = (id) => rows.find((r) => r.id === id);
    assert.ok(dist(by("valid-two-pack-C"), by("valid-two-pack-C-photo")) <= PROBABLE_DUPLICATE_DIST, "a re-photographed receipt is the case this signal exists for");
  });
});

describe("extract-9: media reuse is scoped to the campaign and to bytes that still exist", () => {
  let h, bytes;
  before(async () => { h = await buildApp(); bytes = await h.simImage("SUNRISE SUPERMARKET\nReceipt No: MEDIA-1\nTOTAL 6.20"); });
  after(async () => { await h.close(); });

  it("the same image in the same campaign is still stored once", async () => {
    const a = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    const b = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    assert.equal(b.assetId, a.assetId);
    assert.equal(b.existing, true);
  });

  it("a purged asset is never handed to a new receipt (its bytes are gone: the receipt would be lost in 'delayed')", async () => {
    const first = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    h.db.prepare(`update media_assets set expires_at='2000-01-01T00:00:00.000Z' where id=?`).run(first.assetId);
    h.app.mediaStore.purgeExpired();
    assert.equal(h.app.mediaStore.readBytes(first.assetId), null, "purge removed the files");
    const again = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    assert.notEqual(again.assetId, first.assetId, "the purged row must not be reused");
    assert.ok(h.app.mediaStore.readBytes(again.assetId), "the new asset's bytes must be readable by the pipeline and the reviewer");
    assert.ok(h.app.mediaStore.readBytes(again.assetId, { normalised: true }), "including the working image");
  });

  it("the same image in another campaign gets its own asset, key and retention clock", async () => {
    const mine = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    const other = await h.app.mediaStore.store({ bytes, campaignId: "camp_other" });
    assert.notEqual(other.assetId, mine.assetId);
    const row = h.db.prepare(`select campaign_id, object_key from media_assets where id=?`).get(other.assetId);
    assert.equal(row.campaign_id, "camp_other", "attributing it to the first campaign misfiles the retention clock, the storage count and the export");
    assert.ok(row.object_key.startsWith("camp_other/"), `bytes must live under their own campaign, got ${row.object_key}`);
    assert.ok(h.app.mediaStore.readBytes(other.assetId));
  });

  it("reuse pushes the retention clock out so the second submitter's reviewer still has the image", async () => {
    const a = await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    const soon = new Date(Date.now() + 60_000).toISOString();
    h.db.prepare(`update media_assets set expires_at=? where id=?`).run(soon, a.assetId);
    await h.app.mediaStore.store({ bytes, campaignId: h.campaign.id });
    const after = h.db.prepare(`select expires_at from media_assets where id=?`).get(a.assetId).expires_at;
    assert.ok(after > new Date(Date.now() + 80 * 86_400_000).toISOString(), `expiry must be renewed on reuse, got ${after}`);
  });
});
