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
 *
 * The TOTAL is in the key for historical reasons but is NOT part of the
 * identity: it is the least reliable field on the slip (a faded TOTAL line, an
 * extra "TOTAL" row, one misread digit). Matching on the key alone let one
 * purchase mint two identities — "…|004512|" from the photo whose total could
 * not be read and "…|004512|620" from a second photo of the SAME slip — and
 * credited it twice. claim() therefore resolves a canonical row on the stable
 * identity (outlet + date + receipt number) whatever the total reads.
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
  // Same outlet, same day, same printed receipt number: one till slip. The
  // total is evidence recorded alongside the identity, never part of it, so a
  // row whose total was unreadable (or read differently) still resolves here.
  // A credited row wins over a pending one so the duplicate/ownership path
  // sees the claim that actually holds the entry.
  const byOutletIdentity = db.prepare(`select * from canonical_receipts
    where campaign_id = ? and outlet_id = ? and txn_date = ? and receipt_no_norm = ?
    order by case when status = 'credited' then 0 else 1 end, created_at limit 1`);

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
    /**
     * The canonical row for this purchase, and HOW it was matched.
     * Returns null, or { row, matchedBy: "key" | "identity", totalsDiffer }.
     *
     * "key" is the exact canonical key and is conclusive. "identity" matched
     * only outlet + date + printed number, ignoring the total, so that a
     * receipt whose TOTAL was unreadable and a second photograph of the same
     * slip whose total was readable resolve to ONE identity instead of two.
     *
     * That fallback cannot be conclusive on its own. A till counter repeats,
     * and two genuinely different purchases at one branch on one day can print
     * the same number; the total is then the ONLY field that separates them.
     * `totalsDiffer` reports exactly that disagreement (both totals present and
     * unequal) so the caller can route it to a person instead of silently
     * collapsing two purchases into one claim.
     */
    claim(campaignId, { outletId, date, receiptNo, totalMinor }) {
      const key = canonicalKeyOf({ outletId, date, receiptNo, totalMinor });
      const exact = key ? byCanonical.get(campaignId, key) : null;
      if (exact) return { row: exact, matchedBy: "key", totalsDiffer: false };
      if (!outletId || !date || !receiptNo) return null;
      const row = byOutletIdentity.get(campaignId, outletId, date, normaliseReceiptNo(receiptNo));
      if (!row) return null;
      const totalsDiffer = row.total_minor != null && totalMinor != null && Number(row.total_minor) !== Number(totalMinor);
      return { row, matchedBy: "identity", totalsDiffer };
    },
  };
}

/** Behavioural risk signals: recorded for review, never auto-decisions. */
export function behaviouralSignals({ periodSubmissions = 0, periodDuplicates = 0, failedAttempts = 0 }) {
  return { velocity: periodSubmissions > 20, repeatedDuplicates: periodDuplicates > 3, repeatedFailures: failedAttempts > 5 };
}
