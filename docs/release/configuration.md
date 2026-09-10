# Configuration and release identity

- Configuration schema: `src/config.mjs` (`CONFIG_SCHEMA`) → `.env.example` (names + descriptions only). Preflight: `npm run preflight` (never prints secret values).
- Environment: `ENVIRONMENT=local|test|staging|production`. The database records it at first boot (`schema_meta.environment`); the value governs activation gates, sample-data refusals, simulator availability and the outbound recipient allowlist.
- Required outside local: `ADMIN_PASSWORD` (≥12), `IDENTITY_KEY`, and for production `AUDIT_CHECKPOINT_KEY`, Meta credentials, `WHATSAPP_TRANSPORT=cloud-api`, a real extractor (`tesseract` or `vision` with key).
- Secrets live in the host's variable store (Railway variables); never in the repo. Rotate `META_ACCESS_TOKEN`, `IDENTITY_KEY` (re-encryption job required — not built; treat as a break-glass procedure), `AUDIT_CHECKPOINT_KEY` (older checkpoints verify with the older key).
- Artifact identity: git commit SHA of the deployed branch + `package-lock.json` hash; Railway builds with Nixpacks from `Procfile` (`src/bootstrap.mjs`). The console bundle is committed (`src/web-console-dist/`) and rebuilt with `npm run web:build`.
- Environment separation: separate Railway services/volumes per environment, separate Meta numbers, separate databases; test recipients allowlisted outside production.

## Sample journeys at boot (`SEED_POPULATED`)

Non-production only. When `SEED_POPULATED=true`, the bootstrap runs the populated sample journeys in the background after the server is listening: 12 synthetic participants, 28 fixture receipts through the real OCR pipeline, the W-2 sample draw published with winners in several states, W-1 left drawable. Idempotent (skipped when the campaign already has receipts). Health checks pass before it starts; expect about one minute on one vCPU. See `docs/release/railway-deploy.md`.
