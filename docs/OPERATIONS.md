# Operations

## Runbooks

### Provider (WhatsApp) outage
- SMS/observe delivery states; outbound messages remain `pending` in the
  ledger and resume on next worker tick (bounded exponential backoff).
- Inbound is never lost: webhook intake is durable before processing.

### Webhook replay storm
- Unique `provider_message_id` dedupes replays; `/webhooks/whatsapp` responds
  200 with `deduped` count; no second entry can be created.

### Media / object-store failure
- Receipt stays `processing`; worker retries download; terminal failure ->
  participant told to re-upload; no qualification without media.

### Receipt model drift
- Monitor validation confidence + review rate; low-confidence receipts route
  to review (never auto-qualify); re-run the labelled corpus benchmark.

### Review backlog
- `review_tasks` with SLA (`sla_due_at`); alert operations on age; escalate;
  assignees per campaign governance.

### CRM outage
- CRM outbox retains jobs; `crm_sync_jobs.status=dead` after 8 attempts;
  `/api/crm-sync` shows reconciliation (pending/delivered/dead); replay on
  restricted role. Entries are never rolled back.

### Draw dispute
- Export the draw record (snapshot hash, algorithm, seed, output hash);
  run `npm run reconstruct-draw -- <draw_id>`; a second operator reproduces
  the winner order or the dispute is resolved from evidence. Approved draws
  are immutable; a rerun is a new authorized linked draw.

### Restore / rollback
- SQLite: WAL + file backup; restore test = `cp` backup, run `npm test`.
  Production (Postgres/Supabase): point-in-time restore; RPO/RTO targets in
  spec §16.1 must be exercised before launch.

## Monitoring signals
inbound rate + failure; conversation completion by state; registration +
consent states; receipts by status + latency; qualification rate + reasons;
duplicate & probable-duplicate rates; extractor confidence/latency/cost;
review backlog and SLAs; entries by outlet/product/period; outbound delivery
state; CRM outbox latency/dead letters; draw + claim state; queue age.

## Retention (configurable via env)
raw receipts `RETENTION_RAW_RECEIPTS_DAYS` (default 90), extracted facts
`RETENTION_FACTS_DAYS` (default 180), audit events append-only; exports
watermarked (`EXPORT_WATERMARK`). Legal owner must confirm final periods.

## Launch gate (acceptance criteria A-01..A-14)
1. Meta business assets + client number + approved templates (D-20).
2. Frozen rules/terms/privacy content (D-01..D-06, D-11..D-13, D-19).
3. Outlet + product master (D-08, D-02/03).
4. Labelled receipt corpus benchmark above safety thresholds (G-07).
5. Exact-duplicate + draw reconstruction tests green (proven here).
6. Authorization matrix test, load test, backup restore, rollback.
7. Named operators, reviewers, draw officer + approver, on-call (D-17).
8. Phone UAT with approved test numbers; client sign-off.
9. Controlled pilot -> production activation with pause/rollback ready.

Until then the system runs safely in `simulator` mode; production activation is
blocked by design (fail-closed on unproven eligibility, unapproved content,
missing assets).