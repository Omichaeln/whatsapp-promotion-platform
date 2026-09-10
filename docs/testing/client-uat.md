# Client UAT script

Environment: the test deployment (see `docs/TEST_READINESS.md` for the URL and access). All data is the TEST ONLY sample promotion. **Channel:** in the current build the participant steps run through the console's *Test a customer* simulator (same intake, state machine, real OCR pipeline and outbox as WhatsApp) or through the designated WhatsApp test number once Meta assets are connected (`docs/integrations/whatsapp.md`). Fixture images are in `fixtures/receipts/`; the `uat-*.jpg` files are reserved for this script and are never submitted by the seed or by the automated live test (`npm run smoke:remote`, which should be run with `--no-draw` before a UAT session so period W-1 stays available for rows 8a–9).

Roles/accounts: sample staff accounts are created at first boot with temporary passwords printed once in the deploy log (`manager@…`, `reviewer@…`, `draw@…`, `approver@…`, `fulfilment@…`, `auditor@…`, `support@…` at `example.test`); each must change the password at first sign-in. Tester A phone `263770000101`, Tester B phone `263770000102` (any test number works).

| # | Tester / account | Input | Expected message / screen | Authoritative record | Pass/Fail |
|---|---|---|---|---|---|
| 1a | Tester A (phone) | `hi` | Campaign menu with options 1–8 | Integrations → Queues shows the event processed | |
| 1b | Tester A | `1`, then first name, surname, ID `TESTUAT001A`, town, `yes` (confirm), `yes` (terms) | "You're registered, …" and the menu | Participants → search the phone: profile with masked ID, enrollment TEST-T1 | |
| 1c | Tester A | `2`, choose retailer / town / branch by number (or type `sunrise westgate harare`, then `1`) | "Outlet: Sunrise Supermarket — Westgate, Harare. Now send ONE clear photo…" | — | |
| 2 | Tester A | upload `uat-fresh-1-A.jpg` | "We have received your receipt… reference R-…"; then "…qualifies and ONE entry has been added… You now have 1 qualified entries" | Receipts: status QUALIFIED; Entries: one entry; Entries → Trace shows OCR provider `tesseract.js` | |
| 3 | Tester A | `2`, choose `valuemart westgate harare`, upload `uat-fresh-2-B.jpg` | qualified; "You now have 2 qualified entries" | Entries: two entries for Tester A | |
| 4a | Tester A | `2`, same outlet as step 2, upload `uat-fresh-1-A.jpg` again | "This receipt has already been used… no new entry" | Receipts: DUPLICATE with candidate kind `exact_sha256`/`canonical` | |
| 4b | Tester B | register (as 1b, ID `TESTUAT002B`), `2`, `sunrise westgate harare`, `1`, upload `dup-photo.jpg` (re-photographed copy of `valid-two-pack-A`, which the seed credited to a sample participant) | duplicate message; no mention of who holds the credit | Receipts: DUPLICATE; Entries still 2 total for A, 0 for B | |
| 5a | Tester B | `2`, outlet, upload `random-photo.jpg` | "We couldn't read receipt … does not look like a till receipt… send it again" | Receipts: REUPLOAD_REQUIRED | |
| 5b | Tester B | `2`, outlet, upload `one-pack.jpg` | "does not qualify: the qualifying quantity is below the minimum (2 x 2kg pack)" | Receipts: NOT_QUALIFIED below_minimum_quantity | |
| 5c | Tester B | `2`, outlet, upload `blurred.jpg` | re-upload request (or review) — never qualified | Receipts: not QUALIFIED | |
| 5d | Tester B | `2`, outlet `kwikshop westgate harare`, upload `uat-ambiguous-C.jpg` | "needs a quick manual check by our team" | Receipts: REVIEW_REQUIRED transaction_date_unclear; review queue count +1 | |
| 6 | reviewer@ | Receipts → REVIEW_REQUIRED → open 5d → Assign → Qualify → Apply | Tester B receives "after review, receipt R-… qualifies and ONE entry has been added" | Entries: entry for B; Audit: `review.qualified`/`entry.awarded` | |
| 7 | Tester A | `3`, `4`, `5`, `7`, `6` | mechanics, terms (TEST-T1), prizes text, own entry status (2 qualified), winners by week | Campaign content matches *Campaigns → Content* | |
| 8a | draw@ | Draws → period `W-1` (closed, deliberately left un-drawn by the seed; `W-2` is already published) → Check barrier | blockers list empty, eligible count shown (≥ 5 distinct participants) | — | |
| 8b | draw@ | Freeze candidates → Execute | status executed, output hash shown | Draws → Detail: integrity verified | |
| 8c | draw@ | Approve (attempt) | 403 "requires draw_approver" | — | |
| 8d | approver@ | Draws → Approve with note | status approved | Audit: `draw.approved` by a different user | |
| 9 | auditor@ | `GET /api/draws/<id>/bundle` → save; run `npm run verify:draw -- bundle.json --checkpoint-key <key>` | `verified: true`; edit one winner id in the file and rerun → `verified: false` | evidence file | |
| 10a | fulfilment@ | Draws → Publish; Winners → open rank 1 → Notify | winner's phone receives the congratulations message with a claim reference | Winners: notified; Outbound: sent/delivered | |
| 10b | fulfilment@ | Verify (evidence note) → Accepted (collection outlet) → Record collection (slip ref) | states advance; second collection refused | Claims history; Audit | |
| 11 | fulfilment@ then Tester A | Publish the winner; Tester A sends `6`, then the week number | only "First I. (Town) — prize" lines; pending/replaced winners absent | `GET /api/winners/public` identical | |
| 12a | manager@ | Integrations → CRM outbox (provider webhook against the local receiver) | events delivered with read-back timestamps | receiver `GET /records` | |
| 12b | ops | stop the receiver, submit a receipt, restart, Reconcile | entry still awarded during the outage; events end delivered/reconciled, no duplicates | Integrations → CRM | |
| 12c | manager@ | Reports summary | counts reconcile with Receipts/Entries/Participants lists | `GET /api/reports/summary` | |

Sign-off: record the tester, date and result per row; return the sheet to the delivery team. A row marked Fail must reference the receipt reference or draw id shown on screen.
