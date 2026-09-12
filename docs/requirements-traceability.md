# Requirements traceability (FR-01 … FR-36)

Build: branch `claude/funny-brown-r7wpo9`, statement revised 12 September 2026; the automated results in `docs/testing/evidence/test-results.txt` are the recorded run of commit `86ebef8` (46 tests in 9 suites, `exit=0`) and predate the later suites (`test/audit-integrity.test.mjs`, `test/media-limits.test.mjs`) — regenerate with `npm test` before citing the counts as coverage of this tree. Status legend: **verified** (automated test green in this build), **verified-local** (works locally against simulated provider), **partial**, **blocked** (needs client input/access). Test ids refer to `docs/testing/test-plan.md`; UAT rows to `docs/testing/client-uat.md`.

| FR | Client wording (abridged) | Implementation | Tests | UAT | Status | Remaining dependency |
|---|---|---|---|---|---|---|
| FR-01 | Start via client-owned WhatsApp number | `src/transport/cloud-api.mjs`, webhook in `src/server.mjs`, `src/intake.mjs` | T-01, T-28, T-35 | 1a | verified-local | Meta assets; live round-trip |
| FR-02 | Menu: register, enter, mechanics, terms, prizes, winners, help, status | `src/conversation.mjs` HOME, `src/copy.mjs` | T-01, T-16 | 1a, 7 | verified | — |
| FR-03 | Register once; recognised on return | `services.registerParticipant`, session HOME | T-02, T-05, T-13 | 1b | verified | — |
| FR-04 | Five fields; identity/location policy | REG_* states; `flags.registration.identity_stage`; AES-GCM + fingerprint | T-02, T-29, T-30 | 1b | verified | D-11, D-12 |
| FR-05 | Versioned terms/privacy acceptance before entry | `campaign_enrollments` (terms/privacy versions) | T-02, T-18, T-31 | 1b | verified | final texts |
| FR-06 | Another entry without registering again | ENTER from HOME after outcome | T-05 | 3 | verified | — |
| FR-07 | Controlled selection from ~80 outlets | retailer→town→branch pages, search, canonical id only | T-03, T-11, T-17 | 1c | verified | D-13 outlet master |
| FR-08 | Receipt upload with durable acknowledgement | `pipeline.submit` in intake job; "received" reply | T-04, T-09, T-13, T-28 | 2 | verified | — |
| FR-09 | Distinguish receipts from unrelated images | `classifyDocument`, quality signals | T-08, T-09 | 5a | verified | client corpus |
| FR-10 | Extract merchant/date/number/totals/line items from pixels | tesseract.js + `parse-receipt.mjs` (vision-LLM optional) | T-04, T-10, T-11 | 2 | verified (synthetic corpus) | client corpus benchmark |
| FR-11 | Deterministic product/quantity qualification | `eligibility.mjs` integer grams, versioned | T-10, T-11, T-18 | 5b | verified | D-05 |
| FR-12 | Two 2 kg packs / 4 kg interpretation | `primary_rule` + `allow_pack_combinations` | T-10 | 5b | verified | D-06 |
| FR-13 | Date/outlet/product/participant/limit checks | rules 2–7 | T-10, T-11, T-19 | 5 | verified | D-08/D-09/D-10 |
| FR-14 | No repeat credit anywhere in campaign | canonical_receipts UNIQUE, entries UNIQUE | T-06, T-07, T-12, T-14 | 4a, 4b | verified | — |
| FR-15 | Exact duplicates blocked; probable to review | canonical identity; candidates recorded; ownership disputes to review | T-06, T-07, T-14, T-15 | 4b | verified | D-09 |
| FR-16 | Multiple different receipts per participant | unlimited by default | T-05, T-12 | 3 | verified | D-08 |
| FR-17 | Qualified/duplicate/rejected/re-upload/review/delayed messages | `copy.mjs`, pipeline outcomes incl. delayed | T-04, T-06, T-08, T-09, T-11, T-15, T-28 | 2–6 | verified | approved copy |
| FR-18 | One immutable award (multiplier explicit) | `entries` + `weight_units` + `entry_events` | T-04, T-10, T-12, T-13 | 2 | verified | D-07 |
| FR-19 | Configurable own-entry status | `flags.participant_status`, menu 7 | T-16, T-29, T-32 | 7 | verified | D-15 |
| FR-20 | Mechanics/terms/prizes/winners accessible | menu 3–6 | T-16, T-25 | 7 | verified | content, artwork |
| FR-21 | Winners by week | `winners.publishedPeriods/listPublic`, WINNERS state | T-16, T-25 | 11 | verified | D-18 |
| FR-22 | Staff configuration without code | console Campaigns (versions, content, periods, outlets CSV, decisions, pause) | T-17, T-18 | — | verified-local (API + console) | — |
| FR-23 | Secure human review | review queue/workspace, signed images, version checks | T-09, T-11, T-15, T-29 | 6 | verified | staffing D-14 |
| FR-24 | Audited decisions/overrides/changes | `src/audit.mjs` single writer, checkpoints | T-15, T-17, T-21, T-22, `test/audit-integrity.test.mjs` (attribution + chain fork; added after the recorded evidence run) | 9 | verified | — |
| FR-25 | Frozen pool + secure random draw | `draw.mjs` barrier/snapshot/seed/HMAC | T-19, T-20, T-21, T-22 | 8 | verified | D-16 |
| FR-26 | Controlled execution, independent approval/audit | SoD, hash-verified approval, bundle verifier | T-21, T-22, T-29 | 8c, 8d, 9 | verified | named approver |
| FR-27 | Winner contact + claim lifecycle | `winner-service.mjs`, template gate | T-23, T-24, T-28 | 10 | verified-local | Meta template (D-23), D-17 |
| FR-28 | Privacy-safe publication only | projection, publication_state | T-25, T-29, T-30 | 11 | verified | D-18 |
| FR-29 | CRM integration | `crm.mjs` outbox + read-back; contract receiver | T-26, T-27 | 12 | partial (vendor not selected) | D-19 |
| FR-30 | CRM/notification failure never loses an entry | outbox isolation | T-13, T-27, T-28 | 12b | verified | — |
| FR-31 | Search/filter/report/export | receipts filters, reports summary, watermarked exports | T-15, T-29, T-30, T-32 | 12c | verified | — |
| FR-32 | Client-owned number/content/data/access | config + roles + content versions | T-01, T-17, T-29, T-30, T-35 | — | verified-local | Meta assets |
| FR-33 | Versioned rules/products/outlets/content/prizes | campaign_versions, periods, campaign_outlets | T-17, T-18, T-19 | — | verified | — |
| FR-34 | Reuse; historical separation | clone, campaign-scoped tables, archive | T-17, T-18, T-25, T-29 | — | verified-local | — |
| FR-35 | Real-phone acceptance testing | UAT script; simulator; Meta connection guide | T-01, T-04, T-23, T-35 | all | blocked (needs number) | Meta assets |
| FR-36 | Launch window with honest readiness | `docs/TEST_READINESS.md`, activation validator | T-34, T-35, T-36 | — | partial | client inputs |
