-- 003_media_receipts_entries.sql
-- Private media assets, receipts, extracted items, append-only validation
-- results, and the immutable entry ledger.

create table if not exists media_assets (
  id text primary key,
  object_key text not null unique,      -- private path under MEDIA_DIR, never a public URL
  mime text not null,
  size_bytes integer not null,
  sha256 text not null,
  phash text,                           -- perceptual hash (hex of 64 bits)
  provider_media_id text,
  campaign_id text,
  status text not null default 'stored',
  created_at text not null,
  expires_at text
);
create index if not exists idx_media_sha on media_assets(sha256);

create table if not exists receipts (
  id text primary key,
  provider_message_id text not null unique,   -- one active receipt per inbound message
  participant_id text not null references participants(id),
  campaign_id text not null references campaigns(id),
  campaign_version_id text not null references campaign_versions(id),
  media_asset_id text references media_assets(id),
  selected_outlet_id text,
  fingerprint text,                     -- normalized outlet|date|receipt_no|total
  status text not null default 'received', -- received|processing|qualified|not_qualified|duplicate|needs_review|error
  reason_code text,                     -- stable participant-facing code
  decided_by text,                      -- automation-version or admin id
  decided_at text,
  created_at text not null
);
create index if not exists idx_receipts_status on receipts(status, created_at);
create index if not exists idx_receipts_participant on receipts(participant_id, campaign_id);
create index if not exists idx_receipts_fingerprint on receipts(fingerprint) where fingerprint is not null;

create table if not exists receipt_items (
  id text primary key,
  receipt_id text not null references receipts(id),
  description text not null,
  sku text,
  quantity real not null default 1,
  unit_weight_kg real,
  amount real,
  evidence_json text
);

create table if not exists validation_results (
  id text primary key,
  receipt_id text not null references receipts(id),
  attempt_no integer not null default 1,
  extractor_provider text not null,
  extractor_version text not null,
  facts_json text,                      -- normalized extracted_receipt evidence
  confidence real,
  rule_results_json text,               -- per-rule pass/fail/review + reasons
  risk_signals_json text,
  decision text not null,
  error text,
  created_at text not null
);
create index if not exists idx_validation_receipt on validation_results(receipt_id, attempt_no);

create table if not exists entries (
  id text primary key,
  receipt_id text not null unique references receipts(id),
  participant_id text not null references participants(id),
  campaign_id text not null references campaigns(id),
  campaign_version_id text not null references campaign_versions(id),
  draw_period text not null,            -- e.g. 2026-W38 (ISO week of receipt) or campaign 'weekly-1'
  entry_no integer not null,            -- per participant per campaign sequence
  status text not null default 'active',-- active|excluded|withdrawn
  created_at text not null
);
create index if not exists idx_entries_draw on entries(campaign_id, draw_period, status);
create index if not exists idx_entries_participant on entries(participant_id, campaign_id);