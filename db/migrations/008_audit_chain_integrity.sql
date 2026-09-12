-- 008: structural protection for the audit hash chain.
--
-- The chain is append-only: every row's prev_hash is the previous row's
-- entry_hash, so prev_hash must be unique. Without that constraint two writers
-- (the server and a standalone worker, per README) can read the same head and
-- both append, forking the chain permanently — verify() then reports
-- prev_mismatch and the trail is no longer provable.
--
-- The index is PARTIAL, covering only rows written with the version 2 body
-- (src/audit.mjs). Chains written before this release may already contain a
-- fork; excluding those rows keeps this migration from failing at boot on an
-- existing deployment, while every row written from now on is protected.
-- verify() still reports any legacy fork, and counts v1 rows as `unattributed`.
create unique index if not exists ux_audit_events_prev_hash_v2
  on audit_events (prev_hash)
  where json_valid(payload_json) and json_extract(payload_json, '$.v') >= 2;

-- Reading the chain head is the hot path of every audited action.
create index if not exists ix_audit_events_id_desc on audit_events (id desc);
