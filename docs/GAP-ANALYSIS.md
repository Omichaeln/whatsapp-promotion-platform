# System Design Gap Analysis

**Repository:** `whatsapp-promotion-platform` (local: `~/Documents/WhatsApp-Promotion-Platform`, GitHub: `Omichaeln/whatsapp-promotion-platform`)
**Scope:** promotion platform — registration, consent, receipt validation, entry ledger, draws, winners, claims, CRM, admin console
**Method:** static review of the implemented code + migrations + tests against the binding spec (REQ/gap/decision/acceptance IDs). Verification where possible is live (`npm test` = 17 passing) and against the Railway deployment.

## 1. What is implemented (snapshot)

| Area | Evidence | State |
|---|---|---|
| WhatsApp channel | `src/transport/` — `cloud-api.mjs` (Meta Cloud API: verify handshake, X-Hub-Signature-256, media, outbound), `linked-device.mjs` (Baileys QR pairing — restored), `simulator.mjs` | Implemented |
| Webhook intake | `server.mjs` `POST /webhooks/whatsapp`, unique `provider_message_id`, replay dedupe | Implemented |
| Conversation state machine | `conversation.mjs` — register → consent → outlet → receipt → outcome, resumable | Implemented |
| Campaign + versions | `services.mjs` — frozen `campaign_versions`, rules/content/flags JSON | Implemented |
| Participants + consent | `participants`, `consents` tables; registration with terms/privacy versions | Implemented |
| Media + receipts | private media store (SHA-256 + phash), `receipt-pipeline.mjs` atomic decision + entry | Implemented |
| Receipt intelligence | `extract/simulator.mjs` only (deterministic fixture decoder) — **no production vision provider** | Partial (G-07) |
| Eligibility + duplicates | `eligibility.mjs` deterministic rules; `duplicates.mjs` exact/fingerprint/perceptual | Implemented |
| Review | `review_tasks`, admin routes + console review UI | Implemented |
| Draws | `draw.mjs` freeze → sortition → execute → approve → publish, reconstruction script | Implemented |
| **Winners + claims** | Tables exist (migration 004) — **no code populates them** | **GAP** |
| CRM | canonical outbox (`crm_sync_jobs`), webhook adapter, retries + dead letters | Implemented (provider pending D-14) |
| Auth/RBAC | scrypt login, hashed tokens, roles; **MFA columns exist but are never enforced** | **GAP** |
| Audit | hash-chained `audit_events` | Implemented |
| Admin console | React (original desk layout restored) + promotion tabs | Implemented |
| Natural language | `nlp.mjs` + `/api/nl` (dashboard, review, entries, draw, send, draft, classify, link) | Implemented |
| AI desk workflows | `ai.mjs` — triage/summarise, draft, transcribe; deterministic fallback when no key | Implemented |
| Deploy | Railway (Nixpacks, volume, Procfile bootstrap) | Live |

## 2. Confirmed gaps and defects

| ID | Area | Evidence (file:line or command) | Priority | Impact |
|---|---|---|---|---|
| DEF-01 | **Broken `npm run migrate`** | `package.json` → `node src/db.js migrate`, but `src/db.js` does not exist (module is `db.mjs`, no CLI entrypoint) — the command fails with `module not found`. README + docs/API.md document it as the migration path. | P0 | Setup/migration path broken |
| DEF-02 | **MFA not enforced** | `admin_users.mfa_secret`/`mfa_enabled` exist (001_foundation.sql) but `auth.mjs login()` never checks codes; no enrollment or verify endpoints | P0 (G-12, §15) | Shared-credential risk on a promotion operator console |
| DEF-03 | **Winners + claims never materialised** | Tables `winners`/`claims` (004) are empty by construction: `draw.publish()` only flips draw status — no winner rows, no claim rows, no winner notification, no public winners view (REQ-20/22) | P0 (REQ-20, 21, 22, G-14) | Core winner outcome missing end-to-end |
| DEF-04 | **No draw rerun endpoint** | Spec §13.2 `POST /api/draws/:id/rerun`; server only handles `execute|approve|publish` | P1 (G-13) | Governance requirement, disputed draws |
| DEF-05 | **No login rate limiting** | No throttle on `POST /api/login` anywhere in `server.mjs` | P1 (§16.3) | Brute-force exposure |
| DEF-06 | **No export endpoint** | Spec §13.2 `GET /api/reports/export` + watermark; no such route; docs mention exports but nothing serves them | P1 (G-16) | Audit/CRM-sync fallback unmet |
| DEF-07 | **Missing docs referenced by README** | README links `docs/TRACE.md` and `docs/DECISIONS.md` — neither exists | P1 | Traceability contract broken |
| DEF-08 | **Production receipt extraction is a stub** | Only `SimulatorExtractor`; `RECEIPT_EXTRACTOR=simulator` is the single shipping implementation — real OCR/vision provider contract (`extract/receipt-extractor.mjs`) never implemented | P0 at launch (G-07) | Whole receipt path is simulate-only |
| DEF-09 | Route monolith | `server.mjs` 616 lines, `src/routes/` empty — spec §8 wanted route modules | P2 | Maintainability only |
| DEF-10 | Architecture drift note | README/docs still claim "Postgres/Supabase production system of record" — implementation is SQLite-only; Supabase patch exists in git history? no adapter in `src/` (`createCrm` is webhook) | P2 | Docs vs reality |

## 3. Requirements coverage

| Requirement | Status |
|---|---|
| REQ-01..08 (entry point, menu, register, consent, repeat entry, outlet, image, ack) | ✅ |
| REQ-09..12 (recognition, extraction, purchase qualification, eligibility) | 🟡 implemented with simulator extractor only — production OCR is DEF-08 |
| REQ-13..16 (duplicates, multiple receipts, outcome, status) | ✅ |
| REQ-17..19 (mechanics, terms, prizes) | 🟡 content versioned; no public prize catalogue endpoint |
| REQ-20 (winners view) | ❌ **DEF-03** |
| REQ-21 (auditable draw) | ✅ |
| REQ-22 (winner contact + claims) | ❌ **DEF-03** |
| REQ-23 (private admin) | 🟡 MFA missing (DEF-02) |
| REQ-24 (CRM) | 🟡 outbox + adapter; provider/dedicated account pending D-14 |
| REQ-25 (reusable campaigns) | 🟡 create/version/activate only; no clone/schedule/archive UI |
| REQ-26..28 (client number, UAT, launch window) | 🟡 blocked on client decisions D-20/D-17/D-16 |

## 4. Open client decisions that block launch (unchanged, D-01..D-20)
Campaign dates/rule detail (D-01/03), ID-number handling (D-06), outlet master (D-08), prize/draw schedule (D-11..13), CRM contract (D-14), reach/volume (D-16), named owners/roles (D-17), Meta assets (D-20). Safe fail-closed defaults remain in place.

## 5. Priority execution order for this session

1. DEF-01 migrate CLI fix (small, unblocks setup).
2. DEF-02 MFA (TOTP, RFC-6238; enrollment + verify; per-user, optional so prod admin isn't locked out).
3. DEF-03 winners + claims lifecycle (materialise winners on publish, create claim rows, notify winner via outbox, expose GET /api/winners + PATCH claims).
4. DEF-04 draw rerun endpoint.
5. DEF-05 login rate limiting.
6. DEF-07 TRACE.md / DECISIONS.md.
7. DEF-06 export endpoint.
8. DEF-08 documented as blocked (needs corpus + provider key) — remain honest.

---

*Generated 2026-09-07 — evidence-based; see commit log for change history.*