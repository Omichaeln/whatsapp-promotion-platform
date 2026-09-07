-- 005_indexes_retention.sql
-- Lookup indexes for campaign-scoped participant lookups, review queue,
-- fingerprint lookup, draw eligibility, outbound delivery, CRM reconciliation
-- and audit search; retention metadata key.

create index if not exists idx_entries_eligibility on entries(campaign_id, draw_period, status) where status='active';
create index if not exists idx_receipts_processing on receipts(status) where status in ('received','processing');
create index if not exists idx_media_open on media_assets(created_at) where status='stored';
create index if not exists idx_outbox_entity on crm_sync_jobs(entity_type, entity_id);
create index if not exists idx_audit_actor on audit_events(actor_type, actor_id);

insert or replace into schema_meta (key, value) values ('retention_raw_receipts_days', '90');
insert or replace into schema_meta (key, value) values ('retention_facts_days', '180');
insert or replace into schema_meta (key, value) values ('schema_version', '5');