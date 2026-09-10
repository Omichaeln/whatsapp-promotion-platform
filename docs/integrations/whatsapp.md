# WhatsApp integration

## Status in this build

| Item | State |
|---|---|
| Cloud API adapter (`src/transport/cloud-api.mjs`) | implemented against the Graph API contract; **not verified live** (no Meta assets or egress in the build environment) |
| Webhook verification + signature | implemented and tested (T-28) |
| Inbound parsing (text, image, document, interactive, button, statuses) | implemented and tested |
| Media download (two-step, Meta hosts only, size cap) | implemented; unverified live |
| Outbound text / template / interactive | implemented; unverified live |
| Simulator transport | TEST ONLY; console "Test a customer" and `POST /webhooks/whatsapp` (non-production) |
| Linked device (Baileys) | dev only; refused in production |

## Connecting the client's test number (to reach "integrated client testing")

1. Meta Business Manager: WhatsApp Business Account, phone number (the client-owned number), a system user with `whatsapp_business_messaging` and `whatsapp_business_management`, and a permanent access token.
2. Set on the deployment: `WHATSAPP_TRANSPORT=cloud-api`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_TOKEN` (any long random string), `PUBLIC_BASE_URL`.
3. In the Meta app, configure the webhook callback `https://<PUBLIC_BASE_URL>/webhooks/whatsapp` with the verify token; subscribe to `messages`. The handshake is `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.
4. Add test recipients (Meta test numbers or the client's testers) and set the non-production allowlist: `PUT /api/settings/outbound.allowed_recipients` `{ "value": ["2637…"] }` so no one else can be messaged from a test environment.
5. Create and get approved a **winner-contact template** (utility category) with three body parameters: first name, prize, claim reference. Set its name under *Campaigns → Content → winner_template_name*. Without it, winner messages outside the 24-hour window are held with `TEMPLATE_REQUIRED`.
6. Verify: send "hi" from a test phone; check *Integrations → Last inbound* and *Outbound* (status `sent` → `delivered` → `read` from status callbacks). Record the provider message ids in `docs/testing/evidence/` as the read-back evidence.
7. Entry link: `https://wa.me/<number>?text=hi` (campaign link/QR). A device-pairing QR is not integration evidence.

## Operational notes

- Meta expects a fast 200; the platform stores the event first and processes in the worker.
- Delivery statuses arrive as separate events per status and update the outbox ledger.
- Rate limits and message-tier limits are per WABA; the worker sends sequentially per tick and backs off on 429.
- Interactive list messages are supported by the adapter (`kind: "interactive"`) but the conversation currently uses numbered text menus, which work in every WhatsApp client; switching the outlet chooser to list messages is a content-level change.
