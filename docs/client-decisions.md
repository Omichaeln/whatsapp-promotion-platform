# Client decision register (D-01 to D-22)

Source: discovery-call transcript (10 September 2026) and the companion specification. Nothing below is a client answer. Each row records the **test-only value** the sample promotion uses so the whole platform can be built and exercised, and what the client must approve before production activation. The same register lives in the database per campaign (`campaign_decisions`) and is edited under *Campaigns → Decisions*; the production activation validator (`src/activation.mjs`, T-36) refuses activation while any blocking decision is not `approved` with an approved value.

| ID | Question (exact) | Test-only value in the sample campaign | Status | Owner | Dependent functionality | Production activation impact |
|---|---|---|---|---|---|---|
| D-01 | Final campaign name and sponsoring brand | "TEST ONLY — Sample Brown Sugar Promotion", brand "Goldcane (fictional)" | open | client marketing | menu copy, CRM campaign code, public winners page | blocks (sample markers rejected) |
| D-02 | Exact start/end, entry cutoff, draw and publication dates and timezone | 4 weekly periods relative to the seed clock, Monday 00:00 UTC cutoffs, `Africa/Harare` | open | client | period table, barrier, purchase window | blocks |
| D-03 | Eight-week duration, calendar year, November end | not inferred; sample uses 4 weeks | open | client | period table | blocks |
| D-04 | Eligible country/regions/towns and outlet scope | default country code 263; 10 fictional towns | open | client | phone normalisation, outlet master | blocks |
| D-05 | Qualifying brands, SKUs, receipt aliases, pack sizes | `GC-BS-2KG` "Goldcane Brown Sugar 2kg" + aliases; `GC-BS-1KG` | open | client + supplier corpus | product matching, benchmark | blocks |
| D-06 | Two 2 kg packs specifically vs any combination totalling 4 kg | strict: `min_packs=2`, `pack_grams=2000`, `min_total_grams=4000`; `allow_pack_combinations=false` (selectable per version) | open | client legal | rules engine | blocks |
| D-07 | One entry per receipt vs quantity-based multiples | `award.entries_per_receipt=1`; multiplier modelled as `weight_units` but never > 1 | open | client legal | ledger, draw weighting | blocks |
| D-08 | Participant/household/daily/weekly/campaign caps | unlimited additional unique receipts (`caps.per_participant_per_period=null`) | open | client legal | rules engine | blocks |
| D-09 | Receipt dates, refunds, duplicate definition, photocopies/e-receipts | purchase window = campaign window; DMY dates; voided lines excluded; canonical key = outlet + date + number + total | open | client legal | rules, canonical identity | blocks |
| D-10 | Age, staff/supplier, household, prior-winner restrictions | 18+ declaration only; `winner_exclusion=none` | open | client legal | registration, draw barrier | blocks |
| D-11 | Identity number at registration or only from winners | collected at registration (`registration.identity_stage=registration`), AES-256-GCM encrypted, masked, keyed fingerprint | open | client privacy | registration flow, reveal audit | blocks |
| D-12 | Meaning of the location field | town/city free text | open | client | registration, public winner projection | blocks |
| D-13 | Approved outlet master and prize collection locations | 80 fictional branches (`retailer_code=TEST`), collection on ~1/3 | open | client ops | outlet selection, claims | blocks |
| D-14 | Uncertain receipt handling, review target, pending-at-cutoff policy | 24 h review SLA (test), freeze blocked until on-time submissions resolved | open | client ops | review queue, barrier | blocks |
| D-15 | Participant count only or full status/history | `participant_status=true` (counts + last 3 references) | open | client | menu item 7 | blocks |
| D-16 | Winners/alternates per period, prizes, repeat-winner rules | 2 × P1 + 3 × P2 per week, 1 alternate per winner, one prize per participant per draw | open | client | prize plan | blocks |
| D-17 | Winner verification, deadlines, collection proof, replacement | 7-day claim deadline; verified → accepted → collected at a collection outlet; alternates promoted on expiry/decline | open | client ops/legal | winner lifecycle | blocks |
| D-18 | Permitted published winner fields and timing | first name + surname initial, town, prize, week; only after verification and explicit publication | open | client legal | public projection | blocks |
| D-19 | CRM product, fields, access, sandbox, launch priority | generic webhook contract + local contract receiver; vendor not selected; Zoho was a supplier example, not a selection | open | client IT | CRM adapter | blocks unless approved as "post-launch" |
| D-20 | Languages, support hours, escalation contacts, accessibility | English only; SUPPORT keyword handoff; test owner ops@example.test | open | client | content, staffing | blocks |
| D-21 | Registrations, entry volume, peaks, service targets | engineering benchmark only: 5k registrations, 20k receipts, 200/h peak | open | client | capacity, review staffing | blocks |
| D-22 | Data retention/deletion, hosting, processor constraints | raw receipts 90 d, facts 180 d (env), SQLite on a Railway volume; processors: WhatsApp (Meta), hosting | open | client privacy | retention job, DPA | blocks |

Discovered during the build (not in the transcript):

| ID | Question | Test-only value | Why it matters |
|---|---|---|---|
| D-23 | Winner-contact template: Meta requires an approved template outside the 24-hour service window | no template name configured; the worker holds winner messages with `TEMPLATE_REQUIRED` | winner notifications will fail for most winners without it |
| D-24 | Day/month order on receipts (`date_order`) | DMY | ambiguous dates are reviewed only when the two readings disagree about the window |
| D-25 | Reviewer treatment of visually similar images with different receipt numbers | recorded as candidates for the reviewer, never automatic | same-till receipts look alike at hash resolution |

How to approve a decision: *Campaigns → Decisions → Edit*, set the approved value, status `approved`, owner and evidence reference. Every change is audited. Approval in the register does not change campaign behaviour by itself: the corresponding configuration (rules version, periods, outlets, content) must be edited and activated as a new version.
