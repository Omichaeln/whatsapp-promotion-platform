import { hamming, PROBABLE_DUPLICATE_DIST } from "./media.mjs";

/**
 * Receipt identity + duplicate evidence (spec §11).
 * Layers:
 *  - provider message id       -> webhook replay (channel_events unique)
 *  - SHA-256 of bytes          -> exact image repeat
 *  - aHash/dHash distance      -> visual duplicate CANDIDATES (search signal only)
 *  - canonical purchase key    -> same transaction across different photographs
 *
 * Canonical key = outletId | txn date | receipt number | total(minor). A printed
 * receipt number alone is not unique (till counters repeat across days and
 * branches), so the key always includes outlet and date. Credit is enforced by
 * the UNIQUE(campaign_id, canonical_key) constraint on canonical_receipts and
 * UNIQUE(canonical_receipt_id) on entries — never by application checks alone.
 */
export const normaliseReceiptNo = (n) => String(n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function canonicalKeyOf({ outletId, date, receiptNo, totalMinor }) {
  if (!outletId || !date || !receiptNo) return null;      // incomplete identity -> no key (review path)
  return `${outletId}|${date}|${normaliseReceiptNo(receiptNo)}|${totalMinor ?? ""}`;
}

export function createDuplicateDetector({ db, phashDistance = PROBABLE_DUPLICATE_DIST }) {
  const byShaOther = db.prepare(`select r.id, r.status from receipts r join media_assets m on m.id = r.media_asset_id where m.sha256 = ? and r.campaign_id = ? and r.id != ? order by r.created_at limit 5`);
  const hashed = db.prepare(`select r.id as receipt_id, m.phash, m.dhash from receipts r join media_assets m on m.id = r.media_asset_id where r.campaign_id = ? and r.id != ? and (m.phash is not null or m.dhash is not null) order by r.created_at desc limit 5000`);
  const byCanonical = db.prepare(`select * from canonical_receipts where campaign_id = ? and canonical_key = ?`);
  // Same printed receipt, a DIFFERENT outlet selection. The canonical key
  // embeds the outlet the participant chose, which is their own input, so one
  // physical receipt submitted against two branches mints two identities.
  const byPrintedIdentity = db.prepare(`select * from canonical_receipts
    where campaign_id = ? and txn_date = ? and receipt_no_norm = ? and coalesce(total_minor, -1) = coalesce(?, -1)
      and coalesce(outlet_id, '') != coalesce(?, '')`);

  return {
    /** Exact byte repeat of a prior submission in this campaign. */
    exactImageMatches({ sha256, campaignId, excludeReceiptId }) {
      return byShaOther.all(sha256, campaignId, excludeReceiptId || "").map((r) => ({ receiptId: r.id, kind: "exact_sha256", score: 1 }));
    },
    /**
     * Prior claims on the same PRINTED receipt at a different outlet.
     * The printed identity (date + number + total) belongs to the receipt; the
     * outlet in the canonical key belongs to the participant's selection, so
     * this is the layer that stops one purchase earning two entries by simply
     * choosing another branch.
     */
    crossOutletClaims({ campaignId, date, receiptNo, totalMinor, outletId }) {
      if (!date || !receiptNo) return [];
      const no = normaliseReceiptNo(receiptNo);
      return byPrintedIdentity.all(campaignId, date, no, totalMinor ?? null, outletId || '');
    },
    /** Visually similar prior submissions (bounded scan; candidates only). */
    visualCandidates({ phash, dhash, campaignId, excludeReceiptId }) {
      if (!phash && !dhash) return [];
      const out = [];
      for (const row of hashed.all(campaignId, excludeReceiptId || "")) {
        const dp = hamming(phash, row.phash), dd = hamming(dhash, row.dhash);
        const d = Math.min(dp, dd);
        if (d <= phashDistance) out.push({ receiptId: row.receipt_id, kind: dp <= dd ? "phash" : "dhash", score: Number((1 - d / 64).toFixed(3)), distance: d });
      }
      return out.sort((a, b) => a.distance - b.distance).slice(0, 5);
    },
    canonical(campaignId, key) { return key ? byCanonical.get(campaignId, key) : null; },
  };
}

/** Behavioural risk signals: recorded for review, never auto-decisions. */
export function behaviouralSignals({ periodSubmissions = 0, periodDuplicates = 0, failedAttempts = 0 }) {
  return { velocity: periodSubmissions > 20, repeatedDuplicates: periodDuplicates > 3, repeatedFailures: failedAttempts > 5 };
}
