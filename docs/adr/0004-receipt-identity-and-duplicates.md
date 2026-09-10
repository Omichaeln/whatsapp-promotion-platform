# ADR-0004 Receipt identity and duplicate handling

**Status:** accepted

**Decision.** A purchase is identified by a canonical key `outletId|YYYY-MM-DD|receiptNo|totalMinor`. Credit is enforced by `UNIQUE(campaign_id, canonical_key)` on `canonical_receipts` and a partial `UNIQUE(canonical_receipt_id)` on `entries`; concurrent submissions of one purchase resolve at the constraint, and the loser receives `DUPLICATE`. A submission without a complete identity cannot be auto-credited (review). Byte hashes catch exact resubmissions; aHash/dHash are recorded as reviewer **search signals** only — same-till receipts are indistinguishable at 8×8, so they never decide.

**Alternatives rejected.** Receipt number alone (repeats across days/branches); image hash as proof (false positives across legitimate receipts, false negatives on crops). Ownership disputes route to review: when a purchase was first presented by a different participant and is not credited, the second presenter is never auto-credited (reason `ownership_dispute`), whether the first attempt is still pending or was rejected; the first uploader is not assumed to be the purchaser either. A previously unreadable attempt never consumes the receipt.
