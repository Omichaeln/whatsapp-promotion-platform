# WhatsApp Promotion Platform

End-to-end WhatsApp promotion system: entry, consent, receipt validation,
duplicate prevention, immutable entry ledger, auditable draws, winners, claims,
CRM synchronisation, and role-based administration.

Built as a **new repository** per instruction. Reuses the design patterns of the
original WhatsApp Desk (transport interface, operator-console patterns, message
storage, AI usage controls) but is a clean implementation, not a fork.

## Status

- **Implemented and tested (11 tests green):** registration + consent, menu
  conversation state machine, private media intake with SHA-256 + perceptual
  hashing, deterministic versioned eligibility, exact/fingerprint duplicate
  prevention, atomic entry ledger, human review, auditable HMAC-sortition draws
  with independent reconstruction, admin auth (scrypt + tokens + RBAC),
  transactional outbox (WhatsApp + CRM), hash-chained audit events.
- **Production path:** official WhatsApp Cloud API adapter ships behind the
  `WhatsAppTransport` interface. Simulator transport is the default for dev.
- **Client decisions still required before production** (spec D-01..D-20):
  final campaign dates/rules, ID-number handling, outlet master, prize/draw
  schedule, CRM provider contract, receipt-match benchmark against a labelled
  corpus, named operation owners. Safe fail-closed defaults are used until then.

## Quickstart (local, zero dependencies)

```bash
# Node >= 22.13 (uses node:sqlite, node:test, node:crypto — no npm install)
npm run migrate   # apply db/migrations (auto on `start` too)
npm run seed      # demo campaign: ZimSweet Brown Sugar (2x2kg), 10 outlets
npm test          # full suite
npm start         # HTTP server + worker loop (simulator transport) on :5191
```

Admin bootstrap: `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars (first run only).
Login → `POST /api/login` → bearer token.

### Live webhook smoke (simulator)

```bash
curl -X POST http://127.0.0.1:5191/webhooks/whatsapp -H 'content-type: application/json' \
  -d '{"events":[{"providerMessageId":"w1","phoneUid":"263771234567","type":"message.text","text":"2"}]}'
```

Inbound events are persisted under the unique provider message ID *before*
processing; webhook replays are deduped and never create a second entry.

## Architecture

Modular monolith + durable worker (spec §10). See `docs/ARCHITECTURE.md`.

```
Participant -> Cloud API Webhook -> durable inbound intake -> conversation
state machine -> private media store -> receipt extractor (evidence) ->
deterministic eligibility + duplicate controls -> ATOMIC entry ledger
-> outbox (WhatsApp + CRM) | review queue | draw & winner service
Admin portal -> scrypt auth + RBAC -> domain APIs -> hash-chained audit
```

Key invariants (spec §10.4): retries/replays create no second entry; an entry
exists only if the decision + entry commit atomically; OCR output is evidence,
deterministic rules or a reviewer decide; draws use frozen snapshots and CSPRNG
sortition that a second operator can reconstruct; a CRM outage never loses an
accepted entry; raw receipts are private (signed, short-lived review URLs only).

## Project layout

```
db/migrations/       001-005 ordered SQL (domain, media, draws, outbox, indexes)
src/config.mjs       env config (fail-fast)
src/db.mjs           sqlite + transactions + crypto helpers
src/media.mjs        PNG codec + aHash + private media store + signed URLs
src/services.mjs     campaigns, versions, outlets, participants, consent, sessions
src/eligibility.mjs  deterministic versioned rules
src/duplicates.mjs   exact (msg id / SHA-256) + fingerprint + perceptual
src/receipt-pipeline.mjs  intake -> evidence -> decision -> atomic entry
src/conversation.mjs customer state machine (menu/register/entry/review)
src/draw.mjs         freeze -> sortition -> approve -> publish + evidence
src/outbox.mjs       transactional outbox (WhatsApp ledger + CRM)
src/crm.mjs          provider adapter w/ retries + dead letters
src/auth.mjs         scrypt login, token hashing, RBAC
src/server.mjs       HTTP: webhooks, health, admin API, signed media
src/worker.mjs       outbox/CMS drains
src/transport/       simulator | cloud-api (Meta) adapters
scripts/             seed-demo, reconstruct-draw
test/                node:test suite (11 tests)
docs/                architecture, operations, gap traceability
```

## Traceability

| Area | Implemented |
|---|---|
| REQ-02..06 | menu, one-time registration, consent, repeat entry |
| REQ-07 | controlled outlet selection from master |
| REQ-08..12 | image intake, safe evidence extraction, deterministic rules |
| REQ-13..14 | duplicate prevention, multiple unique receipts |
| REQ-15,21..24 | outcome messages, auditable draws, admin, CRM outbox |
| REQ-20,22 | winners + claims lifecycle (materialised on publish, masked public view) |
| Security | TOTP MFA login challenge + enrollment; login rate limit; audited exports |
| G-01..G-20 | see `docs/TRACE.md` for gap-by-gap mapping |
| D-01..D-20 | open client decisions — fail-closed defaults used, listed in `docs/DECISIONS.md` |
| Gap closure | current analysis + execution plan in `docs/GAP-ANALYSIS.md` and `docs/AI-IMPLEMENTATION-PROMPT.md` |

## Operations

See `docs/OPERATIONS.md`: runbooks (provider outage, replay storm, CRM outage,
review backlog, draw dispute, restore), retention policy, monitoring signals,
and the launch gate checklist (acceptance criteria A-01..A-14).

## Verification

`npm test` → 11 passing (eligibility, duplicates, conversation, auth/RBAC,
draw reconstruction). `npm run reconstruct-draw -- <draw_id>` independently
recomputes a stored draw's output hash from its frozen snapshot and seed.

## Deployment (Railway)

Live demo: **https://whatsapp-promotion-platform-production.up.railway.app**

The repo deploys as-is via Nixpacks (see `Procfile`, `railway.json`, `.nvmrc`):

- `Procfile` runs `src/bootstrap.mjs`: migrate → seed demo campaign on an empty
  DB → HTTP server + worker loop.
- `src/config.mjs` auto-detects Railway env vars: binds `0.0.0.0`, and keeps
  the database + receipts on the mounted **`/app/data`** volume (add one:
  `railway volume add --mount-path /app/data`).
- Required variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (a public deploy fails
  fast without an explicit password), `WHATSAPP_TRANSPORT=simulator` for UAT.
- Meta Cloud API is the production transport: set `WHATSAPP_TRANSPORT=cloud-api`
  plus the `META_*` vars and a custom domain once assets are approved (D-20).

```bash
railway login
railway init --name <project>
railway up -d -y
railway domain              # get the public URL
```

Note: `railway.json` (Config as Code) is deprecated upstream — the `Procfile`
is authoritative for the start command; migrate to `.railway/railway.ts` if
you adopt Railway IaC.

## License

MIT — original WhatsApp Desk is MIT-licensed; this is a clean new implementation.