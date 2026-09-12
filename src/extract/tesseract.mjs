import path from "node:path";
import { createRequire } from "node:module";
import { ReceiptExtractor, emptyExtraction, EXTRACTION_SCHEMA_VERSION } from "./receipt-extractor.mjs";
import { parseReceiptText } from "./parse-receipt.mjs";
import { normaliseForOcr, MAX_PIXELS } from "../media.mjs";

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
 *
 * CONTAINED: every failure of the WASM engine must end as one receipt failing
 * with OCR_UNAVAILABLE, never as a dead server. tesseract.js rethrows worker
 * rejections on the parent (createWorker.js:217) and its `worker.onerror =`
 * registers nothing on a worker_threads Worker, so both paths are wired up
 * explicitly below.
 */
export class TesseractExtractor extends ReceiptExtractor {
  constructor({ timeoutMs = 45_000, buildTimeoutMs = null, langPath = null, log = console } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    // Deliberately NOT timeoutMs: that is one receipt's OCR budget, which an
    // operator may tune down to a few seconds, and abandoning the one-off WASM
    // build on that budget would fail every receipt on a cold or slow disk.
    // This bound only has to catch a build that is never going to finish.
    this.buildTimeoutMs = buildTimeoutMs || Math.max(timeoutMs, 60_000);
    this.langPath = langPath || path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    this.log = log;
    this.worker = null;
    this.workerPromise = null;       // in-flight build; see ensureWorker()
    this.build = null;               // the token for that build, so it can be ABANDONED
    this.version = null;
    this.busy = Promise.resolve();
    this.rejectInFlight = null;      // fails the current recognise when the thread dies under it
    this.inFlightWorker = null;      // which worker that call is using
    this.lastRecogniseAt = null;
    this.lastRecogniseOk = null;
    this.lastError = null;
    this.engineFailures = 0;         // consecutive ENGINE-level failures (not unreadable images)
  }
  get name() { return "tesseract.js"; }
  get mode() { return "real"; }

  /**
   * Throw the worker away so the next call builds a clean one, and fail the
   * call that is waiting on it. Anything that reaches here (thread error, OOM,
   * an OCR timeout) leaves an engine we can no longer reason about: keeping the
   * handle hands the next receipt either a corpse or a worker still chewing on
   * the previous image.
   */
  discardWorker(w, why) {
    this.lastError = why;
    if (!w || this.worker === w) { this.worker = null; this.workerPromise = null; }
    // A worker that dies while it is still being BUILT is not this.worker yet
    // (that assignment happens in ensureWorker's continuation), so the guard
    // above missed it and left the memoised build promise in place — a promise
    // that can never settle, because the build is parked on setParameters() and
    // tesseract.js never settles a job whose thread is gone. Every later
    // recognise(), extract() and /health/ready then awaited it for ever and only
    // a process restart recovered. Abandoning it rejects those callers instead.
    if (!w || this.build?.worker === w) this.abandonBuild(why);
    if (this.rejectInFlight && (!w || this.inFlightWorker === w)) { const fail = this.rejectInFlight; this.rejectInFlight = null; fail(Object.assign(new Error(why), { fatal: true })); }
    // Terminate out of band: a worker stuck in synchronous WASM can take a
    // while to stop and the next receipt must not queue behind it.
    if (w) { try { Promise.resolve(w.terminate()).catch(() => {}); } catch { /* already gone */ } }
  }

  /**
   * Give up on the in-flight ensureWorker() build: reject everyone waiting on
   * it and mark it so the worker it may still produce is terminated instead of
   * adopted. Used when the thread dies under the build, when the build exceeds
   * its bound, and by close().
   */
  abandonBuild(why) {
    const b = this.build;
    if (!b || b.abandoned) return;
    b.abandoned = true;
    this.build = null; this.workerPromise = null; this.lastError = why;
    b.reject(Object.assign(new Error(why), { fatal: true }));
  }

  /**
   * A thread-level failure. Count it ONCE: when a call is in flight on this
   * worker, discardWorker() rejects that call and recogniseOnce()'s catch does
   * the counting. Counting here as well made health() flip to ok:false — an
   * unauthenticated /health/ready 503 and a "dead extractor" in the console —
   * after TWO thread errors, not the three the threshold at health() and the
   * comment on engineFailures both state.
   */
  noteThreadFailure(w, why) {
    if (!(this.rejectInFlight && this.inFlightWorker === w)) this.engineFailures++;
    this.discardWorker(w, why);
  }

