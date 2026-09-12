# Migrations

Ordered SQL files in `db/migrations/`, tracked in `schema_meta.migrations`, applied by `npm run migrate` and automatically at server start (each file in its own transaction; a failure rolls that file back and stops).

| File | Type | Notes |
|---|---|---|
| 001–006 | original schema | untouched |
| 007_promotion_v2.sql | expand-only | new tables (periods, enrollments, channel_events, canonical_receipts, duplicate_candidates, entry_events, crm_events, crm_external_refs, settings, campaign_decisions, alerts, jobs, metrics, audit_checkpoints, draw_attempts) and added columns; no drops |
| 008_audit_chain_integrity.sql | expand-only (index) | partial UNIQUE `ux_audit_events_prev_hash_v2` on `audit_events(prev_hash)`, covering only version-2 chain rows, so two writers reading the same head cannot fork the chain. Partial on purpose: rows written by earlier releases are excluded, so it cannot fail at boot on a database that already contains a fork. Rollback: the previous release ignores it; drop the index only if it blocks a legacy writer |
| 009_draw_seed_commitment.sql | expand-only (column) | `draws.seed_commitment` — sha256 of the draw seed, recorded at freeze and re-checked at execute so the seed cannot be swapped between the two. Nullable: draws frozen by the previous release read NULL and the previous release ignores the column |
| 010_canonical_printed_identity.sql | expand-only (column + index) | `canonical_receipts.receipt_no_norm` plus `ix_canonical_printed_identity(campaign_id, txn_date, receipt_no_norm, total_minor)`, for the outlet-independent printed identity check; the backfill only uppercases existing `receipt_no`. Rollback: previous release ignores both |
| 011_mfa_pending_and_hot_indexes.sql | expand-only (column + indexes) | `admin_users.mfa_pending_secret` (an enrolment in progress no longer overwrites the live MFA secret), `idx_receipts_media` and `idx_entries_period_code` for the duplicate and entry-count hot paths, and it deletes the dead `retention_*` rows from `schema_meta` (retention comes from the environment). Rollback: the previous release ignores the column and the indexes |

Rehearsal (T-34): `npm run migrate` twice on a fresh database (second run reports "schema up to date"), and 007 applied to a populated v1-shaped database with foreign keys ON — row counts and integrity verified (`docs/testing/evidence/migration-rehearsal.json`). A planned rebuild of `draws` was rejected after rehearsal (ADR-0007) and never became a migration — the file that occupies 008 is the audit-chain index above, and `draws` has since been changed only by the additive 009. Rollback: 007 is additive; the previous release ignores the new tables/columns. Forward recovery is preferred over downgrade.

Verification queries after deploy:
```sql
-- `migrations` must name every file in db/migrations/; `schema_version` is derived from it
select value from schema_meta where key in ('migrations','schema_version','environment');
select count(*) from draws; select count(*) from entries where status='active';
```
`schema_meta.schema_version` is derived by `migrate()` from the applied ledger (the highest migration number it has recorded), so it needs no migration to bump it and cannot drift from the list. It was hand-maintained until this release and did drift: 005 wrote `5` with `insert or replace` and 007's `insert or ignore` was a no-op on the existing key, so a fully migrated database reported `5` and an operator could not tell it from one stuck at 005. A volume last migrated by an older release still reads `5` until this release's `migrate()` runs, which corrects it at boot — so read the value **after** the deploy, not from a snapshot taken before it. The `migrations` list stays the authoritative signal: `npm run preflight` compares its length with the files in `db/migrations/`.
