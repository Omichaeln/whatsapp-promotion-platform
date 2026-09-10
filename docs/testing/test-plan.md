# Test plan

Levels: unit/pure (rules, sortition, parser), integration (in-process server + SQLite + worker + simulator transport), real-OCR pipeline (fixture JPEGs through tesseract.js), contract (Cloud API payloads and signatures; CRM receiver), adversarial (RBAC, media links, exports), operational scripts (benchmark, load, restore rehearsal, verifier). Browser/mobile UAT is scripted in `client-uat.md` and executed by humans on the test deployment.

Commands: `npm test` (all suites, about 75 s on one CPU; the real-OCR suite is the slow part), `npm run bench`, `npm run load`, `npm run restore:rehearsal`, `npm run verify:draw -- <bundle>`.

| Test | Automated in | Boundary | Result — build of 10 September 2026 (`evidence/test-results.txt`) |
|---|---|---|---|
| T-01 menu on greeting | journey | intake → conversation → outbox | pass |
| T-02 registration, correction, terms, returning | journey | conversation, participant | pass |
| T-03 outlet hierarchy/search/no phantom outlet, 80 branches | journey | conversation, outlets | pass |
| T-04 valid two-pack from pixels → one award → message | receipt-ocr | OCR pipeline | pass (tesseract.js, pixels) |
| T-05 second unique receipt without re-registration | journey | pipeline | pass |
| T-06 same image same/other phone → no credit, safe message | journey, receipt-ocr | canonical identity | pass |
| T-07 re-photographed/cropped/rotated/recompressed copies blocked | receipt-ocr | hashes + canonical identity | pass |
| T-08 random photo / instruction paper never qualifies | receipt-ocr | classification | pass |
| T-09 blur/dark/malformed/oversized handled, no invented facts | receipt-ocr | media + rules | pass |
| T-10 quantity rules (1/2/3 packs, 2KG text, void, wrong SKU, alt sizes) | receipt-ocr | rules | pass |
| T-11 dates, outlet mismatch, cropped header | receipt-ocr | rules | pass |
| T-12 concurrent same purchase → one award | receipt-ocr | UNIQUE claim | pass |
| T-13 replay + worker crash/lease | journey, crm-reliability | intake/jobs | pass |
| T-14 clearer re-upload possible; prior credit protected | receipt-ocr | pipeline | pass |
| T-15 concurrent reviewers, stale version, participant told | security, receipt-ocr | review | pass |
| T-16 mechanics/terms/prizes/winners/status; toggle server-side | journey, draw | conversation | pass |
| T-17 campaign create/clone/activate/pause/close; invalid config blocked | security (T-36) + manual console | campaign API | pass (API); console steps manual |
| T-18 rule/content change mid-flight pins the captured version | receipt-ocr (alt-pack rule version) | versions | pass |
| T-19 cutoff barrier, half-open boundary, unresolved submissions | draw | draw barrier | pass |
| T-20 candidate pool, one prize per participant, shortage | draw | draw | pass |
| T-21 crash-safe execute, own-approval refused, immutable approved result | draw | draw | pass |
| T-22 bundle verifies; tampering fails | draw | verifier script | pass; also `evidence/draw-verify-W-2.txt` (seeded draw verified; tampered copy fails) |
| T-23 winner contact, verification, acceptance, collection outlet | draw | winners, outbox | pass |
| T-24 double collection, expiry vs fulfilment, alternate promotion | draw | winners | pass |
| T-25 premature publication blocked; projection only | draw | public API, WhatsApp | pass |
| T-26 CRM sandbox read-back | crm-reliability (local contract receiver) | CRM adapter | pass against the local contract receiver; vendor sandbox pending (D-19) |
| T-27 CRM outage, timeout-after-write, version regression | crm-reliability | CRM outbox | pass |
| T-28 provider errors, unknown outcome, forged webhook, out-of-order statuses, extractor outage | crm-reliability | transport/outbox | pass (simulated Cloud API payloads; live Meta round-trip not verified) |
| T-29 unauthorised/underprivileged/enumeration/revocation | security | RBAC | pass |
| T-30 signed media, masking, reveal audit, formula-safe export | security | privacy | pass |
| T-31 withdrawal, anonymisation keep ledger | security | lifecycle | pass |
| T-32 report counts reconcile | manual (reports summary vs lists) + seed output | reports | manual: `evidence/seed-run.txt` counts reconcile with `/api/reports/summary` |
| T-33 alerts with runbooks | crm-reliability (dead-letter alert), worker housekeeping | alerts | partial: dead-letter and housekeeping alerts covered; external routing not configured |
| T-34 fresh + populated migrations, backup/restore, replay, rollback | restore rehearsal script + migration on populated seed | scripts | pass: `evidence/migration-rehearsal.json`, `evidence/restore-rehearsal.json` |
| T-35 clean checkout, seed, console, load, UAT | preflight/seed/load scripts + UAT | scripts | pass locally: `evidence/preflight.json`, `evidence/seed-run.txt`, `evidence/load-benchmark.json`, `evidence/http-smoke.txt`; real-phone UAT blocked (no Meta assets) |
| T-36 activation preflight | security | validator | pass |

Not automated and requiring authorised access: real-phone WhatsApp round-trip (T-01/T-04/T-23 on the designated number), vendor CRM sandbox (T-26), production restore drill on the hosting provider.
