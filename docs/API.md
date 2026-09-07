# CLI reference

## npm run migrate
Applies ordered `db/migrations/*.sql`, tracked in `schema_meta`. Idempotent.
Also runs automatically on `npm start`. Never mutate production schema by hand.

## npm run seed
Creates the demo campaign `BROWN-SUGAR-2026` (active), a frozen version with
the default rule (2 x 2kg packs OR 4kg total — D-03), 10 outlets, and the
product. **Does not** create participants, receipts, entries or draws.

## npm start
Boots HTTP server + worker loop. Env: see `.env.example`. Defaults:
`HOST=127.0.0.1`, `PORT=5191`, transport `simulator`, DB `./data/promotions.db`.

## npm test
Runs the node:test suite: eligibility rules, duplicate prevention (exact SHA-256,
provider-message replay, fingerprint), conversation wiring, auth/RBAC, and draw
reconstruction.

## npm run reconstruct-draw -- <draw_id>
Reads a stored draw's frozen `snapshot_json`, `seed_hex`, and `algorithm`,
recomputes the HMAC sortition output, prints both stored and recomputed winner
orders and hashes, exits 0 only if they match (A-10 reconstruction test).

## npm run check
`node --check` over all source/script/test files (syntax gate).

# HTTP API (summary)

| Method + path | Purpose | Role |
|---|---|---|
| GET /webhooks/whatsapp | Cloud API verification handshake | public |
| POST /webhooks/whatsapp | inbound events | signature-verified |
| GET /health/live, /health/ready | liveness / readiness | public |
| POST /api/login | named-identity login -> bearer token | public |
| POST /api/logout | revoke session | any authenticated |
| GET /api/whoami | current principal + roles | any authenticated |
| GET/POST /api/campaigns | list / create | campaign_manager |
| POST /api/campaigns/:id/versions | draft version | campaign_manager |
| POST /api/campaigns/:id/versions/:vid/activate | freeze + activate | campaign_manager |
| GET/POST /api/outlets, /api/products | master data | campaign_manager |
| GET /api/receipts, /api/receipts/:id | search / detail + evidence | reviewer/auditor |
| POST /api/receipts/:id/reviews | reviewer decision | reviewer |
| GET /api/media/:id?exp&sig | signed short-lived media | reviewer |
| GET /api/entries | qualified entries | ops/auditor |
| POST /api/draws | freeze snapshot | draw_officer |
| POST /api/draws/:id/execute | sortition | draw_officer |
| POST /api/draws/:id/approve | approve | draw_approver |
| POST /api/draws/:id/publish | publish winners | winner_ops |
| GET /api/crm-sync | outbox + reconciliation | support/admin |
| GET /api/audit-events | hash-chained audit | auditor |

All non-provider routes authenticate with `Authorization: Bearer <token>` and
enforce roles server-side. Error responses are stable codes without PII.