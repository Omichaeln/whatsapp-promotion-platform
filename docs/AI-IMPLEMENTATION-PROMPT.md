# AI Implementation Prompt — WhatsApp Promotion Platform Gap Closure

Role: principal engineer. Repo: `~/Documents/WhatsApp-Promotion-Platform` (Node ≥22.13, ES modules, `node:sqlite`, `node:test`, Vite at `src/web-console/`). Bind to `docs/GAP-ANALYSIS.md` — implement its defect list in priority order. Do not invent business rules; record any open decision (D-01..D-20) where behavior depends on it. Add or update a test for every change; `npm test` must stay green; run `npm run check`.

## Workstream 1 — Migration CLI (DEF-01)
- `npm run migrate` currently runs `node src/db.js migrate` but no `src/db.js` exists.
- Add a small CLI entrypoint (e.g. `src/db.js`) that opens the configured DB (`DATABASE` env or `./data/promotions.db`), applies `migrate()` from `src/db.mjs`, and prints the result. Update `package.json` only if needed; verify `npm run migrate` exits 0 and is idempotent on a second run.

## Workstream 2 — MFA enforcement (DEF-02, G-12)
- Schema already carries `admin_users.mfa_secret` and `mfa_enabled` (migration 001). Implement TOTP (RFC 6238, SHA-1, 30 s step, 6 digits, base32 secret) using `node:crypto` only.
- Add endpoints: `POST /api/mfa/enroll` (platform_admin; returns `{secret, otpauth://` URI for an authenticator app, QR as SVG data URI)`, `POST /api/mfa/enable` (accepts current code, sets `mfa_secret`+`mfa_enabled=1`), `POST /api/mfa/disable` (requires code + admin role), `POST /api/mfa/verify` for login challenge.
- `auth.login()` must return a `pending_mfa: true` marker when the user has MFA enabled; the client then submits the code to a verify step that only then issues the bearer token. Never issue a token before MFA is satisfied. Keep it optional per-user so existing deployments (e.g. the seeded Railway admin) are not locked out.
- Tests: enrollment generates a valid 6-digit code (verify with a known TOTP vector), wrong code is rejected, token is only issued after valid code, login without MFA still works.

## Workstream 3 — Winners and claims lifecycle (DEF-03, REQ-20/21/22, G-14)
- On `draw.publish()` **also**: for each winner in `draw.output_json`, insert a `winners` row (draw_id, rank, entry_id, participant_id, prize_code from the campaign's draw_config prizes by rank or default `"P1"`, status `pending`), a `claims` row (`state='awaiting_response'`), and enqueue an outbound WhatsApp notification via the outbox (idempotency key like `winner:{winnerId}:notify`). Skip already-materialised winners (idempotent publish).
- Add admin API:
  - `GET /api/winners` — list winners with participant mask + status (winner_ops / auditor).
  - `GET /api/winners/:id` — detail incl. claim history.
  - `PATCH /api/winners/:id` — transition status: `notified→verified→accepted→collected`, or `expired` / `rejected` / `replaced`; appends to `winners.history_json`, creates a new `claims` row per transition, applies winner replacement from the alternates list in `output_json` when `replaced`.
  - `GET /api/winners/public` — only published, approved, disclosure-only fields (no phone/identity), grouped by `draw_period` (REQ-20).
- Tests: publish a draw with N entries → N winner rows + N claim rows + N queued notifications; republish is a no-op; claim transition appends history and writes a new claims row; public view exposes no PII.

## Workstream 4 — Draw rerun (DEF-04)
- Add `POST /api/draws/:id/rerun` (draw_officer + approval reason). It must never mutate an approved draw: create a new linked draw row carrying `superseded_by`/`reason`, re-freeze from the current eligible entries, and require the normal execute→approve cycle. Return both draw ids.

## Workstream 5 — Login rate limiting (DEF-05)
- Add an in-memory per-IP sliding window on `POST /api/login` (e.g. 5 attempts / 60 s → 429 with `Retry-After`). Surviving restarts is acceptable (document it); key by `X-Forwarded-For` first hop then remote address. Return 429 before doing scrypt work.

## Workstream 6 — Exports (DEF-06)
- Add `GET /api/reports/export` (auditor/admin): JSON export of the requested scope (`?scope=receipts|entries|winners|audit|members&since=`), watermarked (`{generated_at, exported_by, scope, watermark:true}`), capped (e.g. 50k rows / 10 MB), and audited via `audit_events` (`action='export'`). This is the controlled-data fallback for CRM (REQ-24) while D-14 is open.

## Workstream 7 — Docs and hygiene
- Add `docs/TRACE.md` (gap → code → test mapping; fill from the table below) and `docs/DECISIONS.md` (D-01..D-20 with current safe default + owner).
- Remove stray `smoke-*.mjs` from repo root (gitignored, but keep the tree clean) — or move under `scripts/`.
- Update `docs/API.md` and `README.md` for the new endpoints; fix any file that still claims Supabase is in use on the server path (it is SQLite through `node:sqlite`; keep Postgres as the documented production option).

## Definition of done (per change)
Code + migration (if any) committed; at least one passing test; `npm test` all green; `npm run check` green; docs/API.md updated; no fabricated runtime results — verify against real `node --test` output. Report: what changed, files touched, tests run + pass/fail, unresolved decisions, and anything blocked (e.g. DEF-08 needs the client corpus + provider key).