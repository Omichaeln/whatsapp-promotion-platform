-- 007_promotion_v2.sql (expand-only; no drops/renames — see docs/release/migrations.md)
-- Periods, enrollments, canonical receipts, duplicate candidates, entry events,
-- durable channel-event queue, versioned CRM outbox, draw execution state,
-- winner lifecycle, settings/approvals, audit checkpoints, alerts, jobs.

insert or ignore into schema_meta (key, value) values ('schema_version', '7');

-- ---- settings + campaign decision approvals ------------------------------
create table if not exists settings (
  key text primary key,
  value_json text not null,
  updated_by text,
  updated_at text not null
);

create table if not exists campaign_decisions (
  id text primary key,
  campaign_id text not null references campaigns(id),
  decision_id text not null,              -- D-01..D-22 (+ discovered)
  question text not null,
  test_value text,                        -- value used in TEST ONLY configuration
  approved_value text,                    -- client-approved live value (null until approved)
  status text not null default 'open',    -- open|proposed|approved|not_required
  owner text,
  approved_by text,
  approved_at text,
  evidence text,
  blocks_activation integer not null default 1,
  updated_at text not null,
  unique (campaign_id, decision_id)
);

-- ---- campaign periods (half-open UTC windows in campaign tz) --------------
create table if not exists campaign_periods (
  id text primary key,
  campaign_id text not null references campaigns(id),
  code text not null,                     -- W1, W2 ...
  label text not null,
  starts_at text not null,                -- inclusive, UTC ISO
  ends_at text not null,                  -- exclusive, UTC ISO
  draw_at text,
  status text not null default 'scheduled', -- scheduled|open|closed|drawn
  prize_config_json text not null default '{}',
  created_at text not null,
  unique (campaign_id, code)
);
create index if not exists idx_periods_campaign on campaign_periods(campaign_id, starts_at);

-- ---- campaign outlet membership + outlet aliases ---------------------------
alter table outlets add column aliases_json text not null default '[]';
alter table outlets add column active integer not null default 1;
alter table outlets add column retailer_code text;
create table if not exists campaign_outlets (
  campaign_id text not null references campaigns(id),
  outlet_id text not null references outlets(id),
  active_from text not null default '1970-01-01',
  active_to text not null default '9999-12-31',
  collection_enabled integer not null default 1,
  primary key (campaign_id, outlet_id)
);

alter table products add column pack_grams integer;
alter table products add column product_code text;

-- ---- participants + enrollment -------------------------------------------
alter table participants add column identity_fp text;     -- keyed HMAC fingerprint (never plain hash)
alter table participants add column phone_confirmed_at text;
alter table participants add column row_version integer not null default 1;
alter table participants add column marketing_consent integer not null default 0;
create index if not exists idx_participants_identity_fp on participants(identity_fp) where identity_fp is not null;

create table if not exists campaign_enrollments (
  id text primary key,
  participant_id text not null references participants(id),
  campaign_id text not null references campaigns(id),
  campaign_version_id text not null references campaign_versions(id),
  terms_version text not null,
  privacy_version text not null,
  marketing_consent integer not null default 0,
  declarations_json text not null default '{}',
  enrolled_at text not null,
  withdrawn_at text,
  unique (participant_id, campaign_id)
);

-- ---- durable channel event queue (replaces inbound_events for processing) --
create table if not exists channel_events (
  id text primary key,
  provider text not null,
  provider_account text not null default 'default',
  provider_message_id text not null,
  event_kind text not null,               -- message.text|message.image|message.document|message.unsupported|delivery.status:<s>
  wa_phone_uid text,
  payload_json text not null,
  media_ref text,
  status text not null default 'received', -- received|processing|processed|failed|dead|ignored
  attempts integer not null default 0,
  lease_until text,
  result_json text,
  error text,
  correlation_id text,
  received_at text not null,
  processed_at text,
  unique (provider, provider_account, provider_message_id, event_kind)
);
create index if not exists idx_channel_events_queue on channel_events(status, received_at);
create index if not exists idx_channel_events_phone on channel_events(wa_phone_uid, received_at);

