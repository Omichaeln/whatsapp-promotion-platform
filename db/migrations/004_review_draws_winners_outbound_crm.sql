-- 004_review_draws_winners_outbound_crm.sql
-- Human review, immutable draws + candidates, winners + claims, outbound
-- message ledger, transactional CRM outbox.

create table if not exists review_tasks (
  id text primary key,
  receipt_id text not null unique references receipts(id),
  state text not null default 'open',   -- open|assigned|decided
  assignee text,
  decision text,                        -- qualified|rejected|duplicate|request_reupload
  reason_code text,
  note text,
  decided_by text,
  decided_at text,
  sla_due_at text not null,
  created_at text not null
);
create index if not exists idx_review_state on review_tasks(state, sla_due_at);

create table if not exists draws (
  id text primary key,
  campaign_id text not null references campaigns(id),
  draw_period text not null,
  status text not null default 'draft', -- draft|frozen|executed|approved|published|superseded
  config_hash text not null,
  snapshot_json text,                   -- frozen candidate list (entries + exclusions)
  snapshot_hash text not null,
  algorithm text not null default 'hmac-sha256-sortition',
  seed_hex text,
  evidence_json text,                   -- {operator, executed_at, config_hash, output_hash, ...}
  output_json text,                     -- ordered winners + alternates
  output_hash text,
  operator_id text,
  approver_id text,
  executed_at text,
  approved_at text,
  published_at text,
  superseded_by text,
  reason text,
  created_at text,
  unique (campaign_id, draw_period)
);
create index if not exists idx_draws_status on draws(campaign_id, status);

create table if not exists draw_candidates (
  id text primary key,
  draw_id text not null references draws(id),
  position integer not null,
  entry_id text not null references entries(id),
  status text not null default 'eligible', -- eligible|excluded
  exclusion_reason text
);
create index if not exists idx_candidates_draw on draw_candidates(draw_id, position);

create table if not exists winners (
  id text primary key,
  draw_id text not null references draws(id),
  rank integer not null,
  entry_id text not null references entries(id),
  participant_id text not null references participants(id),
  prize_code text not null,
  status text not null default 'pending', -- pending|notified|verified|accepted|collected|expired|replaced
  notify_state text,                    -- {attempts, provider_message_id, delivered_at}
  published_fields_json text,           -- only approved disclosure fields
  history_json text not null default '[]',
  unique (draw_id, rank)
);

create table if not exists claims (
  id text primary key,
  winner_id text not null references winners(id),
  state text not null,                  -- awaiting_response|verified|accepted|collected|expired|rejected|replaced
  detail_json text,
  transitioned_at text not null
);

create table if not exists outbound_messages (
  id text primary key,
  provider text not null default 'whatsapp-cloud-api',
  wa_phone_uid text not null,
  kind text not null default 'text',    -- text|interactive|template
  payload_json text not null,           -- approved content or template params
  idempotency_key text not null unique, -- business key: e.g. receipt:{id}:outcome
  provider_message_id text,
  status text not null default 'pending', -- pending|sent|delivered|read|failed
  attempts integer not null default 0,
  next_attempt_at text,
  last_error text,
  created_at text not null,
  sent_at text
);
create index if not exists idx_outbound_status on outbound_messages(status, next_attempt_at);

create table if not exists crm_sync_jobs (
  id text primary key,
  entity_type text not null,            -- participant|entry|winner|claim
  entity_id text not null,
  event_type text not null,             -- upsert|status_change
  payload_hash text not null,
  external_key text,                    -- stable external id when known
  payload_json text not null,
  status text not null default 'pending', -- pending|delivered|dead|reconciled
  attempts integer not null default 0,
  next_attempt_at text,
  last_error text,
  external_id text,
  created_at text not null,
  delivered_at text,
  unique (entity_type, entity_id, event_type)
);
create index if not exists idx_crm_status on crm_sync_jobs(status, next_attempt_at);