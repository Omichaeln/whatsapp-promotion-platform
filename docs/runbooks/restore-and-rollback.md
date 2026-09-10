# Restore and rollback

**Backup:** `npm run restore:rehearsal` creates `data/backups/<stamp>/` (database via `VACUUM INTO` + media copy), restores it into `data/restore-test/<stamp>/`, opens it, checks integrity (audit chain, no double credits, no orphan entries, draws recompute, media present), lists outstanding jobs/outbound work, and reports RTO. Production: schedule the backup step at ≤15-minute intervals to an off-host location (Railway volume snapshots or object storage).

**Restore:** stop the service; copy the backup database and media into place; start; the worker resumes leases and outstanding jobs; idempotency keys prevent double messages/awards; run `GET /api/audit/verify` and the draw verifier for any executed draws.

**Rollback of a release:** deploy the previous artifact; migrations are expand-only from 007 onward (008 rebuilt `draws` with identical columns, compatible with the previous code). Reverting code never removes entries or reseeds prizes.
