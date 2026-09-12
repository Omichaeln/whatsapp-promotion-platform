# Railway deployment and live system test

This page is the exact procedure for putting a build on Railway and proving every system function on the live URL. The build sandbox that produced this branch cannot reach Railway (its API, dashboard and `*.up.railway.app` are blocked by the network policy), so the deployment itself is **not verified from this environment**; the same boot path was rehearsed locally with the Railway start command under `ENVIRONMENT=staging` and the live test passed 95/95 (`docs/testing/evidence/remote-smoke-staging-rehearsal.txt`).

## 1. What Railway runs

| Item | Value | Source |
|---|---|---|
| Builder | Nixpacks, Node 22 (`.nvmrc`, `engines.node >= 22.13`; `node:sqlite` needs 22.13+) | `railway.json`, `package.json` |
| Start command | `node --no-warnings=ExperimentalWarning src/bootstrap.mjs` | `railway.json` / `Procfile` |
| Healthcheck | `GET /health/live` (200 as soon as the server listens); `GET /health/ready` adds database, extractor and worker state | `src/server.mjs` |
| Bootstrap sequence | migrate → structural sample seed (non-production) → HTTP server + embedded worker → optional background journeys (`SEED_POPULATED=true`) | `src/bootstrap.mjs` |
| Persistent storage | a volume mounted at `/app/data` (SQLite `promotions.db` + `media/`) | `src/config.mjs` defaults when a `RAILWAY_*` variable is present |
| Bind address | `0.0.0.0` on Railway automatically; `PORT` is injected by Railway | `src/config.mjs` |

## 2. Service variables

Set in the Railway service (never in the repository). Names are unchanged from the previous deployment, so an existing service keeps working.

| Variable | Test deployment value | Notes |
|---|---|---|
| `ENVIRONMENT` | `staging` | defaults to `staging` on Railway when unset; `production` enables the activation gates and refuses the simulator transport and extractor, sample seeding and dev keys **at boot** — `validateConfig` requires `WHATSAPP_TRANSPORT=cloud-api`, `PUBLIC_BASE_URL` and `AUDIT_CHECKPOINT_KEY` there, and the server throws with the reason in the deploy log rather than starting on a misconfiguration |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your values (password ≥ 12 chars) | required outside `local`; the boot refuses to start without them and says why in the deploy log |
| `IDENTITY_KEY` | long random secret | encrypts identity numbers; changing it later makes existing identities unreadable |
| `AUDIT_CHECKPOINT_KEY` | long random secret | signs audit checkpoints and draw bundles |
| `WHATSAPP_TRANSPORT` | `simulator` for the test deployment; `cloud-api` once Meta assets exist | `cloud-api` also needs `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_TOKEN`, `PUBLIC_BASE_URL` (`docs/integrations/whatsapp.md`) |
| `RECEIPT_EXTRACTOR` | `tesseract` | real OCR, no key; `vision` needs `RECEIPT_PROVIDER_OPENAI_API_KEY` |
| `SEED_POPULATED` | `true` for the test deployment | after the server is up, pushes the fixture receipts through the real pipeline and publishes the W-2 sample draw (about one minute on one vCPU); idempotent; ignored in production |
| `CRM_PROVIDER` | `none` | `webhook` + `CRM_WEBHOOK_URL` + `CRM_WEBHOOK_TOKEN` once a vendor endpoint exists |

Sample staff accounts (`manager@`, `reviewer@`, `support@`, `draw@`, `approver@`, `fulfilment@`, `auditor@` at `example.test`) are created at first boot; their temporary passwords are printed **once** in the deploy log and must be changed at first sign-in. The live test below does not need them: it creates its own `smoke-*@example.test` accounts through the staff API.

## 3. Deploying

Either path produces the same service:

- **GitHub integration** (the existing setup): merging to `main` triggers a build. Watch the deploy log for `[server] listening on 0.0.0.0:<port> env=staging …`, `[bootstrap] worker started` and, with `SEED_POPULATED=true`, `[bootstrap] sample journeys complete`.
- **CLI**: `railway login`, `railway link`, `railway up` from the repository root, then `railway logs`.

Migrations run automatically at boot and are expand-only (`docs/release/migrations.md`); an existing volume from the previous version is upgraded in place.

## 4. Testing every system function on the live URL

```bash
BASE_URL=https://<service>.up.railway.app \
ADMIN_EMAIL=<admin email> ADMIN_PASSWORD=<admin password> \
npm run smoke:remote -- --out docs/testing/evidence/remote-smoke-railway.json
```

The harness (`scripts/remote-smoke.mjs`) runs 95 checks as a black box over HTTP: availability and console, authentication and session revocation, staff creation with forced password change, RBAC refusals, campaign configuration views, the full participant journey through the simulator channel with freshly rendered receipt images (qualified, duplicate on the same and another phone, one pack, non-receipt, malformed upload, ambiguous date), review assignment and decision with participant notification, signed media links, entry disqualify/reinstate, support handoff, identity reveal audit, draw freeze → execute → approve (separation of duties, hash check) → verify → publish, winner notify → verified → accepted → collected → published, the public winners projection, CRM/queue/outbound/alerts/reports/exports/audit-chain views, and logout.

Notes:
- Pass `--no-draw` to leave the un-drawn sample period (W-1) for the human UAT draw steps; without it the first run against a deployment executes that draw, and later runs report the draw section as skipped.
- The harness renders its own receipt images (unique numbers per run) and never uses the `uat-*.jpg` fixtures reserved for testers.
- It requires the simulator transport; with `cloud-api` the participant steps must be done from a real phone (`docs/testing/client-uat.md`).
- Exit code 0 means every check passed; the JSON report lists each check with its detail.

## 5. Rollback

Redeploy the previous image from the Railway deployments list. Migrations are additive, so the previous version runs against the upgraded database (`docs/release/rollout-and-rollback.md`).
