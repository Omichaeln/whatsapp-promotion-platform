-- 006_desk.sql
-- Desk workflow layer (restored from the original WhatsApp Desk):
-- filed messages from the linked device, per-chat threads with AI triage
-- results, periodic briefs, and model usage metering.

create table if not exists desk_messages (
  id integer primary key autoincrement,
  message_sid text unique,
  chat_type text not null,          -- direct | group
  chat_id text not null,
  chat_name text,
  sender_name text,
  message_text text not null,
  processed integer not null default 0,
  timestamp text not null
);
create index if not exists idx_desk_msgs_ts on desk_messages(timestamp);
create index if not exists idx_desk_msgs_pending on desk_messages(processed, timestamp);

create table if not exists desk_threads (
  chat_id text primary key,
  chat_type text not null,
  chat_name text,
  category text not null default 'Other',
  priority text not null default 'normal',   -- high | normal | low
  needs_reply integer not null default 0,
  confidence integer not null default 3,     -- 1..5
  summary text,
  draft text,
  status text not null default 'open',       -- open | filed
  last_message_at text,
  updated_at text not null
);
create index if not exists idx_desk_threads_open on desk_threads(status, priority);

create table if not exists desk_briefs (
  id integer primary key autoincrement,
  brief_md text not null,
  pulse text,
  message_count integer not null default 0,
  direct_count integer not null default 0,
  group_count integer not null default 0,
  model text,
  made_by text not null default 'fallback',
  created_at text not null
);

create table if not exists usage (
  id integer primary key autoincrement,
  kind text not null,               -- triage | draft | voice | ask | classify
  model text,
  route text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  audio_seconds real not null default 0,
  usd real not null default 0,
  created_at text not null
);
create index if not exists idx_usage_month on usage(created_at);

-- Activity feed (restored dashboard "recent activity")
create table if not exists activity_events (
  id integer primary key autoincrement,
  kind text not null,               -- message | brief | entry | review | draw | send | link | system
  summary text not null,
  detail_json text not null default '{}',
  created_at text not null
);
create index if not exists idx_activity_ts on activity_events(created_at);