  /**
   * Spawn the raw tesseract.js worker. Its own seam so the build-failure paths
   * (a thread that dies mid-build, a build that never returns) can be driven in
   * a test without a 56 MB thread; production never passes anything else.
   */
  async spawnWorker(options) {
    const { createWorker } = await import("tesseract.js");
    return createWorker("eng", 1, options);
  }

  async ensureWorker() {
    if (this.worker) return this.worker;
    // Memoise the BUILD, not just the result. A plain `if (this.worker)` let two
    // callers that arrive before createWorker resolves (the unauthenticated
    // /health/ready probe and the first receipt.process job) each spawn a 56 MB
    // worker thread; close() only terminates this.worker, so the loser was
    // overwritten and leaked for the life of the process.
    if (!this.workerPromise) {
      // The build must also be ABANDONABLE and BOUNDED. Every step of it that
      // talks to the thread can stop settling if the thread goes (tesseract.js
      // leaves such job promises pending for ever), and this promise is what
      // every recognise(), extract() and /health/ready awaits — so an
      // unsettleable build is a total, restart-only outage, strictly worse than
      // the un-memoised version it replaced.
      const build = { worker: null, abandoned: false, reject: null, settled: null };
      const abandoned = new Promise((_, rej) => { build.reject = rej; });
      abandoned.catch(() => {});   // the race below is its only real consumer
      this.build = build;
      // NOT unref'd: an idle process whose only pending work is a wedged build
      // is exactly the case this bound exists for, and both continuations below
      // clear it, so it can never outlive the build it bounds.
      const bound = setTimeout(() => this.abandonBuild("worker_build_timeout"), this.buildTimeoutMs);
      const made = (async () => {
        this.version = require("tesseract.js/package.json").version;
        const w = await this.spawnWorker({
          langPath: this.langPath, cachePath: this.langPath, gzip: true, logger: () => {},
          // Without errorHandler tesseract.js rethrows every worker-side
          // rejection from its own message handler on the parent thread, where
          // no caller try/catch can reach it: one unreadable receipt took the
          // HTTP server, the job worker and the outbox down with it. The job's
          // own promise is already rejected and recogniseOnce() handles it, so
          // this only has to observe the error.
          errorHandler: (err) => { this.lastError = String(err?.message || err); this.log?.warn?.("[ocr] worker job rejected:", this.lastError); },
        });
        build.worker = w;
        // Node surfaces an uncaught exception inside the thread (including
        // ERR_WORKER_OUT_OF_MEMORY) as an 'error' EVENT on the Worker.
        // tesseract.js assigns `worker.onerror`, which is a browser-ism and
        // registers no listener, so EventEmitter rethrew it in the parent and
        // the process exited. Listening is what makes it one failed receipt.
        const thread = w.worker;
        if (thread && typeof thread.on === "function") {
          thread.on("error", (err) => { this.log?.error?.("[ocr] worker thread error:", err?.message || err); this.noteThreadFailure(w, `worker_error:${err?.message || err}`); });
          thread.on("exit", (code) => { if (this.worker === w || this.build?.worker === w) this.noteThreadFailure(w, `worker_exit:${code}`); });
        }
        await w.setParameters({ preserve_interword_spaces: "1" });
        return w;
      })();
      // A worker that arrives after its build was abandoned has no owner: it is
      // unreachable by close() and its thread would outlive the extractor (56 MB
      // and an event loop that never drains), so terminate it. close() waits on
      // this so shutdown really is shutdown.
      build.settled = made.then(async (w) => { if (build.abandoned) { try { await w.terminate(); } catch { /* already gone */ } } }, () => {});
      this.workerPromise = Promise.race([made, abandoned]).then(
        (w) => {
          clearTimeout(bound);
          if (this.build !== build || build.abandoned) throw Object.assign(new Error(this.lastError || "worker build abandoned"), { fatal: true });
          this.build = null; this.worker = w; this.workerPromise = null; return w;
        },
        (e) => {
          clearTimeout(bound);
          if (this.build === build) { this.build = null; this.workerPromise = null; }
          this.lastError = String(e?.message || e); throw e;
        },
      );
    }
    return this.workerPromise;
  }

