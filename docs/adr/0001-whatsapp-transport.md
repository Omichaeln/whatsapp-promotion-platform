# ADR-0001 WhatsApp transport

**Status:** accepted (implementation complete; live verification pending Meta assets)

**Context.** The existing project shipped three transports: a Meta Cloud API adapter (untested), a Baileys "linked device" (unofficial client; violates WhatsApp Business terms for automation and was being blocked from datacentre IPs), and a simulator.

**Options.** (a) Official Cloud API; (b) BSP/on-prem API; (c) keep Baileys.

**Decision.** Official Cloud API is the only production transport (recommended default for a new business integration). The adapter implements the verify handshake, `X-Hub-Signature-256`, message/status normalisation, template/interactive sends, and two-step media download restricted to Meta hosts. Baileys stays in the repo as dev-only and is refused by `validateConfig` in production. The simulator is TEST ONLY, labelled everywhere, and rejected by the activation validator.

**Failure modes.** Timeouts on POST are recorded as `unknown_outcome` (possible acceptance) and never auto-retried; 4xx are permanent; 429/5xx retry with backoff. Media links expire: download runs in the worker immediately after intake and failures retry within the lease window. Outside the 24-hour window winner contact requires a template (`winner_template_name`); the worker blocks plain text with `TEMPLATE_REQUIRED`.

**Rollout/rollback.** `WHATSAPP_TRANSPORT=cloud-api` + Meta env; rollback to `simulator` only in non-production. Ownership: platform admin (credentials), campaign manager (templates).

**Unverified.** No Meta credentials or network egress to graph.facebook.com were available in the build environment; the adapter is contract-tested (signature, parse, dedupe) but a live send/receive round-trip has not been recorded.
