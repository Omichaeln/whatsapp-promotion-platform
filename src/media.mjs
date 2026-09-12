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
 * Perceptual hashes: aHash (8x8 mean) and dHash (9x8 gradient) over the
 * normalised image. They are SEARCH signals for duplicate candidates, never
 * proof on their own (§11).
 */

export const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "heif", "gif", "tiff"]);
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;      // 40 MP: bounded decode work
export const MAX_ASPECT = 20;              // a till receipt is long, not a ribbon
export const MAX_NORMALISED_PIXELS = 1600 * 6400;   // bound on the WORKING image
export const PROBABLE_DUPLICATE_DIST = 6;    // Hamming distance on 64-bit hashes (reviewer search signal only)

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

export function ahashOf(gray64) {
  let mean = 0; for (let i = 0; i < 64; i++) mean += gray64[i]; mean /= 64;
  let hash = 0n; for (let i = 0; i < 64; i++) if (gray64[i] >= mean) hash |= (1n << BigInt(63 - i));
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
    const a = await smallRaster(bytes, 8, 8); phash = ahashOf(a);
    const d = await smallRaster(bytes, 9, 8); dhash = dhashOf(d);
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
  const bySha = db.prepare(`select * from media_assets where sha256 = ? limit 1`);

  return {
    maxBytes() { return MAX_BYTES; },
    /** Validate, hash, persist original + normalised working image. */
    async store({ bytes, providerMediaId, campaignId }) {
      const info = await inspectImage(bytes);
      const { sha256, phash, dhash } = await imageHashes(bytes);
      const existing = bySha.get(sha256);
      if (existing) return { assetId: existing.id, sha256, phash: existing.phash, dhash: existing.dhash, existing: true, info, quality: JSON.parse(existing.quality_json || "null") };
      const quality = await qualitySignals(bytes);
      const normalised = await normaliseForOcr(bytes);
      const assetId = id("med");
      const key = `${campaignId || "shared"}/${sha256}.${info.format}`;
      const nkey = `${campaignId || "shared"}/${sha256}.norm.png`;
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