  /** One recognition on the worker. Never leaves a failed engine in place. */
  async recogniseOnce(pngBytes) {
    const w = await this.ensureWorker();
    const started = Date.now();
    let timer, rejectFatal;
    const job = w.recognize(pngBytes);
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("ocr timeout"), { fatal: true })), this.timeoutMs); timer.unref?.(); });
    const fatal = new Promise((_, rej) => { rejectFatal = rej; });
    this.rejectInFlight = rejectFatal; this.inFlightWorker = w;
    try {
      const res = await Promise.race([job, timeout, fatal]);
      this.engineFailures = 0; this.lastRecogniseOk = true; this.lastRecogniseAt = new Date().toISOString();
      return { ...res, engineMs: Date.now() - started };
    } catch (e) {
      // tesseract.js rejects with a bare STRING, so normalise before it reaches
      // extract() and becomes "ocr failed: undefined" in the alert and audit.
      const err = e instanceof Error ? e : Object.assign(new Error(String(e)), { fatal: false });
      this.lastRecogniseOk = false; this.lastRecogniseAt = new Date().toISOString(); this.lastError = err.message;
      if (err.fatal || this.worker !== w) {
        // A timeout does NOT cancel the WASM job — it keeps running inside the
        // thread and keeps the single worker. Handing the next receipt that
        // same worker made it pay the zombie's remaining time, and once the
        // backlog exceeded timeoutMs no receipt ever completed again.
        this.engineFailures++;
        job.catch(() => {});   // the abandoned job must not resurface as an unhandled rejection
        this.discardWorker(w, this.lastError);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (this.rejectInFlight === rejectFatal) this.rejectInFlight = null;
    }
  }

  async recognise(pngBytes) {
    // Serialise: one WASM worker. The chain must only release once the
    // underlying recognize() has actually settled — releasing it when the
    // CALLER's timeout fired posted the next receipt's image to a worker that
    // was still running the previous one.
    const run = this.busy.then(() => this.recogniseOnce(pngBytes));
    this.busy = run.then(() => {}, () => {});
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
      const first = await this.recognise(png);
      data = first.data;
      parsed = parse(data.text);
      // Bounded orientation retry: receipts photographed sideways have no EXIF
      // orientation. Only when the upright pass does not look like a receipt
      // AND was cheap (noise images are slow and never improve by rotating).
      // The budget is the ENGINE time, not wall clock: the old clock started
      // before recognise(), which first waits its turn on the single worker, so
      // how busy the queue happened to be — not the image — decided whether a
      // sideways receipt got the retry that rescues it, and the participant was
      // told to re-upload a perfectly good receipt.
      if (parsed.document.kind !== "receipt" && first.engineMs < 8000) {
        const sharp = (await import("sharp")).default;
        for (const deg of [90, 270]) {
          const rotated = await sharp(png, { limitInputPixels: MAX_PIXELS }).rotate(deg).png().toBuffer();
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
    try {
      // Bare await on purpose: ensureWorker() is itself bounded and rejects when
      // its build is abandoned, so this unauthenticated probe answers 503 rather
      // than hanging on a build whose thread has gone.
      await this.ensureWorker();
      // A cached worker handle is not evidence that OCR works. health() used to
      // return ok:true for any live-looking object, so /health/ready answered
      // 200 and the operator console reported a healthy extractor while every
      // receipt failed. Report what the engine last actually did — this route is
      // unauthenticated, so it must never run OCR on demand.
      return {
        provider: this.name, mode: "real", ok: this.engineFailures < 3, model: `tesseract.js@${this.version}`,
        engineFailures: this.engineFailures, lastRecogniseAt: this.lastRecogniseAt, lastRecogniseOk: this.lastRecogniseOk,
        ...(this.engineFailures ? { error: this.lastError } : {}),
      };
    } catch (e) { return { provider: this.name, mode: "real", ok: false, error: e.message }; }
  }

  /** Shut the engine down. Reusable afterwards: the next call rebuilds. */
  async close({ graceMs = 5_000 } = {}) {
    // Terminating a worker with a job in flight is how a graceful SIGTERM
    // redeploy turned into a non-zero exit: the in-flight job's promise never
    // settles and the next one posts to a null worker. Give running work a
    // bounded moment to finish, then drop the handle BEFORE terminating so a
    // queued call builds a fresh worker instead of using a dead one.
    const grace = () => new Promise((r) => { const t = setTimeout(r, graceMs); t.unref?.(); });
    await Promise.race([this.busy, grace()]);
    // A build started a moment before close() used to finish afterwards and
    // re-assign this.worker: close() returned having terminated nothing, and the
    // thread stayed alive, owned by no one. /health/ready is unauthenticated and
    // calls ensureWorker(), so a probe landing as SIGTERM arrives hits exactly
    // this race. Abandon the build and wait for the worker it produces to be
    // terminated (bounded by the same grace).
    const inFlight = this.build?.settled || null;
    const w = this.worker;
    this.worker = null; this.workerPromise = null; this.rejectInFlight = null;
    this.abandonBuild("closed");
    try { await w?.terminate(); } catch { /* ignore */ }
    if (inFlight) await Promise.race([inFlight, grace()]);
  }
}
