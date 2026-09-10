# ADR-0002 Persistence and work queue

**Status:** accepted

**Context.** The existing app used SQLite via `node:sqlite` with a Railway volume. The spec's recommended default for a new build is a PostgreSQL-compatible database with a database-backed queue.

**Decision.** Keep SQLite (WAL, `busy_timeout`) as the transactional store: it is already deployed, single-writer semantics give us serialised audit-chain appends for free, and the declared engineering volumes (≈20k receipts, ≈200/h peak) are far below its limits. Queues are tables (`channel_events`, `jobs`, `outbound_messages`, `crm_events`) with leases, attempts, backoff and dead letters; no broker.

**Trade-off recorded.** SQLite means one application process writes; horizontal scaling of the OCR worker requires either multiple processes sharing the volume (WAL allows it) or moving to PostgreSQL. Backups are file snapshots (`VACUUM INTO`) rather than PITR; RPO is the backup interval (≤15 min recommended). If the client's expectations (D-21) exceed ~1k receipts/hour or require multi-node, migrate to PostgreSQL: the data layer uses plain SQL through one `db.mjs` module, and migrations are expand-only.

**Failure modes.** Volume loss = data loss since last backup (restore rehearsal script + runbook). Disk full → writes fail → webhook returns 503 → provider retries.
