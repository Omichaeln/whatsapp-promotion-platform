import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { id, sha256hex, nowIso, addMinutes } from "./db.mjs";

// ---------------------------------------------------------------------------
// Minimal PNG encoder/decoder (8-bit, color types 0/2/3/4/6) - zero deps.
// JPEG pixel access falls back to `sips` on macOS when present (documented dev
// convenience; production media arrives via the Cloud API and is stored as-is).
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Standard CRC-32 (ISO 3309), table-based - PNG chunk integrity requires it.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >> 1) : c >> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >> 8);
  return c ^ 0xffffffff;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGBA pixels into a PNG (rows filtered with 0). */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, y * stride + stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, 6);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a png");
  let pos = 8;
  let w, h, bitDepth, colorType;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!w || !h) throw new Error("png missing IHDR");
  if (bitDepth !== 8) throw new Error(`png bit depth ${bitDepth} unsupported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`png color type ${colorType} unsupported`);
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(a, b, c)) & 0xff;
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const ci = x * channels;
      const oi = (y * w + x) * 4;
      if (colorType === 0) { out[oi] = out[oi+1] = out[oi+2] = cur[ci]; out[oi+3] = 255; }
      else if (colorType === 2) { out[oi]=cur[ci]; out[oi+1]=cur[ci+1]; out[oi+2]=cur[ci+2]; out[oi+3]=255; }
      else if (colorType === 4) { out[oi]=cur[ci]; out[oi+1]=cur[ci+1]; out[oi+2]=cur[ci+1]; out[oi+3]=cur[ci+1]; }
      else { out[oi]=cur[ci]; out[oi+1]=cur[ci+1]; out[oi+2]=cur[ci+2]; out[oi+3]=cur[ci+3]; }
    }
    prev = cur;
  }
  return { width: w, height: h, rgba: out };
}

/** Decode bytes to RGBA; PNG natively, JPEG via sips when available. */
export async function decodeImage(buf) {
  const head = Buffer.from(buf);
  if (head.length > 8 && head.subarray(0, 8).equals(PNG_SIG)) return decodePng(head);
  if (head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    const tmp = `/tmp/wpp-jpg-${process.pid}-${crypto.randomBytes(4).toString("hex")}.jpg`;
    const out = tmp.replace(".jpg", ".png");
    try {
      fs.writeFileSync(tmp, buf);
      const r = await execFile("/usr/bin/sips", ["-s", "format", "png", tmp, "--out", out]);
      if (r.status === 0 && fs.existsSync(out)) {
        const png = fs.readFileSync(out);
        return decodePng(png);
      }
    } catch { /* fall through */ }
    finally { fs.rmSync?.(tmp); fs.rmSync?.(out); }
    throw new Error("jpeg decode unavailable (sips missing)");
  }
  throw new Error("unsupported image format");
}

// ---------------------------------------------------------------------------
// Perceptual hash: average hash (aHash) over an 8x8 grayscale grid.
// Hamming distance < PROBABLE_DUPLICATE_DIST => probable duplicate candidate
// (threshold tuned against a labelled corpus; 12 is a conservative default).
// ---------------------------------------------------------------------------

export const PROBABLE_DUPLICATE_DIST = 12;

export function computeAhash(rgba, width, height) {
  const gw = 8, gh = 8;
  const cells = Buffer.alloc(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, n = 0;
      const x0 = Math.floor(gx * width / gw);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * width / gw));
      const y0 = Math.floor(gy * height / gh);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * height / gh));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        sum += 0.299 * rgba[i] + 0.587 * rgba[i+1] + 0.114 * rgba[i+2];
        n++;
      }
      cells[gy * gw + gx] = Math.round(sum / Math.max(n, 1));
    }
  }
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += cells[i];
  mean /= 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) if (cells[i] >= mean) hash |= (1n << BigInt(63 - i));
  return hash.toString(16).padStart(16, "0");
}

export function hamming(aHex, bHex) {
  let a = BigInt("0x" + aHex), b = BigInt("0x" + bHex);
  let d = 0;
  while (a !== 0n || b !== 0n) {
    d += Number((a ^ b) & 1n);
    a >>= 1n; b >>= 1n;
  }
  return d;
}

export async function imageHashes(buf) {
  const sha = sha256hex(buf);
  let phash = null;
  try {
    const { width, height, rgba } = await decodeImage(buf);
    phash = computeAhash(rgba, width, height);
  } catch { phash = null; }
  return { sha256: sha, phash };
}

// ---------------------------------------------------------------------------
// Private media asset storage - never exposed through a public object URL
// (spec 12.1 media_assets, 10.4 invariant: raw receipt media stays private).
// ---------------------------------------------------------------------------

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/gif", "image/bmp"]);
const MAX_BYTES = 10 * 1024 * 1024;

export function createMediaStore({ dir, db, now = nowIso }) {
  fs.mkdirSync(dir, { recursive: true });
  const put = db.prepare(`insert or replace into media_assets
    (id, object_key, mime, size_bytes, sha256, phash, provider_media_id, campaign_id, status, created_at, expires_at)
    values (?,?,?,?,?,?,?,?,?,?,?)`);
  const getById = db.prepare(`select * from media_assets where id = ?`);
  const bySha = db.prepare(`select * from media_assets where sha256 = ? limit 1`);

  return {
    allowedMime(m) { return IMAGE_MIMES.has((m || "").toLowerCase()); },
    maxBytes() { return MAX_BYTES; },
    async store({ bytes, mime, providerMediaId, campaignId }) {
      if (bytes.length > MAX_BYTES) throw Object.assign(new Error("image too large"), { code: "TOO_LARGE" });
      if (!this.allowedMime(mime)) throw Object.assign(new Error("unsupported media type"), { code: "BAD_TYPE" });
      const { sha256, phash } = await imageHashes(bytes);
      const existing = bySha.get(sha256);
      if (existing) return { assetId: existing.id, sha256, phash, existing: true };
      const assetId = id("med");
      const key = `${campaignId || "shared"}/${sha256}.bin`;
      const abs = path.join(dir, key);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      put.run(assetId, key, mime, bytes.length, sha256, phash, providerMediaId || null, campaignId || null, "stored", now(), addMinutes(now(), 60 * 24 * 30));
      return { assetId, sha256, phash, existing: false };
    },
    get(obj) { return getById.get(obj); },
    readBytes(obj) {
      const a = typeof obj === "string" ? getById.get(obj) : obj;
      if (!a) return null;
      const abs = path.join(dir, a.object_key);
      return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    },
  };
}

// Signed short-lived reviewer URL (spec 11.4: never a long-lived receipt URL)
export function signMediaUrl(assetId, secret, ttlMinutes = 30) {
  const exp = String(Date.now() + ttlMinutes * 60_000);
  const sig = crypto.createHmac("sha256", secret).update(`${assetId}:${exp}`).digest().toString("hex");
  return { url: `/api/media/${assetId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(Number(exp)).toISOString() };
}

export function verifyMediaSig(assetId, exp, sig, secret) {
  if (!assetId || !exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${assetId}:${exp}`).digest().toString("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
}