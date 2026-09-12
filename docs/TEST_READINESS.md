# Test readiness statement

Build: branch `claude/funny-brown-r7wpo9`; this revision of the statement was written against commit `86189c3` (12 September 2026) and is maintained with the branch, whose pull request carries the full history. The evidence artefacts under `docs/testing/evidence/` have **not** been regenerated since: everything except two recordings was produced at commit `d0bf6327ea646726b51d106ff190b42e62d7439a`, and `test-results.txt` and `remote-smoke-staging-rehearsal.*` at the later `86ebef8a71dc424dae292f7232b90cbb157562b0` (`git log -1 -- docs/testing/evidence/<file>` confirms either) — where a row below cites one, read it as evidence for that commit, not for the branch tip. Regenerating the evidence set (`docs/testing/evidence/README.md` lists the exact commands) is a prerequisite for hand-over. This statement is an engineering self-assessment with evidence; it is not a client sign-off.

## Readiness at the three levels

| Level | Status | What supports it | What is missing |
|---|---|---|---|
| Locally testable (developer / internal QA) | **reached** | clean checkout → `npm ci`, `npm run preflight`, `npm run migrate`, `npm run seed`, `npm start`; the automated suite green at the recorded run (`evidence/test-results.txt`: 46 tests, 9 suites, `exit=0`) — that recording predates `test/audit-integrity.test.mjs`, `test/media-limits.test.mjs` and the later audit-fix cases, so it does not attest the tree being handed over and must be regenerated with `npm test`; real OCR on 40 fixtures with 0 false awards (`evidence/receipt-benchmark.json`); seeded sample campaign with 80 outlets, 12 participants, one published draw, winners in every state; console, simulator, verifier, restore rehearsal, load benchmark all run in this build | — |
| Integrated client testing (real phones, client-owned WhatsApp number) | **not reached** | Cloud API transport, webhook verification, media download, template gating and status ingestion are implemented and tested against simulated Meta payloads (T-28) | Meta assets from the client (WABA, phone number id, permanent token, app secret, verify token, public HTTPS webhook URL, approved winner template); a live round-trip has **not** been performed from this environment (graph.facebook.com is not reachable from the build sandbox). Receipt extraction is real (tesseract.js) but validated on a synthetic corpus only; the client corpus benchmark is outstanding. CRM: no vendor selected (D-19); the webhook adapter is verified against the local contract receiver only |
| Production | **not reached** | activation validator (`src/activation.mjs`, T-36) enforces the gate server-side | all 22 client decisions are `open`; sample markers present; secrets, MFA enrolment for privileged staff, backup schedule, alert routing, hosting restore drill, DPA/processor list, approved copy and template |

Per the build brief, the system is **not** described as ready for integrated client testing while WhatsApp, image extraction on client receipts, or the CRM boundary is simulated or unverified. The WhatsApp channel is simulated in this build; extraction is real but unverified on client receipts; the CRM vendor is not selected.

## Provider states

