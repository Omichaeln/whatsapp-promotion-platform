import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { id, sha256hex, nowIso, addMinutes } from "./db.mjs";

/**
 * Image handling + private media store (spec §10 steps 2-3, §11 duplicate
 * signals, §17 private media). Built on `sharp` (libvips): content type is
 * detected from bytes, not the provider's declared MIME; the original is
 * kept unmodified; a normalised working image (auto-rotated, greyscale,
 * bounded size) is produced for OCR and hashing.
 *
 * Perceptual hashes: pHash (DCT of a 32x32 raster) and dHash (9x8 gradient).
 * They are SEARCH signals for duplicate candidates, never proof on their own
 * (§11) — but they are shown to a reviewer as evidence, so a hash that matches
 * unrelated receipts is not merely useless, it is misleading.
 */

export const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "heif", "gif", "tiff"]);
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;      // 40 MP: bounded decode work
export const MAX_ASPECT = 20;              // a till receipt is long, not a ribbon
export const MAX_NORMALISED_PIXELS = 1600 * 6400;   // bound on the WORKING image
// Hamming distance on the 64-bit hashes (reviewer search signal only).
// Calibrated against fixtures/receipts/manifest.json, which labels the real
// duplicates. Over its 762 unrelated pairs, min(pHash,dHash) <= 6 flags 12.7%
// with the DCT pHash below against 25.3% with the 8x8 mean hash it replaces,
// and the pairs it now flags are different ones: it finds a re-photographed
// receipt the mean hash missed (valid-two-pack-C, distance 6) and stops
// reporting unrelated receipts at distance 0. Both rates are an upper bound
// rather than a field measurement — every fixture is rendered from the same SVG
// template, so two DIFFERENT fixtures are near-identical to any 64-bit hash.
// Raising it buys recall at a steep price (at 12: 27.2% of unrelated pairs), and
// these rows are shown to a reviewer deciding whether to void an entry, so the
// threshold stays where precision is best; missed re-photographs are still
// caught by the canonical receipt identity, which is what actually decides.
// THE PRICE, stated: recall over the manifest's 18 labelled duplicate pairs
// moves the other way, 6/18 with the mean hash -> 4/18 here (it gains
// valid-two-pack-C <-> ...-C-photo and loses valid-two-pack-A <-> dup-cropped
// and one-pack <-> one-pack-photo). Rotated re-photographs (d=24) are still
// missed by any single 64-bit hash of one orientation — closing that needs a
// rotation-canonical hash or four hashes per asset and a change to the
// comparison in duplicates.mjs, not a different threshold. This is a search
// signal only: none of those pairs can earn a second entry, because the
// canonical receipt identity blocks them (test/receipt-ocr.test.mjs T-07/T-14).
export const PROBABLE_DUPLICATE_DIST = 6;
// Below this standard deviation the 32x32 raster carries no structure at all: a
// uniform capture used to collapse to phash ffffffffffffffff /
// dhash 0000000000000000 and so matched every other flat image at distance 0.
// Measured on the fixtures: a synthetic flat image is exactly 0 and the darkest
// real receipt photo is 2.25, so this only excludes images with no content.
export const MIN_HASH_STDDEV = 1;

export async function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0) throw Object.assign(new Error("empty upload"), { code: "EMPTY" });
  if (bytes.length > MAX_BYTES) throw Object.assign(new Error("image too large"), { code: "TOO_LARGE" });
  let meta;
  try { meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata(); }
  catch (e) { throw Object.assign(new Error("unsupported or malformed image"), { code: "BAD_TYPE", cause: e.message }); }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) throw Object.assign(new Error(`unsupported image format ${meta.format || "unknown"}`), { code: "BAD_TYPE" });
  if ((meta.width || 0) * (meta.height || 0) > MAX_PIXELS) throw Object.assign(new Error("image dimensions too large"), { code: "TOO_LARGE" });
  if ((meta.width || 0) < 64 || (meta.height || 0) < 64) throw Object.assign(new Error("image too small to be a receipt"), { code: "TOO_SMALL" });
  // A 400x100000 PNG compresses to a few hundred KB and passes every check
  // above (it is exactly at MAX_PIXELS), but normalisation then upscales it by
  // width alone into a 640-megapixel working image: a minute of CPU per upload,
  // inside the inbound path, from any consumer. Receipts are long, not ribbons.
  const longest = Math.max(meta.width || 0, meta.height || 0), shortest = Math.min(meta.width || 0, meta.height || 0);
  if (shortest > 0 && longest / shortest > MAX_ASPECT) throw Object.assign(new Error("image shape does not look like a receipt photo"), { code: "BAD_TYPE" });
  const mime = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heif: "image/heic", gif: "image/gif", tiff: "image/tiff" }[meta.format];
  return { format: meta.format, mime, width: meta.width, height: meta.height, orientation: meta.orientation || 1, pages: meta.pages || 1 };
}

