# Migrations

Ordered SQL files in `db/migrations/`, tracked in `schema_meta.migrations`, applied by `npm run migrate` and automatically at server start (each file in its own transaction; a failure rolls that file back and stops).

| File | Type | Notes |
|---|---|---|
| 001–006 | original schema | untouched |
| 007_promotion_v2.sql | expand-only | new tables (periods, enrollments, channel_events, canonical_receipts, duplicate_candidates, entry_events, crm_events, crm_external_refs, settings, campaign_decisions, alerts, jobs, metrics, audit_checkpoints, draw_attempts) and added columns; no drops |

Rehearsal (T-34): `npm run migrate` twice on a fresh database (second run reports "schema up to date"), and 007 applied to a populated v1-shaped database with foreign keys ON — row counts and integrity verified (`docs/testing/evidence/migration-rehearsal.json`). A planned rebuild of `draws` (008) was rejected after rehearsal (ADR-0007). Rollback: 007 is additive; the previous release ignores the new tables/columns. Forward recovery is preferred over downgrade.

Verification queries after deploy:
```sql
select value from schema_meta where key in ('migrations','schema_version','environment');
select count(*) from draws; select count(*) from entries where status='active';
```