alter table conversation_sessions add column row_version integer not null default 1;
alter table conversation_sessions add column handoff_owner text;
alter table conversation_sessions add column handoff_since text;
alter table conversation_sessions add column active_receipt_id text;

-- ---- media + receipts (submissions) + canonical receipts -----------------------
alter table media_assets add column width integer;
alter table media_assets add column height integer;
alter table media_assets add column dhash text;
alter table media_assets add column normalized_key text;
alter table media_assets add column quality_json text;
create index if not exists idx_media_dhash on media_assets(dhash) where dhash is not null;

alter table receipts add column canonical_receipt_id text;
alter table receipts add column intake_at text;
alter table receipts add column event_at text;
alter table receipts add column period_code text;
alter table receipts add column reupload_of text;
alter table receipts add column row_version integer not null default 1;
alter table receipts add column channel_event_id text;
alter table receipts add column correlation_id text;
alter table receipts add column extracted_outlet_text text;
alter table receipts add column outlet_match_json text;
alter table receipts add column quality_json text;
create index if not exists idx_receipts_canonical on receipts(canonical_receipt_id);
create index if not exists idx_receipts_period on receipts(campaign_id, period_code, status);

create table if not exists canonical_receipts (
  id text primary key,
  campaign_id text not null references campaigns(id),
  canonical_key text not null,            -- outlet|date|receiptno|total(minor)
  outlet_id text,
  txn_date text,
  receipt_no text,
  total_minor integer,
  currency text,
  first_receipt_id text not null,
  credited_receipt_id text,
  credited_entry_id text,
  status text not null default 'pending', -- pending|credited|review|void
  created_at text not null,
  unique (campaign_id, canonical_key)
);

create table if not exists duplicate_candidates (
  id text primary key,
  receipt_id text not null references receipts(id),
  candidate_receipt_id text not null references receipts(id),
  kind text not null,                     -- exact_sha256|phash|dhash|canonical|provider_message
  score real,
  resolution text not null default 'open', -- open|same_purchase|different_purchase
  resolved_by text,
  resolved_at text,
  note text,
  created_at text not null,
  unique (receipt_id, candidate_receipt_id, kind)
);
create index if not exists idx_dupcand_receipt on duplicate_candidates(receipt_id, resolution);

alter table validation_results add column ocr_text text;
alter table validation_results add column raw_result_json text;
alter table validation_results add column schema_version text;
alter table validation_results add column latency_ms integer;

alter table review_tasks add column row_version integer not null default 1;
alter table review_tasks add column assigned_at text;
alter table review_tasks add column escalated integer not null default 0;

-- ---- entries -----------------------------------------------------------------
alter table entries add column period_code text;
alter table entries add column weight_units integer not null default 1;
alter table entries add column canonical_receipt_id text;
create unique index if not exists uq_entries_canonical on entries(canonical_receipt_id) where canonical_receipt_id is not null;

create table if not exists entry_events (
  id text primary key,
  entry_id text not null references entries(id),
  type text not null,                     -- disqualified|reinstated
  reason text not null,
  actor_id text not null,
  approved_by text,
  effective_at text not null,
  note text,
  created_at text not null
);
create index if not exists idx_entry_events_entry on entry_events(entry_id, effective_at);

-- ---- draws ---------------------------------------------------------------------
alter table draws add column period_id text;
alter table draws add column rules_version_id text;
alter table draws add column prize_plan_json text;
alter table draws add column barrier_json text;
alter table draws add column verifier_version text;
alter table draws add column execution_attempts integer not null default 0;
alter table draws add column voided_at text;
alter table draws add column voided_by text;
alter table draws add column void_reason text;
alter table draws add column supersedes text;
alter table draws add column approval_note text;

create table if not exists draw_attempts (
  id text primary key,
  draw_id text not null references draws(id),
  actor_id text not null,
  outcome text not null,                  -- reserved|completed|aborted|rejected
  detail text,
  created_at text not null
);

