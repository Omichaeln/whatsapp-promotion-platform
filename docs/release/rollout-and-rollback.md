# Rollout, abort and rollback

1. `npm run ci` green on the commit (check, tests, benchmark, dependency audit).
2. Deploy to **staging** (Railway service with `ENVIRONMENT=staging`, its own volume). Bootstrap migrates and, because it is non-production, seeds the sample campaign and sample staff (temporary passwords in the deploy log).
3. Smoke: `/health/live`, `/health/ready` (extractor ok), sign in, Readiness page (providers + sample indicator), simulator journey with `valid-two-pack-A.jpg`.
4. Real-phone check on the test number once Meta assets exist (docs/integrations/whatsapp.md §6).
5. Promote the same commit to **production** (`ENVIRONMENT=production`): no seeding, simulator disabled, activation gated. Migrations run at start (expand-only). Order: deploy → migrate (automatic) → verify queries → keep intake paused until the campaign is activated via the validator.
6. Abort thresholds: `/health/ready` failing for >2 minutes, `inbound.dead_letter` alerts, extractor failures >5% of receipts in the first hour, outbound `permanent_failure` spike. Pause intake/outbound via campaign pause switches (no redeploy needed).
7. Rollback: redeploy the previous commit; schema is compatible one release back (ADR-0007). Data written by the newer release remains (entries, draws). Never reseed in production.
8. Recovery: docs/runbooks/restore-and-rollback.md.

Operational ownership (to be named by the client, D-20): platform administrator (deploy, secrets, monitoring), campaign manager (configuration, activation), reviewers, draw officer and a distinct approver, fulfilment, auditor, support, privacy owner.
