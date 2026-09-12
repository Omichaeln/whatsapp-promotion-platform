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
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
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
    // Object identity alone does NOT prove this and passes without the fix:
    // every caller used to return the shared `this.worker` field after its own
    // await, so three callers could hand back the same last-written object
    // while three 56 MB threads had been spawned. The leak IS the thread count,
    // so count threads: worker_threads allocates ids from one monotonic counter
    // and never reuses them, so a probe either side is an exact census.
    const probe = () => { const w = new Worker("", { eval: true }); const t = w.threadId; w.terminate(); return t; };
    const before = probe();
    const [a, b, c] = await Promise.all([x.ensureWorker(), x.ensureWorker(), x.ensureWorker()]);
    const spawned = probe() - before - 1;
    assert.equal(spawned, 1, `three concurrent callers must spawn exactly ONE worker thread, spawned ${spawned}`);
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
    // One thread error is ONE engine failure. It used to be counted twice (once
    // in the 'error' listener, once in recogniseOnce's catch for the call the
    // listener had just failed), so /health/ready answered 503 and the console
    // reported the extractor dead after TWO thread errors, not the three the
    // threshold, its comment and the runbook all state.
    assert.equal(x.engineFailures, 1, "a single thread error must count once");
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

  it("extract-4: a call takes its place in the chain at once, and a timed-out one releases it only after the worker is gone", async () => {
    // Two halves, because only the first one is literally true of the engine.
    // (a) While the engine is running, the chain stays held: the next receipt
    // cannot be posted to a worker that is still chewing on this image.
    const { x, made } = stubbed(300, { timeoutMs: 5_000 });
    const first = x.recognise(Buffer.from("a"));
    let settled = false; x.busy.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(settled, false, "the worker is still busy");
    await first;
    await x.busy;
    assert.equal(made[0].finished, 1, "busy released only after the engine finished");

    // (b) A TIMEOUT cannot cancel the WASM job — it keeps running inside the
    // thread — so the chain does release while the engine is still working.
    // What protects the next receipt is therefore not the chain: it is that the
    // zombie worker has already been dropped AND terminated by the time the
    // chain releases, so the next call cannot be handed it. Assert that, not an
    // invariant the engine cannot give us.
    const t = stubbed(600, { timeoutMs: 100 });
    await assert.rejects(() => t.x.recognise(Buffer.from("b")), /ocr timeout/);
    await t.x.busy;
    assert.equal(t.made[0].finished, 0, "the engine job outlives the timeout: the chain released while it was still running");
    assert.equal(t.x.worker, null, "so the zombie must be off the extractor before the chain releases");
    assert.equal(t.made[0].terminated, 1, "and terminated, or the next receipt pays its remaining time");
    t.x.timeoutMs = 5_000;
    const okAfter = await t.x.recognise(Buffer.from("c"));
    assert.equal(t.made.length, 2, "the next receipt runs on a fresh worker");
    assert.equal(t.made[0].calls, 1, "the zombie is never given a second image");
    assert.match(okAfter.data.text, /SUNRISE/);
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

/** A tesseract-api-shaped worker whose `worker` handle is a real EventEmitter,
 *  so the listeners ensureWorker() installs during the build can be driven. */
function buildableWorker({ setParameters } = {}) {
  const w = {
    terminated: 0, worker: new EventEmitter(),
    async recognize() { return { jobId: "j", data: { text: "SUNRISE SUPERMARKET", confidence: 80 } }; },
    // tesseract.js NEVER settles a job promise whose thread has gone (terminate()
    // just kills the thread, createWorker.js:187) — that is what wedged the build.
    setParameters: setParameters || (async () => {}),
    terminate() { w.terminated++; return Promise.resolve(); },
  };
  return w;
}

describe("extract-3: a worker that dies while it is being BUILT must not wedge the extractor for ever", () => {
  // Each case carries an explicit timeout: the defect under test IS a hang, so a
  // regression here must be reported as a failed test, not as a wedged runner.
  const silent = { warn() {}, error() {} };

  it("a thread error during the build fails the waiting caller instead of hanging every later call", { timeout: 20_000 }, async () => {
    // The build's only awaited step after the thread exists is setParameters(),
    // whose promise can never settle once the thread is gone. The memoised
    // build promise is what every later recognise(), extract() and unauthenticated
    // /health/ready await, so leaving it pending wedged the whole extractor
    // until the process was restarted — strictly worse than the un-memoised
    // version this replaced, where the next caller just built a fresh worker.
    const dying = buildableWorker({ setParameters: () => new Promise(() => {}) });
    const x = new TesseractExtractor({ log: silent, timeoutMs: 30_000 });
    x.spawnWorker = async () => dying;
    const p = x.ensureWorker(); p.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));   // the worker exists; the build is awaiting setParameters
    dying.worker.emit("error", new Error("thread died mid-build"));
    await assert.rejects(() => p, /thread died mid-build/, "the caller must see the failure, not await a promise that can never settle");
    assert.equal(x.workerPromise, null, "and the memoised build must be cleared, or every later call inherits the wedge");
    assert.equal(dying.terminated, 1, "the half-built worker must be terminated");
    const good = buildableWorker();
    x.spawnWorker = async () => good;
    assert.equal(await x.ensureWorker(), good, "the next caller must build a clean worker");
    await x.close();
  });

  it("a build that never finishes is bounded: /health/ready answers instead of hanging", { timeout: 20_000 }, async () => {
    const x = new TesseractExtractor({ log: silent, buildTimeoutMs: 150 });
    x.spawnWorker = () => new Promise(() => {});
    const t0 = Date.now();
    await assert.rejects(() => x.ensureWorker(), /worker_build_timeout/, "a build with no bound is an unrecoverable hang");
    assert.ok(Date.now() - t0 < 3_000, "and it must surface at the bound, not at the heat death of the universe");
    const h = await x.health();
    assert.equal(h.ok, false, "/health/ready must answer 503, not hang unanswered");
    const good = buildableWorker();
    x.spawnWorker = async () => good; x.timeoutMs = 5_000;
    assert.equal(await x.ensureWorker(), good, "and the extractor must still be usable afterwards");
    await x.close();
  });

  it("close() racing a build does not leave a worker thread behind", { timeout: 20_000 }, async () => {
    // /health/ready is unauthenticated and calls ensureWorker(), so a probe that
    // lands as SIGTERM arrives starts a build that outlives close(): its
    // continuation re-assigned this.worker after close() returned and the 56 MB
    // thread survived, unowned and unreachable.
    let release; const late = buildableWorker();
    const x = new TesseractExtractor({ log: silent });
    x.spawnWorker = () => new Promise((r) => { release = () => r(late); });
    const p = x.ensureWorker(); p.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    const closing = x.close({ graceMs: 1_000 });
    await new Promise((r) => setTimeout(r, 20));   // close() has taken over the in-flight build
    release();
    await closing;
    assert.equal(x.worker, null, "close() must not be undone by a build that finishes just after it");
    assert.equal(x.workerPromise, null);
    assert.equal(late.terminated, 1, "the worker the build produced must be terminated, not leaked");
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
    for (const [label, items] of [["null item", [null]], ["string item", ["oops"]], ["object raw", [{ ...base.line_items[0], raw: {} }]],
      // `!!"false"` is true, so forgiving this would void a line the receipt
      // does not void — the one line-item shape that must still be refused.
      ["string voided", [{ raw: "a", description: "b", quantity: null, unit_price_text: null, amount_text: null, voided: "false" }]],
      ["non-numeric quantity", [{ ...base.line_items[0], quantity: "two" }]]]) {
      const out = await run({ ...base, line_items: items });
      assert.equal(out.document.kind, "unknown", `${label}: must fall back to the empty extraction`);
      assert.match(out.quality.warnings.join(","), /schema_invalid:line_items\[0\]/, `${label}: and say why`);
      assert.deepEqual(out.lineItems, [], `${label}: no invented items`);
    }
  });

  it("a shape another OpenAI-compatible endpoint commonly sends is coerced, not sent to review", async () => {
    // baseUrl is configurable and the whole point of the finding is that path.
    // A quantity sent as "2" and an omitted optional `voided` both collapse to
    // exactly what the mapping already produces (null / false), so refusing the
    // receipt over them put a perfectly good upload in front of a reviewer and
    // extracted nothing. They are still reported, never silently accepted.
    const out = await run({ ...base, line_items: [{ raw: "2 x GOLDCANE BROWN SUGAR 2KG", description: "GOLDCANE BROWN SUGAR 2KG", quantity: "2", unit_price_text: "3.10", amount_text: "6.20" }] });
    assert.equal(out.document.kind, "receipt", "the receipt must still be extracted");
    assert.equal(out.lineItems.length, 1);
    assert.equal(out.lineItems[0].quantity, null, "a quantity we did not get as a number is null, never invented");
    assert.equal(out.lineItems[0].voided, false);
    assert.match(out.quality.warnings.join(","), /model_shape_coerced:line_items\[0\]\.quantity\|line_items\[0\]\.voided/, "and the reviewer is told the endpoint sent a loose shape");
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
    let flagged = 0, unrelated = 0, dupPairs = 0, dupCaught = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i], B = rows[j];
      const near = dist(A, B) <= PROBABLE_DUPLICATE_DIST;
      if (A.dup === B.id || B.dup === A.id || (A.dup && A.dup === B.dup)) { dupPairs++; if (near) dupCaught++; continue; }
      unrelated++; if (near) flagged++;
    }
    // The 8x8 mean hash flagged 25.3% of these pairs, several at distance 0, and
    // those rows are what a reviewer reads before deciding DUPLICATE (which
    // voids the entry). The fixtures are all rendered from one template, so this
    // rate is an upper bound rather than a field measurement.
    assert.ok(flagged / unrelated < 0.15, `${flagged}/${unrelated} unrelated fixture pairs flagged as probable duplicates`);
    const by = (id) => rows.find((r) => r.id === id);
    assert.ok(dist(by("valid-two-pack-C"), by("valid-two-pack-C-photo")) <= PROBABLE_DUPLICATE_DIST, "a re-photographed receipt is the case this signal exists for");
    // And the price, asserted rather than left implicit: precision was bought
    // with recall. Over the same fixtures this catches 4 of the 18 labelled
    // duplicate pairs where the 8x8 mean hash caught 6 (measured on both). The
    // other half of extract-5 — rotated re-photographs, d=24 — is NOT closed by
    // this change and cannot be closed by a threshold. It costs nothing that can
    // mint an entry: every one of these pairs is still blocked by the canonical
    // receipt identity (test/receipt-ocr.test.mjs T-07/T-14). This assertion is
    // here so a further silent drop in recall fails the suite.
    assert.equal(dupPairs, 18, "the manifest's labelled duplicate pairs");
    assert.ok(dupCaught >= 4, `perceptual recall dropped below the 4/18 this threshold was calibrated at (${dupCaught}/${dupPairs})`);
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
