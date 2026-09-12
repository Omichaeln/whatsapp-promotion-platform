# Evidence index (build of 10 September 2026, branch `claude/funny-brown-r7wpo9`)

Every file here was produced by running the commands listed against the code in this branch. **Provenance, taken from git rather than from memory:** every artefact except the two recordings named next was produced at commit `d0bf6327ea646726b51d106ff190b42e62d7439a`; `test-results.txt` and `remote-smoke-staging-rehearsal.txt`/`.json` were last regenerated later, at `86ebef8a71dc424dae292f7232b90cbb157562b0`. Check either with `git log -1 -- docs/testing/evidence/<file>`. (Revisions of this page up to the round-two audit cited a pre-rebase hash that is not reachable from this branch at all; a delivery document that names a commit nobody can check out is worse than one that names none, so every hash on this page and in `docs/TEST_READINESS.md` / `docs/requirements-traceability.md` is now asserted to be an ancestor of HEAD by `test/fix-docs.test.mjs`.) Nothing is hand-edited except the redaction of temporary passwords in `seed-run.txt`. No file contains a secret value.

| File | Produced by | What it shows |
|---|---|---|
| `test-results.txt` | `npm test` | TAP output of the suites that existed at this commit (unit, integration, real OCR, contract, security): 46 tests in 9 suites, final line `exit=0`. **Stale**: `test/audit-integrity.test.mjs` and `test/media-limits.test.mjs` were added later and are not in this recording — re-run `npm test` and replace this file before the counts are quoted as coverage of the branch tip |
| `receipt-benchmark.json` | `npm run bench` | per-fixture OCR outcome vs label, false accepts/rejects, review rate, latency percentiles, by-layout summary |
| `load-benchmark.json` | `npm run load -- --receipts 30 --concurrency 5` | intake/processing throughput and latency with real OCR on one worker (engineering benchmark, not a capacity claim); the same six fixture images are shared across phones on purpose, so most outcomes are DUPLICATE / ownership-dispute REVIEW — the integrity check is `double_credits: 0` |
| `migration-rehearsal.json` | rehearsal script (see `docs/release/migrations.md`) | migration 007 applied to a populated v1-shaped database with foreign keys ON; row counts identical, integrity ok |
| `restore-rehearsal.json` | `npm run restore:rehearsal` | point-in-time backup, isolated restore, integrity + audit-chain checks, measured RTO |
| `preflight.json` | `npm run preflight` | environment preflight on the seeded local database (no blocking problems; provider modes labelled) |
| `seed-run.txt` | `npm run seed` (passwords redacted) | TEST ONLY sample: 12 participants, receipts through real OCR with outcomes by status, entries, draw W-2 published, winners by state |
| `draw-bundle-W-2.json` | `GET /api/draws/<id>/bundle` as an auditor | exported bundle of the seeded published draw (snapshot, seed, output, attempts, audit events, checkpoint) |
| `draw-verify-W-2.txt` | `npm run verify:draw -- draw-bundle-W-2.json` | independent verifier: all checks pass; a copy with one winner altered fails (`exit=1`) |
| `http-smoke.txt` | `curl` against `POST /api/simulator/inbound` | a complete registration → outlet → receipt journey over HTTP; cross-phone re-use of a credited receipt blocked |
| `readiness-endpoint.json` | `GET /api/readiness` | provider modes, three-level readiness flags, open decisions, activation validator result |
| `remote-smoke-staging-rehearsal.txt` / `.json` | `npm run smoke:remote` against `src/bootstrap.mjs` started with the Railway start command under `ENVIRONMENT=staging`, `HOST=0.0.0.0`, `SEED_POPULATED=true` | 95/95 black-box checks over HTTP covering every function group (see `docs/release/railway-deploy.md` §4); the same command is run against the Railway URL once deployed |
| `dependency-audit.txt` | `npm run audit:deps` | production dependency audit (0 vulnerabilities at build time) |

Reproduce: `npm ci && npm run fixtures && npm run migrate && npm run seed && npm test && npm run bench && npm run load -- --receipts 30 --concurrency 5 && npm run restore:rehearsal && npm run preflight`.