/** Normalised working image (PNG): EXIF-rotated, greyscale, width-bounded. */
export async function normaliseForOcr(bytes, { width = 1600 } = {}) {
  // Enlargement stays on: small receipt photos must be upscaled to ~1600px for
  // tesseract to read them. But bound the OTHER side too, or a tall input is
  // scaled up into a working image far larger than the input-pixel budget this
  // module claims to enforce. fit:"inside" keeps the aspect ratio and makes the
  // cap the binding constraint only for shapes no real receipt has.
  const height = Math.max(1, Math.floor(MAX_NORMALISED_PIXELS / width));
  return sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().normalise()
    .resize({ width, height, fit: "inside", withoutEnlargement: false }).png().toBuffer();
}

/** Small greyscale raster used for hashing and quality signals. */
async function smallRaster(bytes, w, h) {
  const { data } = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return data;
}

// DCT basis for the 32x32 pHash, computed once.
const PHASH_N = 32, PHASH_K = 8;
const PHASH_COS = Array.from({ length: PHASH_K }, (_, u) => Float64Array.from({ length: PHASH_N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_N))));

/**
 * pHash: the low-frequency 8x8 DCT block of a 32x32 raster, thresholded at the
 * median of its AC coefficients. It replaces an 8x8 mean hash, which described
 * a receipt as "pale page, dark band" and so matched every other receipt: a
 * quarter of all unrelated fixture pairs were flagged, several at distance 0,
 * and those rows are the evidence a reviewer sees before voiding an entry.
 */
export function phashOf(gray32x32) {
  const rows = new Float64Array(PHASH_N * PHASH_K);
  for (let y = 0; y < PHASH_N; y++) for (let u = 0; u < PHASH_K; u++) { let sum = 0; for (let x = 0; x < PHASH_N; x++) sum += gray32x32[y * PHASH_N + x] * PHASH_COS[u][x]; rows[y * PHASH_K + u] = sum; }
  const co = new Float64Array(PHASH_K * PHASH_K);
  for (let u = 0; u < PHASH_K; u++) for (let v = 0; v < PHASH_K; v++) { let sum = 0; for (let y = 0; y < PHASH_N; y++) sum += rows[y * PHASH_K + v] * PHASH_COS[u][y]; co[u * PHASH_K + v] = sum; }
  const ac = Array.from(co).slice(1).sort((a, b) => a - b);   // drop DC: it is only overall brightness
  const median = ac[(ac.length - 1) >> 1];
  let hash = 0n;
  for (let i = 1; i < 64; i++) if (co[i] > median) hash |= (1n << BigInt(63 - i));
  return hash.toString(16).padStart(16, "0");
}
export function dhashOf(gray9x8) {
  let hash = 0n, bit = 63;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { if (gray9x8[y * 9 + x] < gray9x8[y * 9 + x + 1]) hash |= (1n << BigInt(bit)); bit--; }
  return hash.toString(16).padStart(16, "0");
}
export function hamming(aHex, bHex) {
  if (!aHex || !bHex) return 64;
  let x = BigInt("0x" + aHex) ^ BigInt("0x" + bHex), d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

/** Quality signals: sharpness (variance of Laplacian on a 256px raster), brightness, contrast. */
export async function qualitySignals(bytes) {
  const w = 256, h = 256;
  const g = await smallRaster(bytes, w, h);
  let sum = 0, sumSq = 0, lapSum = 0, lapSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = g[i]; sum += v; sumSq += v * v;
    const lap = 4 * v - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    lapSum += lap; lapSq += lap * lap; n++;
  }
  const mean = sum / n, variance = sumSq / n - mean * mean;
  const lapMean = lapSum / n, lapVar = lapSq / n - lapMean * lapMean;
  return {
    brightness: Math.round(mean),
    contrast: Math.round(Math.sqrt(Math.max(variance, 0))),
    sharpness: Math.round(lapVar),
    tooDark: mean < 45,
    tooBright: mean > 235,
    lowContrast: Math.sqrt(Math.max(variance, 0)) < 18,
    blurry: lapVar < 60,
  };
}

export async function imageHashes(bytes) {
  const sha256 = sha256hex(bytes);
  let phash = null, dhash = null;
  try {
    const g = await smallRaster(bytes, PHASH_N, PHASH_N);
    // A featureless raster (a flat wall, a blown-out or black capture) produces
    // a hash that is the same constant for every such image. Emitting it makes
    // the pipeline record unrelated receipts as duplicate candidates at
    // distance 0; no hash at all is the honest answer.
    let sum = 0, sumSq = 0; for (const v of g) { sum += v; sumSq += v * v; }
    const mean = sum / g.length, stddev = Math.sqrt(Math.max(sumSq / g.length - mean * mean, 0));
    if (stddev >= MIN_HASH_STDDEV) {
      phash = phashOf(g);
      dhash = dhashOf(await smallRaster(bytes, 9, 8));
    }
  } catch { /* unreadable image: hashes stay null; classification handles it */ }
  return { sha256, phash, dhash };
}