| Boundary | Implementation | State in this build | Evidence / note |
|---|---|---|---|
| WhatsApp Cloud API | `src/transport/cloud-api.mjs` (signed webhooks, media allowlist, template gate, unknown-outcome on timeout, status ingestion) | **simulated** (`WHATSAPP_TRANSPORT=simulator`), Cloud API **configured=no, verified=no** | `test/crm-reliability.test.mjs` T-28; `docs/integrations/whatsapp.md` for the connection procedure |
| WhatsApp linked-device (Baileys) | `src/transport/linked-device.mjs` | **dev-only**; refused in production | ADR-0001 |
| Receipt extraction | `src/extract/tesseract.mjs` (tesseract.js 7, bundled English model, reads pixels) | **real, verified on synthetic corpus** | `evidence/receipt-benchmark.json`, `test/receipt-ocr.test.mjs`; client corpus outstanding |
| Vision-LLM extraction | `src/extract/vision.mjs` (OpenAI-compatible, strict schema, re-parsed locally) | **configured=no, verified=no** (no key; api.openai.com unreachable from the sandbox) | ADR-0003 |
| Simulator extractor | `src/extract/simulator.mjs` | TEST ONLY; refused outside `local` | used by the fast test suites only |
| CRM | `src/crm.mjs` (canonical events, versioned outbox, read-back, reconcile) + `scripts/crm-receiver.mjs` | **not_configured** (`CRM_PROVIDER=none`); webhook adapter **verified against the local contract receiver only** | `test/crm-reliability.test.mjs` T-26/T-27; D-19 |
| Hosting (Railway) | `Procfile` → `src/bootstrap.mjs`, volume at `/app/data`, `SEED_POPULATED` journeys | **not deployed from this environment** (Railway API, dashboard and app URL unreachable from the sandbox); the Railway start command was rehearsed locally under `ENVIRONMENT=staging` and the 95-check live test passed | `docs/release/railway-deploy.md`, `evidence/remote-smoke-staging-rehearsal.txt` |
| Database | `node:sqlite` WAL, migrations 001–012 (additive apart from the dead-metadata delete in 011 and two index drops in 012 — no application data is removed) | verified locally, migration rehearsal on populated v1 data | `evidence/migration-rehearsal.json`, `evidence/restore-rehearsal.json` |

## Access for testers (local / any deployment of this branch)

1. `npm ci && npm run preflight && npm run migrate && npm run seed && npm start` (Node ≥ 22.13).
2. Console: `http://127.0.0.1:5191/` (or the deployment URL). API under `/api`, OpenAPI at `/api/openapi.json`, public winners at `/api/winners/public`.
3. Sign in as `ADMIN_EMAIL` / `ADMIN_PASSWORD` (`.env`; local defaults in `.env.example`). Sample staff (`manager@`, `reviewer@`, `support@`, `draw@`, `approver@`, `fulfilment@`, `auditor@` at `example.test`) receive temporary passwords printed **once** by the seed; each must change it at first sign-in. Passwords are never written to docs or evidence.
4. Participant steps run through *Simulator* in the console (or `POST /api/simulator/inbound`) until a WhatsApp number is connected; the UAT script is `docs/testing/client-uat.md`.

## Evidence index

See `docs/testing/evidence/README.md`. Live system test (95 checks over HTTP against a staging-style boot), automated suite, receipt benchmark, load benchmark, migration rehearsal, backup/restore rehearsal, preflight, seed run (redacted), draw bundle + independent verification (including a tampered copy failing), HTTP smoke journey, dependency audit, readiness endpoint output.

## Blockers to the next level (owner → action)

| # | Blocker | Owner | Unblocks |
|---|---|---|---|
| B-1 | Meta Business assets and a public HTTPS webhook URL (`docs/integrations/whatsapp.md`); winner-contact template approval (D-23) | client IT / marketing | integrated client testing on real phones (T-01, T-04, T-23 live) |
| B-2 | Client receipt corpus (≥ 100 real photos, grouped by transaction, held-out split) and acceptance of the benchmark thresholds | client ops + delivery team | extraction verified on client receipts; review-rate planning (D-14) |
| B-3 | CRM vendor selection, sandbox credentials and field mapping sign-off (D-19) | client IT | T-26 against the vendor sandbox |
| B-4 | Approval of D-01 … D-22 in *Campaigns → Decisions*, then configuration as a new campaign version | client | production activation validator |
| B-5 | Hosting secrets (`IDENTITY_KEY`, `AUDIT_CHECKPOINT_KEY`, `META_*`, admin credentials), backup schedule ≤ 15 min, alert routing destination, MFA enrolment for privileged staff | platform administrator | production |

## Not verified in this build (stated plainly)

Live WhatsApp send/receive, Meta media download, template delivery, status webhooks from Meta; extraction quality on thermal till paper; a Railway deployment of this branch; a restore drill on the hosting provider; external alert delivery; browser UAT by client testers.

## Authorisations not used

No public promotion was activated, no real consumer was messaged, no actual prize draw was run (sample draws use fictional participants and TEST prizes), no paid commitment was made, and no production data was altered.
