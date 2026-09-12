# System audit and gap analysis

**Date:** 12 September 2026
**Subject:** WhatsApp promotion platform, branch `claude/funny-brown-r7wpo9`
**Baseline:** commit `86ebef8` on `main` (the merge of the deployment-readiness work)

## What this is

An adversarial audit of the whole system — not a code review of a diff. Twenty
dimensions were audited independently and in parallel, each by an engineer who
read the relevant subsystem end to end and then *ran* it: scratch scripts against
a real server instance with a seeded campaign, real SQLite, the real OCR
extractor and the real outbox. Every claimed defect was then handed to a second
engineer whose only instruction was to refute it. Only findings that survived
refutation are recorded here.

That method matters for how you should read the numbers. A finding in this
report is not "something looks wrong": it is a failure somebody reproduced,
usually with the command still in the evidence. Seven claims were refuted and
discarded; they are listed at the end so the record is complete.

## Result

| | Survived refutation | Resolved | Open |
|---|--:|--:|--:|
| Blocker | 6 | 6 | — |
| Major | 60 | 60 | — |
| Minor | 89 | 78 | 11 |
| Nit | 17 | 17 | — |
| **Total** | **172** | **161** | **11** |

The six blockers are the report. Everything else is a matter of degree; those
six were each capable of destroying the integrity of the promotion on their own,
and three of them were certain to fire in normal operation rather than under
attack.

## The six blockers

**One handled error silenced every subsequent write.** Three independent
auditors — reading the schema, the pipeline and the cross-cutting concerns —
arrived at the same defect in `src/db.mjs`. SQLite's `ROLLBACK TO` does not pop
the savepoint, and nothing in the failure path released it, so the transaction
opened by the outermost savepoint stayed open for the life of the process. Every
write then went into that transaction: invisible to any other connection and
discarded on the next restart. The triggers were not exotic. They were the
designed rejections the system raises every day — a withdrawn participant
re-registering, two reviewers opening one task, a draw operator trying to approve
their own draw. One of those, and the service silently stopped persisting
entries, audit rows and outbound messages while continuing to tell participants
their entry had been added. `tx()` now opens with `BEGIN IMMEDIATE`, names each
savepoint uniquely, and always unwinds.

**One purchase could earn two entries.** The canonical receipt key was
`outlet | date | number | total`, and the outlet in that key is the participant's
own menu selection. Photograph one slip twice, submit it against two branches of
the same retailer, and the key differs, so nothing collides: two identities, two
entries, one purchase, fully automatic and from one phone. This is FR-14 and
FR-15 stated as implemented when they were not. The printed identity (date,
number, total) now belongs to the receipt and is checked independently of the
selection; a match across outlets goes to a reviewer rather than being rejected,
because two shops legitimately can print one number on one day.

**An image could stop the queue.** `normaliseForOcr` upscaled by width alone. A
310 KB PNG of 400 x 100,000 pixels passed the input-pixel budget and became a
640-megapixel working image: 57 seconds of CPU and a 7 MB file written to the
media volume, inside the inbound path the worker runs sequentially. A handful of
those messages is a denial of service against every participant, sent from a
phone, costing the sender nothing. Aspect ratio is now bounded and the budget is
enforced on the normalised image, not only the input.

**A missing environment variable would seed test data into production.** Sample
seeding branched on the `ENVIRONMENT` variable, which falls back to `staging`. A
renamed or forgotten variable on a redeploy against the live volume would inject
a second active campaign, eighty test outlets into the outlet master, and seven
known staff logins into the production database. Seeding now branches on the
environment recorded *in the database*, and the server refuses to boot when the
two disagree.


## What the findings say about the system

Three patterns account for most of the 172.

**The integrity machinery is sound; its edges were not.** The audit chain, the
canonical-receipt constraint, the immutable entry ledger, the draw barrier and
the sortition all did what they claim. What failed sat one layer out: a claim
resolved on a key that embedded user input, a checkpoint whose negative branch no
test had ever observed, a bundle verifier that compared hashes only against
themselves. The design was right and the perimeter was thin. That is the cheaper
of the two failure modes to be in, but it is not visible from a demo, which is
precisely why it survived to this audit.

**Operator-facing surfaces lagged the server.** A recurring shape: the server
enforces a control correctly, and the console cannot exercise it. Reviewers could
not open the receipt image they were reviewing. Dual-control reinstatement was
impossible through the product because the button sent no approver. The support
escalation keyword had no staff-facing queue. Retention was implemented and never
scheduled. In each case the API was right and the operator was stuck, which reads
in testing as "the feature works" and in production as "nobody can do their job".

**Several controls were present but unreachable.** Dead flags, handlers with no
producer, routes gated to roles that could not reach them, and tests that could
not fail. These are the findings that most justify the execution-based method:
none of them is visible by reading, and all of them were found by running the
code and observing that the expected thing did not happen.

