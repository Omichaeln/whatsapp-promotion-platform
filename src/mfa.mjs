import crypto from "node:crypto";

/**
 * TOTP (RFC 6238) — SHA-1, 30-second step, 6 digits, base32 secret.
 * Zero-dependency; designed for the platform's MFA flow (DEF-02 / G-12).
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Random base32 secret (default 20 bytes = 32 chars, RFC 4226 app key size). */
export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  return bufToBase32(buf);
}

export function bufToBase32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32ToBuf(secret) {
  const clean = String(secret || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HMAC-SHA1-based TOTP code for a given secret + time window. */
export function totp(secret, { window = 30, digits = 6, timeMs = Date.now() } = {}) {
  const key = base32ToBuf(secret);
  const counter = Math.floor(timeMs / 1000 / window);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % Math.pow(10, digits)).padStart(digits, "0");
}

/** Verify a code allowing a +/-1 window skew. Returns boolean. */
export function verifyTotp(secret, code, opts = {}) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const winMs = (opts.window || 30) * 1000;
  const nowMs = opts.timeMs ?? Date.now();
  for (const skewMs of [0, -winMs, winMs]) {
    if (crypto.timingSafeEqual(
      Buffer.from(totp(secret, { ...opts, timeMs: nowMs + skewMs })),
      Buffer.from(clean),
    )) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps. */
export function otpauthUri(secret, { label = "WhatsApp Promo Platform", issuer = "PromoVault" } = {}) {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** SVG data URI of a QR code for the otpauth URI (simple scannable render). */
export function otpauthQrSvg(uri) {
  // Rely on the console's qrcode capability where available; this returns the
  // uri so the client can render. Kept minimal and dependency-free.
  return { uri, qrDataUri: null };
}