-- ---- winners ---------------------------------------------------------------------
alter table winners add column publication_state text not null default 'unpublished'; -- unpublished|published|withdrawn
alter table winners add column verified_at text;
alter table winners add column verified_by text;
alter table winners add column accepted_at text;
alter table winners add column fulfilled_at text;
alter table winners add column fulfilled_by text;
alter table winners add column fulfilment_ref text;
alter table winners add column claim_token_hash text;
alter table winners add column claim_expires_at text;
alter table winners add column collection_outlet_id text;
alter table winners add column row_version integer not null default 1;
alter table winners add column replaced_by text;
alter table winners add column contact_attempts integer not null default 0;
alter table winners add column display_name text;

-- ---- outbound + CRM ---------------------------------------------------------------
alter table outbound_messages add column delivered_at text;
alter table outbound_messages add column read_at text;
alter table outbound_messages add column error_code text;
alter table outbound_messages add column correlation_id text;
alter table outbound_messages add column template_name text;
alter table outbound_messages add column lease_until text;
alter table outbound_messages add column purpose text;      -- reply|receipt_outcome|winner_contact|support
alter table outbound_messages add column campaign_id text;

create table if not exists crm_events (
  id text primary key,
  provider text not null,                 -- none|webhook|contract-receiver|<vendor>
  entity_type text not null,              -- participant|enrollment|consent|submission|entry|winner|claim
  entity_id text not null,
  entity_version integer not null,
  event_type text not null,
  mapping_version text not null,
  external_key text not null,
  payload_json text not null,
  payload_hash text not null,
  status text not null default 'pending', -- pending|sending|delivered|retryable_failure|permanent_failure|unknown_outcome|reconciled
  attempts integer not null default 0,
  lease_until text,
  next_attempt_at text,
  last_error text,
  external_id text,
  readback_json text,
  readback_at text,
  correlation_id text,
  created_at text not null,
  delivered_at text,
  unique (entity_type, entity_id, entity_version, event_type)
);
create index if not exists idx_crm_events_queue on crm_events(status, next_attempt_at);
create index if not exists idx_crm_events_entity on crm_events(entity_type, entity_id);

create table if not exists crm_external_refs (
  entity_type text not null,
  entity_id text not null,
  provider text not null,
  external_id text not null,
  last_entity_version integer not null,
  updated_at text not null,
  primary key (entity_type, entity_id, provider)
);

-- ---- staff --------------------------------------------------------------------------
alter table admin_users add column must_change_password integer not null default 0;
alter table admin_users add column created_by text;
alter table admin_users add column roles_version integer not null default 1;

-- ---- audit checkpoints, alerts, jobs --------------------------------------------------
alter table audit_events add column scope text;
alter table audit_events add column correlation_id text;
create table if not exists audit_checkpoints (
  id text primary key,
  upto_id integer not null,
  head_hash text not null,
  signature text not null,                -- HMAC(AUDIT_CHECKPOINT_KEY, upto_id|head_hash)
  created_by text,
  created_at text not null
);

create table if not exists alerts (
  id text primary key,
  kind text not null,
  severity text not null default 'warning', -- info|warning|critical
  message text not null,
  detail_json text,
  runbook text,
  created_at text not null,
  acknowledged_by text,
  acknowledged_at text
);
create index if not exists idx_alerts_open on alerts(acknowledged_at, created_at);

create table if not exists jobs (
  id text primary key,
  kind text not null,                     -- receipt.reprocess|winner.expire|period.close|...
  payload_json text not null default '{}',
  status text not null default 'pending', -- pending|processing|done|failed|dead
  attempts integer not null default 0,
  run_after text,
  lease_until text,
  last_error text,
  correlation_id text,
  created_at text not null,
  finished_at text
);
create index if not exists idx_jobs_queue on jobs(status, run_after);

create table if not exists metrics_events (
  id integer primary key autoincrement,
  name text not null,
  value real not null default 1,
  labels_json text,
  created_at text not null
);
create index if not exists idx_metrics_name on metrics_events(name, created_at);