// ---------------------------------------------------------------------------
// Private media store: never exposed through a public URL; reviewer access is
// via short-lived HMAC-signed links checked server-side (§17).
// ---------------------------------------------------------------------------
export function createMediaStore({ dir, db, now = nowIso, retentionDays = 90 }) {
  fs.mkdirSync(dir, { recursive: true });
  const put = db.prepare(`insert into media_assets
    (id, object_key, mime, size_bytes, sha256, phash, dhash, width, height, normalized_key, quality_json, provider_media_id, campaign_id, status, created_at, expires_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const getById = db.prepare(`select * from media_assets where id = ?`);
  // Reuse is scoped to the SAME campaign and to assets that are still stored.
  // A global sha256 lookup bound a new receipt either to a PURGED row — whose
  // bytes are gone, so the pipeline reads null and parks the receipt in
  // 'delayed' through six retries with no review task, losing a valid
  // submission — or to ANOTHER campaign's row, which put the image under the
  // first campaign's retention clock, storage count and export, so purging
  // campaign A deleted bytes a campaign-B receipt still referenced.
  const bySha = db.prepare(`select * from media_assets where sha256 = ? and campaign_id is ? and status = 'stored' order by created_at desc limit 10`);
  const touchExpiry = db.prepare(`update media_assets set expires_at = ? where id = ? and expires_at < ?`);
  const onDisk = (a) => [a.object_key, a.normalized_key].every((k) => !k || fs.existsSync(path.join(dir, k)));

  return {
    maxBytes() { return MAX_BYTES; },
    /** Validate, hash, persist original + normalised working image. */
    async store({ bytes, providerMediaId, campaignId }) {
      const info = await inspectImage(bytes);
      const { sha256, phash, dhash } = await imageHashes(bytes);
      // status='stored' is the row's claim; the files are the fact. Only reuse
      // an asset a reviewer and the pipeline can still read.
      const existing = bySha.all(sha256, campaignId || null).find(onDisk);
      if (existing) {
        // Restart the retention clock: the second submitter must not inherit an
        // asset that is hours from expiry because someone else uploaded the
        // same image 90 days ago, leaving their reviewer with no image.
        const until = addMinutes(now(), 60 * 24 * retentionDays);
        touchExpiry.run(until, existing.id, until);
        return { assetId: existing.id, sha256, phash: existing.phash, dhash: existing.dhash, existing: true, info, quality: JSON.parse(existing.quality_json || "null") };
      }
      const quality = await qualitySignals(bytes);
      const normalised = await normaliseForOcr(bytes);
      const assetId = id("med");
      // Keyed by ASSET, not by content: object_key is UNIQUE and purgeExpired
      // keeps the row, so a sha-derived key collided with the purged asset's
      // key the moment the same image was submitted again. The insert threw a
      // UNIQUE error that submit() does not map to a participant-facing code,
      // so the whole inbound event dead-lettered.
      const key = `${campaignId || "shared"}/${assetId}-${sha256}.${info.format}`;
      const nkey = `${campaignId || "shared"}/${assetId}-${sha256}.norm.png`;
      for (const [k, b] of [[key, bytes], [nkey, normalised]]) {
        const abs = path.join(dir, k); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, b);
      }
      put.run(assetId, key, info.mime, bytes.length, sha256, phash, dhash, info.width, info.height, nkey, JSON.stringify(quality), providerMediaId || null, campaignId || null, "stored", now(), addMinutes(now(), 60 * 24 * retentionDays));
      return { assetId, sha256, phash, dhash, existing: false, info, quality, normalised };
    },
    get(assetId) { return getById.get(assetId); },
    readBytes(obj, { normalised = false } = {}) {
      const a = typeof obj === "string" ? getById.get(obj) : obj;
      if (!a) return null;
      const abs = path.join(dir, normalised ? (a.normalized_key || a.object_key) : a.object_key);
      return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    },
    /** Retention: delete stored bytes past expiry; keep the metadata row (status=purged). */
    purgeExpired(limit = 200) {
      const rows = db.prepare(`select * from media_assets where status='stored' and expires_at < ? limit ?`).all(now(), limit);
      for (const a of rows) {
        for (const k of [a.object_key, a.normalized_key]) { if (k) fs.rmSync(path.join(dir, k), { force: true }); }
        db.prepare(`update media_assets set status='purged' where id=?`).run(a.id);
      }
      return rows.length;
    },
  };
}

// Signed short-lived reviewer URL (never a long-lived receipt URL).
export function signMediaUrl(assetId, secret, ttlMinutes = 30) {
  const exp = String(Date.now() + ttlMinutes * 60_000);
  const sig = crypto.createHmac("sha256", secret).update(`${assetId}:${exp}`).digest("hex");
  return { url: `/api/media/${assetId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(Number(exp)).toISOString() };
}
export function verifyMediaSig(assetId, exp, sig, secret) {
  if (!assetId || !exp || !sig || !/^[0-9a-f]{64}$/.test(String(sig))) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${assetId}:${exp}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
}
