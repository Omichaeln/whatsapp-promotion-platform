# Requirements, Gaps and Traceability

Binds requirements → code → tests → docs. See `docs/GAP-ANALYSIS.md` for the
prioritised defect list this session executes.

## Requirements (REQ-01..28)

| REQ | Requirement | Code | Test | Status |
|---|---|---|---|---|
| 01 | WhatsApp entry point | `conversation.mjs` | `conversation.test.mjs` | ✅ |
| 02 | Opening menu | `conversation.mjs` `STATES.HOME` | `conversation.test.mjs` | ✅ |
| 03 | Register once | `services.mjs registerParticipant` | `conversation.test.mjs` | ✅ |
| 04 | Registration data | `participants` table | — | ✅ (open fields D-04/06) |
| 05 | Consent | `consents` table + version | `conversation.test.mjs` | ✅ |
| 06 | Repeat entry | `ENTRY_OUTLET` state | `conversation.test.mjs` | ✅ |
| 07 | Controlled outlet | outlet master + `resolveOutlet` | `conversation.test.mjs` | ✅ |
| 08 | Receipt image upload | webhook `message.image` → media store | `eligibility.test.mjs` | ✅ |
| 09 | Receipt recognition | `SimulatorExtractor` | `eligibility.test.mjs` | 🟡 DEF-08 (prod vision pending) |
| 10 | Receipt extraction | `extract/*` contract | — | 🟡 DEF-08 |
| 11 | Purchase qualification | `eligibility.mjs` rules | `eligibility.test.mjs` | ✅ |
| 12 | Receipt eligibility | `evaluateEligibility` | `eligibility.test.mjs` | ✅ |
| 13 | Duplicate prevention | `duplicates.mjs` | `eligibility.test.mjs` | ✅ |
| 14 | Multiple unique receipts | `entries` unique per receipt | `eligibility.test.mjs` | ✅ |
| 15 | Outcome message | outbox kind=text | `conversation.test.mjs` | ✅ |
| 16 | Entry status (optional) | gated G-21 | — | 🟡 pending D-10 |
| 17 | Mechanics | versioned content | — | ✅ |
| 18 | Terms | versioned terms | — | ✅ |
| 19 | Prizes | prize catalogue in draw_config | — | 🟡 |
| 20 | Winners view | `winner-service.mjs listPublic` | `winner.test.mjs` | ✅ (DEF-03 fixed) |
| 21 | Auditable draw | `draw.mjs` + `reconstruct-draw.mjs` | `draw.test.mjs` | ✅ |
| 22 | Winner contact + claims | `winner-service.mjs transition` | `winner.test.mjs` | ✅ (DEF-03 fixed) |
| 23 | Private administration | auth + RBAC | `conversation.test.mjs` | 🟡 DEF-02 MFA now enforced |
| 24 | CRM integration | `crm.mjs` outbox + adapter | — | 🟡 provider pending D-14 |
| 25 | Reusable campaigns | create/version/activate; clone/archive pending | no test | 🟡 |
| 26 | Client-owned number | cloud-api adapter | — | 🔒 blocked D-20 |
| 27 | Mobile UAT | simulator + webhook tester | — | 🔒 blocked D-16/17 |
| 28 | Launch window | — | — | 🔒 blocked on client decisions |

## Gaps executed this session

| Gap | Executed |
|---|---|
| DEF-01 broken `npm run migrate` | ✅ `src/db.js` CLI (migrate / --dry / seed) |
| DEF-02 MFA not enforced | ✅ TOTP (RFC 6238) in `src/mfa.mjs`; login challenge + enroll/enable/disable; `/api/login/mfa` |
| DEF-03 winners + claims never materialised | ✅ `src/winner-service.mjs`; populated on draw publish; `/api/winners*` + claim transitions + replacement |
| DEF-04 draw rerun | ✅ `POST /api/draws/:id/rerun` (new linked draw, never mutates) |
| DEF-05 login rate limit | ✅ per-IP sliding window on `/api/login` (429 + retry-after) |
| DEF-06 export endpoint | ✅ `GET /api/reports/export` (auditor, watermarked, audited) |
| DEF-07 missing docs | ✅ `docs/TRACE.md` + `docs/DECISIONS.md` |

## Test files

- `test/eligibility.test.mjs` — rules, duplicates, REQ-14
- `test/conversation.test.mjs` — state machine, RBAC
- `test/draw.test.mjs` — draw lifecycle + reconstruction
- `test/desk.test.mjs` — desk store + AI triage
- `test/nlp.test.mjs` — natural-language parsing
- `test/mfa.test.mjs` — TOTP + MFA login
- `test/winner.test.mjs` — winners/claims lifecycle
