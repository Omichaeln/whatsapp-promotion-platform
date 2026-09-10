# Evidence index (build of 10 September 2026, branch `claude/funny-brown-r7wpo9`, code commit `f0a7f7a8f4fdbd5f2a57fd12f8359d29d25a3ab5`)

Every file here was produced by running the commands listed against the code in this branch. Nothing is hand-edited except the redaction of temporary passwords in `seed-run.txt`. No file contains a secret value.

| File | Produced by | What it shows |
|---|---|---|
| `test-results.txt` | `npm test` | TAP output of all suites (unit, integration, real OCR, contract, security); final line `exit=0` |
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
