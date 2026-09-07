-- 001_foundation.sql
-- Admin identity, auth tokens, append-only audit (hash-chained).

create table if not exists schema_meta (
  key text primary key,
  value text not null
);

create table if not exists admin_users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,          -- scrypt
  mfa_secret text,
  mfa_enabled integer not null default 0,
  roles text not null default '[]',     -- json array: campaign_manager, reviewer, draw_officer, draw_approver, winner_ops, support, auditor, platform_admin
  status text not null default 'active',-- active | disabled
  last_login_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists auth_tokens (
  id text primary key,
  token_hash text not null unique,      -- sha256(bearer token), raw token never stored
  admin_user_id text not null references admin_users(id),
  expires_at text not null,
  created_at text not null,
  revoked_at text
);
create index if not exists idx_auth_tokens_user on auth_tokens(admin_user_id);

create table if not exists audit_events (
  id integer primary key autoincrement,
  actor_type text not null,             -- admin | system | participant
  actor_id text,
  action text not null,
  target_type text not null,
  target_id text,
  reason text,
  request_id text,
  prev_hash text not null default '',
  entry_hash text not null,             -- sha256(prev_hash|action|target|payload|when)
  payload_json text,
  created_at text not null
);
create index if not exists idx_audit_target on audit_events(target_type, target_id);
create index if not exists idx_audit_created on audit_events(created_at);