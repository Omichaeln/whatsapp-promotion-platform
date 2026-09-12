-- 011: pending MFA secret, hot-path indexes, dead retention metadata.
--
-- 1. admin_users.mfa_pending_secret
--    Enrolling an authenticator used to overwrite the live secret and clear
--    mfa_enabled, so re-opening the enrol screen (or anyone holding a session
--    token) silently switched the second factor off. The new secret now waits
--    here until a valid code confirms it, and the live factor is untouched.
--
-- 2. receipts(media_asset_id)
--    duplicates.exactImageMatches joins receipts -> media_assets on the media
--    id and filters on media_assets.sha256. Without an index on the join column
--    the only way in was receipts(campaign_id), so every submission re-read
--    every receipt in the campaign. With table statistics present the planner
--    can now drive the query from idx_media_sha and seek here instead.
--    NOTE: an index on receipts(campaign_id, created_at) was also proposed for
--    the visual-candidate query. Measured on this schema at 40k receipts it
--    makes the ORDER BY cheaper (60 -> 21 ms) but, with no sqlite_stat1 present,
--    the planner then prefers it for the sha256 query too and that goes 40 ->
--    114 ms. It is only a win together with ANALYZE, and ANALYZE cannot be run
--    from a migration (on a fresh database it would freeze "empty table" stats
--    into sqlite_stat1), so it is left to an operational maintenance step.
--
-- 3. entries(campaign_id, period_code, status, participant_id)
--    Every v2 query filters entries by period_code, which 007 added without an
--    index; the v1 indexes on draw_period contributed only their campaign_id
--    prefix. participant_id is the 4th column on purpose: it keeps
--    countPeriodEntries (run on every receipt) a covering seek instead of
--    regressing it onto a period-wide scan. Measured at 80k entries: draw
--    barrier 41 -> 14 ms, per-receipt count 0.0070 -> 0.0027 ms.
--
-- 4. The retention_* rows written by 005 are read by nothing (retention comes
--    from the environment, src/config.mjs), so they could only ever contradict
--    the configured values. schema_version is now derived by migrate().

alter table admin_users add column mfa_pending_secret text;

create index if not exists idx_receipts_media on receipts(media_asset_id);
create index if not exists idx_entries_period_code on entries(campaign_id, period_code, status, participant_id);

delete from schema_meta where key in ('retention_raw_receipts_days', 'retention_facts_days');