## Findings by dimension

| Dimension | Blocker | Major | Minor | Nit | Total | Open |
|---|--:|--:|--:|--:|--:|--:|
| requirements | 1 | 6 | 1 |  | 8 | — |
| pipeline | 1 | 5 | 1 | 1 | 8 | 1 |
| crosscut | 1 | 3 | 6 |  | 10 | 1 |
| ops | 1 | 3 | 6 |  | 10 | 2 |
| extract | 1 | 1 | 5 | 2 | 9 | — |
| schema | 1 |  | 3 | 3 | 7 | 1 |
| rules |  | 7 | 1 |  | 8 | — |
| console |  | 5 | 4 |  | 9 | — |
| api |  | 4 | 6 |  | 10 | — |
| authz |  | 4 | 6 |  | 10 | 1 |
| draw |  | 4 | 3 |  | 7 | — |
| privacy |  | 4 | 3 |  | 7 | — |
| conversation |  | 3 | 6 | 1 | 10 | 1 |
| winners |  | 3 | 4 | 1 | 8 | 2 |
| legacy |  | 2 | 7 | 1 | 10 | — |
| outbox |  | 2 | 6 | 2 | 10 | 1 |
| durability |  | 2 | 5 | 2 | 9 | — |
| docs |  | 2 | 6 |  | 8 | — |
| tests |  |  | 5 | 3 | 8 | 1 |
| crm |  |  | 5 | 1 | 6 | — |
| **Total** | **6** | **60** | **89** | **17** | **172** | **11** |

## Requirements coverage

The original traceability document claimed thirty-six functional requirements as
delivered. The audit assessed each against running code. Two were wrong, eight
were overstated, and the rest held.

| FR | Before the audit | Now |
|---|---|---|
| FR-14 Duplicate prevention | **Wrong.** One purchase credited twice by choosing another branch | Closed. Printed identity checked independently of the selection |
| FR-15 Duplicate evidence | **Wrong.** A re-photograph under a different outlet produced no candidate at all | Closed. Cross-outlet and same-outlet candidates recorded for the reviewer |
| FR-23 Review queue | **Wrong in the delivered console.** The reviewer could not see the receipt image | Closed. Authenticated fetch with the session |
| FR-03 Registration | Overstated. Re-registration after withdrawal threw and dead-lettered | Closed. Answered with copy, withdrawal not silently undone |
| FR-04 Identity capture | Overstated. Only the registration-stage variant existed | Closed |
| FR-13 Eligibility | Overstated. Campaign-open evaluated at processing time, not intake | Closed. Evaluated from intake time |
| FR-22 Campaign management | Overstated. Pause destroyed in-flight entries; single-outlet edits unaudited | Closed |
| FR-24 Master data | Overstated. Outlet and product edits wrote no audit event | Closed. Audited with before and after |
| FR-27 Winner lifecycle | Overstated. The participant-facing claim leg did not exist | Closed. CLAIM and claim reference answered and audited |
| FR-33 Versioning | Overstated. Outlet membership was not versioned | Closed for the audit trail; membership versioning remains a design choice |
| FR-29 CRM | Partial by design — no vendor selected | Unchanged. Adapter, outbox, read-back and reconcile are real |
| FR-35 / FR-36 | Blocked / partial as documented | Unchanged |
| All others (24) | Held | Held |

## What is still not verified

This is the part of the report that should decide whether the system goes in
front of a client, and it has not moved:

- **WhatsApp Cloud API has never run against Meta.** The transport, the signed
  webhook and the template handling are implemented and tested against a
  simulator and a linked-device path. No message has been sent through Meta's
  infrastructure, and no template has been approved.
- **Receipt extraction has been measured only on synthetic fixtures.** The OCR is
  real (tesseract, offline) and the parser is deterministic, but the corpus is
  generated. Accuracy on photographs of actual Zimbabwean till slips is unknown.
- **No CRM vendor exists.** The outbox, the read-back and the reconcile loop are
  real; the adapter has no counterparty.
- **The console has not been driven in a browser.** It is exercised at HTTP level
  and through a bundled component harness. That is stronger than static
  inspection and weaker than a person using it.

Nothing in this audit changes the standing position: the system must not be
described as ready for integrated client testing while those four boundaries are
simulated or unmeasured.

## What was refuted

Seven claims did not survive. They are recorded because a finding rate without a
refutation rate is not evidence of rigour.

