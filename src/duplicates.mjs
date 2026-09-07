import crypto from "node:crypto";
import { id, sha256hex, nowIso } from "./db.mjs";

/**
 * Duplicate + fraud controls (G-09, spec 14). Layered:
 *  - exact:  provider message ID, media SHA-256
 *  - similarity: perceptual aHash distance, normalized receipt fingerprint
 *  - content/behaviour signals are recorded for review, never auto-reject.
 * Never returns anything that would leak to the participant beyond the
 * stable DUPLICATE outcome.
 */

export function fingerprintOf(facts, outletId) {
  const date = String(facts?.date || "").slice(0, 10);
  const no = String(facts?.receiptNo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const total = String(facts?.total || "");
  return `${outletId || facts?.outlet || ""}|${date}|${no}|${total}`;
}

export function createDuplicateDetector({ db, phashDistance = 12 }) {
  const bySha = db.prepare(`select id, phash, status from media_assets where sha256 = ? limit 1`);
  const byReceiptFp = db.prepare(`select id, status from receipts where fingerprint = ? and status != 'error' limit 1`);
  const byProviderMsg = db.prepare(`select id from inbound_events where provider_message_id = ? limit 1`);

  return {
    /** Returns { duplicate: false } or { duplicate: true, kind, original } */
    checkExact({ providerMessageId, sha256 }) {
      if (providerMessageId && byProviderMsg.get(providerMessageId)) {
        return { duplicate: true, kind: "provider_message", original: byProviderMsg.get(providerMessageId).id };
      }
      if (sha256) {
        const row = bySha.get(sha256);
        if (row) return { duplicate: true, kind: "exact_sha256", original: row.id };
      }
      return { duplicate: false };
    },
    checkFingerprint(fingerprint, excludeReceiptId) {
      if (!fingerprint || fingerprint.startsWith("||")) return { duplicate: false };
      const row = excludeReceiptId
        ? db.prepare(`select id, status from receipts where fingerprint = ? and status != 'error' and id != ? limit 1`).get(fingerprint, excludeReceiptId)
        : byReceiptFp.get(fingerprint);
      if (row) return { duplicate: true, kind: "receipt_fingerprint", original: row.id };
      return { duplicate: false };
    },
    /** Probable perceptual match -> NEEDS_REVIEW, never auto-duplicate.
   *  P0-04: exclude the current asset so a legitimate receipt never matches
   *  itself (the pipeline stores the media asset before this runs). */
    probableSimilar(phash, excludeAssetId = null) {
      if (!phash) return { probable: false };
      const better = [];
      for (const row of db.prepare(`select id, phash from media_assets where phash is not null`).all()) {
        if (excludeAssetId && row.id === excludeAssetId) continue;
        const d = hamming(phash, row.phash);
        if (d <= phashDistance) better.push({ assetId: row.id, distance: d });
      }
      return { probable: better.length > 0, matches: better.slice(0, 5) };
    },
  };
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

/** Behavioural risk signals (recorded for review, not for auto-decisions). */
export function behaviouralSignals({ weeklySubmissions, weeklyDuplicates, repeatedOutlet, failedAttempts }) {
  return {
    velocity: weeklySubmissions > 10,
    repeatedFailures: failedAttempts > 5,
    sameOutletRepeat: repeatedOutlet > 3,
  };
}

export { id, sha256hex, crypto, nowIso };