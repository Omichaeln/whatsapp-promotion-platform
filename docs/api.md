# API

The live contract is generated from the route table: `GET /api/openapi.json` (OpenAPI 3.0; roles per route in `x-roles`). Conventions: bearer tokens (`POST /api/login`, `/api/login/mfa`), roles enforced server-side, JSON errors `{ error: { code, message, correlationId } }` with `x-correlation-id` on every response, `?limit&offset` pagination with `next`, unknown body fields ignored, body caps (5 MB default; 12 MB simulator inbound; 2 MB CSV import). Provider webhooks: `GET/POST /webhooks/whatsapp`. Public: `GET /api/winners/public`, `GET /api/config`, `/health/live`, `/health/ready`.