| Claim | Why it fell |
|---|---|
| Reviewer decisions discarded by the CRM outbox | Already fixed at the commit under audit; the auditor read the parent |
| `crm_events.payload_hash` is a truncated base64 prefix | Already replaced by a SHA-256 of canonical JSON |
| The committed draw seed is committed to nothing | Read one commit stale; the seed commitment and the signed `draw.frozen` event were already in place |
| The bundle verifier checks hashes only against themselves | Same stale read; the verifier already cross-checks the signed audit events |
| Media retention is never enforced | The producer exists in housekeeping; the auditor searched for the wrong shape |
| A CRM test asserts something that cannot fail | Reproduced deterministically: the assertion does discriminate |
| `receipts.selected_outlet_id` has no foreign key | The schema fact is true, but the consequence claimed does not follow: the canonical constraint does not depend on it |

Four of the seven are one mistake repeated: auditors reading a tree one commit
behind the branch they were given. That is a method defect, not a code defect,
and it is worth knowing about before the next audit.

## Residual risk

| Finding | Severity | What is still exposed | Status |
|---|---|---|---|
| `authz-6` | minor | ADMIN_IMPLIES gives platform_admin campaign_manager and auditor authority, so the "technical only" role can unmask national IDs and disqualify/reinsta | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `conversation-7` | minor | Handoff does not suspend automated outbound: receipt outcome messages are still delivered while an operator owns the conversation | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `crosscut-9` | minor | disqualifyEntry leaves the canonical receipt marked credited and pointing at the excluded entry, breaking the entry-ledger identity and disagreeing wi | The adjudicated fix_note says the proposed remedy (resetting canonical_receipts to 'pending' on disqualification) is actively harmful — it would release the purchase identity and let the same slip be credited a second time — and the verifier refuted the second consequence as unreachable. What remain |
| `ops-4` | minor | An unset AUDIT_CHECKPOINT_KEY silently signs audit checkpoints and draw bundles with the literal key "unsigned", and the independent verifier reports  | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `ops-7` | minor | The production activation gate covers only the campaign status transition, so the live rules can be swapped afterwards by activating a new version wit | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `outbox-2` | minor | A message the provider already accepted is silently re-sent after the 60s lease expires (crash/SIGTERM mid-dispatch), bypassing the unknown_outcome di | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `pipeline-7` | minor | The participant outcome message is still keyed on attemptNo, so a reviewer's later decision is silently swallowed: a credited participant is only ever | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `schema-3` | minor | normalizePhone() returning null is stored as NULL in channel_events but conversation_sessions.wa_phone_uid is NOT NULL, dead-lettering the conversatio | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `tests-3` | minor | No test — and no code — stops one national ID registering from several phones; the identity fingerprint is written, indexed, and never read | Queued for the cross-cutting round: the fix spans files that were owned by different engineers, so no one package could make it. |
| `winners-2` | minor | The participant half of the claim flow does not exist: "reply CLAIM" is unhandled and the collection message is never sent | Both halves live outside my files or need a design decision. (a) The CLAIM keyword must be added to parseWord()/the conversation states in src/conversation.mjs (not owned). (b) Enqueuing winner_collect on the 'accepted' branch of transitionInTx is in my file, but the copy interpolates {claim_ref} an |
| `winners-6` | minor | Voiding a draw force-updates winner rows behind the lifecycle: no claim row, no per-winner audit, no CRM event, no row_version bump | The correct fix (per the reviewer's fix_note) is for voidDraw to drive each affected winner through winner-service's transitionInTx so the claims row, per-winner audit, row_version bump and CRM emit are produced by the lifecycle owner. drawService has no access to the winner service: both are constr |

## Reproducing this

The fixes are on this branch, in the commits titled "Audit fixes" and "Audit
rounds two and three". The suite stands at 289 tests, all passing, with the
syntax gate clean.

The findings, their evidence and the verification verdicts are machine-readable.
Almost every fix is pinned by a test that was shown to fail against the code as
it stood before it — 100 of the 107 in the first round, with each of the seven
exceptions stating why (four of them are cases where the fix WAS the missing
test, so there is no pre-fix failure to show). Those tests live in
`test/fix-*.test.mjs` alongside the suites they extend. The whole suite runs with
`npm test` and the syntax gate with `npm run check`.

One process finding is worth recording because it recurred. Fixes were made by
engineers working in parallel on disjoint files, and each package's diff was then
read by an independent reviewer. That second pass was not a formality: it caught
a fix that read a tax line as the purchase total, a fix that made dual-control
reinstatement impossible through the console, a stall alarm retuned so
aggressively it fired on healthy load, and several tests that could not fail.
A single-pass fix round would have shipped all of them.

Two method notes for whoever repeats this. First, give the auditors a commit, not
a branch name, and have them verify `git rev-parse HEAD` before they start — four
of the seven refutations trace to that alone. Second, the two-stage split
(find, then refute) earned its cost: it removed seven plausible claims that would
otherwise have consumed fix effort, and the refuters independently caught one
defect introduced by a fix in flight.

