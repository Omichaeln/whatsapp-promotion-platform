# WhatsApp Promotion Platform

A WhatsApp-first consumer promotion platform: registration and consent, controlled outlet selection, receipt upload with **real OCR** and deterministic qualification, canonical-receipt duplicate prevention, an immutable entry ledger, crash-safe and independently verifiable draws, winner/claim lifecycle, privacy-safe publication, CRM outbox with read-back, and a role-based staff console.

Readiness (10 September 2026 build): **locally testable** end to end; **integrated client testing** needs the client's WhatsApp Cloud API assets (and optionally a vision-LLM key and CRM sandbox); **production** additionally needs the approved client decisions. Details: `docs/TEST_READINESS.md`.

## Quick start (clean checkout)

```bash
# Node >= 22.13
npm ci                              # sharp + tesseract.js + English OCR data (no system packages)
npm run preflight                   # config, dependencies, migration state, provider modes (no secrets printed)
npm run migrate                     # apply db/migrations (also automatic on start)
npm run seed                        # TEST ONLY sample: campaign, 80 outlets, periods, decisions, staff,
                                    # 12 participants, 28 fixture receipts through the real OCR pipeline, one
                                    # published draw (W-2) with winners; W-1 left for the UAT draw steps
npm start                           # http://127.0.0.1:5191  (console at /, API under /api, webhook /webhooks/whatsapp)
```
Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults: `admin@example.com` / `change-me-now-local` in local only). Sample staff accounts (`manager@`, `reviewer@`, `draw@`, `approver@`, `fulfilment@`, `auditor@`, `support@` at `example.test`) are printed once by the seed with temporary passwords.

## Commands

| Command | What it does |
|---|---|
| `npm run preflight` | environment preflight (exit 1 on blocking problems) |
| `npm run migrate` | apply migrations (idempotent) |
| `npm run seed` / `npm run seed:light` | populated / structural sample seed (refused in production) |
| `npm run reset:sample` | delete only the sample campaign's records (guarded) |
| `npm start` / `npm run worker` | server with embedded worker / standalone worker |
| `npm test` | unit + integration + real-OCR + contract + security suites (about 75 s) |
| `npm run bench` | receipt benchmark over `fixtures/receipts` → `docs/testing/evidence/receipt-benchmark.json` |
| `npm run load` | engineering load benchmark (real OCR) → `docs/testing/evidence/load-benchmark.json` |
| `npm run verify:draw -- bundle.json` | independent draw verifier |
| `npm run restore:rehearsal` | backup + isolated restore + integrity checks → evidence |
| `npm run crm:receiver` | local CRM contract receiver (fault injection) |
| `npm run web:build` | rebuild the console bundle |
| `npm run check` / `npm run ci` | syntax gate / full CI sequence |

## Documentation map

`docs/architecture.md`, `docs/adr/`, `docs/security/threat-model.md`, `docs/client-decisions.md`, `docs/requirements-traceability.md`, `docs/integrations/{whatsapp,crm}.md`, `docs/testing/{test-plan,fixtures,receipt-benchmark,client-uat}.md`, `docs/testing/evidence/`, `docs/runbooks/`, `docs/release/`, `docs/TEST_READINESS.md`, `docs/api.md` (live: `/api/openapi.json`).

## Deployment (Railway)

`Procfile` → `src/bootstrap.mjs` (migrate → non-production sample seed → server + worker). Mount a volume at `/app/data`. Set `ENVIRONMENT`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `IDENTITY_KEY`, `AUDIT_CHECKPOINT_KEY`; for the client's number set `WHATSAPP_TRANSPORT=cloud-api` and the `META_*` variables (`docs/integrations/whatsapp.md`). Production refuses the simulator transport/extractor, sample seeding and dev keys.

## License

MIT.
