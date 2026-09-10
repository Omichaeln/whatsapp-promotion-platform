# Production checklist assessment (engineering self-review; not a human sign-off)

Legend: **verified** (evidence in repo/tests), **open** (consequence stated), **n/a**.

## Correctness and contracts
- Participant journeys T-01…T-16 automated — verified (test/journey, test/receipt-ocr).
- API contract published — verified (`GET /api/openapi.json`, error envelope with codes + correlation ids).
- Idempotency at every boundary — verified (events, jobs, outbox keys, CRM versions, approval replay).

## Security
- Authn/authz server-side on every route, MFA available, temporary passwords, rate limit — verified (test/security).
- Secrets not in repo; production refuses dev keys — verified (`validateConfig`).
- Webhook signature verification — verified (T-28); live Meta round-trip — **open** (no credentials).
- Dependency audit — verified (`npm run audit:deps`, 0 vulnerabilities; evidence/dependency-audit.txt).
- Privileged staff MFA enforced by policy — **open**: activation validator requires it; enrolment is self-service.

## Reliability
- Durable intake, leases, dead letters, retries, unknown-outcome handling — verified.
- Load benchmark — verified locally (evidence/load-benchmark.json: 30 receipts from 5 concurrent phones, webhook ack p95 16 ms, decision p95 ≈4.9 s with real OCR on one worker, ≈50 receipts/min, 0 double credits); the declared peak of 200 receipts/hour is within this; real-provider latency **open**.
- Single-node SQLite — **open** risk (ADR-0002); mitigation: backups ≤15 min, restore rehearsal script.

## Observability and operations
- Structured request logs with correlation ids, metrics table, alerts with runbooks — verified; external alert routing (email/Slack) **open** (destination not configured; alerts are in-console).
- Runbooks — verified (docs/runbooks).

## Data
- Expand-only migrations, rehearsal, integrity checks in restore script — verified.
- Retention job for media; facts retention — media purge verified (job), facts purge **open** (policy D-22).
- Personal-data lifecycle (correction, withdrawal, anonymisation) — verified (T-31).

## Release
- Reproducible build from lockfile, preflight, seed/reset guards — verified.
- Rollback path documented; previous-release compatibility — verified by design (ADR-0007), rehearsal on populated DB — verified locally.

## Client gates (all open until the client acts)
- Decisions D-01…D-22 approved with values; real outlet/product masters; representative receipt corpus benchmark accepted; Meta assets and templates; CRM vendor + sandbox or "post-launch" approval; named owners; client UAT sign-off.
