-- 002_promotion_domain.sql
-- Campaigns + immutable versions, outlets, products, participants, consents,
-- conversation sessions, inbound webhook events.

create table if not exists campaigns (
  id text primary key,
  code text not null unique,
  name text not null,
  status text not null default 'draft', -- draft|active|paused|closed|archived
  timezone text not null default 'Africa/Harare',
  start_at text not null,
  end_at text not null,
  weekly_cutoff_hour integer not null default 23,
  weekly_cutoff_minute integer not null default 59,
  draw_config_json text not null default '{}', -- {prizes:[{code,label,per_week}], alternates_per_winner, winner_exclusion}
  created_at text not null,
  updated_at text not null
);

create table if not exists campaign_versions (
  id text primary key,
  campaign_id text not null references campaigns(id),
  version_no integer not null,
  status text not null default 'draft', -- draft|activated
  frozen_at text,
  frozen_by text,
  content_json text not null default '{}',   -- copy: menu, mechanics, terms_url, prizes, help, errors
  rules_json text not null default '{}',     -- products, threshold, caps, exclusions
  flags_json text not null default '{}',     -- feature flags e.g. {"participant_status":false}
  config_hash text not null,
  unique (campaign_id, version_no)
);
create index if not exists idx_versions_active on campaign_versions(campaign_id, status);

create table if not exists outlets (
  id text primary key,
  outlet_code text not null unique,
  retailer text not null,
  branch text not null,
  town text not null,
  province text not null,
  collection_enabled integer not null default 1,
  active_from text not null default '1970-01-01',
  active_to text not null default '9999-12-31'
);
create index if not exists idx_outlets_retailer on outlets(retailer, town);

create table if not exists products (
  id text primary key,
  sku text not null unique,
  brand text not null,
  name text not null,
  aliases_json text not null default '[]',
  pack_weight_kg real not null,
  unit text not null default 'pack',
  active integer not null default 1
);

create table if not exists participants (
  id text primary key,
  wa_phone_uid text not null unique,     -- normalized e.g. 2637xxxxxxxxx (no +, no spaces)
  first_name text not null,
  surname text not null,
  identity_enc text,                     -- encrypted high-risk identity value (D-06)
  identity_masked text,                  -- e.g. 63******21
  identity_hash text,                    -- for duplicate checks
  location text,
  age_confirmed integer not null default 0,
  status text not null default 'active', -- active|withdrawn|blocked
  created_at text not null,
  updated_at text not null
);

create table if not exists consents (
  id text primary key,
  participant_id text not null references participants(id),
  terms_version text not null,
  privacy_version text not null,
  channel text not null default 'whatsapp',
  accepted_at text not null,
  withdrawn_at text
);

create table if not exists conversation_sessions (
  id text primary key,
  campaign_id text not null,
  wa_phone_uid text not null,
  participant_id text references participants(id),
  state text not null,                   -- see src/conversation.mjs STATES
  context_json text not null default '{}',
  updated_at text not null,
  expires_at text not null,
  unique (campaign_id, wa_phone_uid)
);
create index if not exists idx_sessions_state on conversation_sessions(state, expires_at);

create table if not exists inbound_events (
  id text primary key,
  provider_message_id text not null unique,
  campaign_id text,
  wa_phone_uid text not null,
  provider text not null default 'whatsapp-cloud-api',
  payload_json text not null,
  media_id text,
  status text not null default 'received', -- received|processed|failed
  error text,
  received_at text not null,
  processed_at text
);
create index if not exists idx_inbound_status on inbound_events(status, received_at);