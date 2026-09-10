# Media and extraction failures [platform_admin, reviewer]

- Receipt `delayed`: extractor threw (timeout, OCR worker crash) — the participant was told, a retry job is scheduled (up to 6, backoff), alert `receipt.extractor`. Check `/health/ready` (extractor health) and memory; restart if the WASM worker is wedged.
- `receipt.stuck` alert: retries exhausted — use Receipts → Reprocess after the cause is fixed, or decide manually in review.
- Media unavailable (provider link expired before download): the participant is asked to re-upload; the attempt is linked to the new one.
- Retention: `media.purge` job removes originals after `RETENTION_RAW_RECEIPTS_DAYS`; metadata rows remain with status `purged`.
