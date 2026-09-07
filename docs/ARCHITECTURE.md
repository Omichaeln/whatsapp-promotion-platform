# Architecture

Modular monolith (one deployable Node app + durable worker loop), Postgres/Supabase
as the system of record in production (SQLite via `node:sqlite` for dev/tests),
private object storage for receipt media, durable queue between webhook intake
and evaluation, transactional outbox for WhatsApp + CRM side effects.

## Components and failure behaviour

| Component | Responsibility | Failure behaviour |
|---|---|---|
| WhatsApp transport | Webhooks, media retrieval, outbound (text/interactive/template), delivery states | Idempotent retries; no duplicate side effects |
| Webhook gateway | Authenticity (X-Hub-Signature-256), normalize, durable intake | Reject invalid; acknowledge only after durable insert |
| Conversation orchestrator | Explicit per-campaign/phone state machine | Resume last valid state; safe help on unknown input |
| Campaign service | Versioned dates, rules, outlets, products, copy, flags | Fail closed for entries if no active version |
| Participant service | Profile, consent versions, correction, withdrawal | No entry without valid profile + consent |
| Receipt ingestion | Private storage, SHA-256 + phash + metadata | Retry while retrievable; re-upload after terminal failure |
| Receipt intelligence | Structured evidence + confidence + model version | Low confidence -> review; never silent qualify |
| Eligibility engine | Deterministic rules on frozen version | Missing/ambiguous evidence -> review |
| Duplicate detector | Provider ID, SHA-256, fingerprint, perceptual similarity | Exact -> duplicate; probable -> review |
| Entry ledger | One qualified entry per receipt, atomic with decision | Unique constraints; concurrent submits safe |
| Review service | Assignment, evidence, decisions, SLA | Prior decisions preserved; override needs reason + audit |
| Draw service | Frozen snapshot, HMAC sortition, evidence, approve | Immutable after approval; rerun = new linked draw |
| Winner service | Notify, verify, collect, expire, alternate | Every transition retained |
| CRM adapter | Canonical events -> outbox -> provider | Entry stays valid during outage; retry + dead letters |
| Auth/RBAC | scrypt, hashed tokens, least privilege | Server-side enforcement on every route |
| Audit | Hash-chained append-only events | Actors, actions, reasons, request IDs |

## Key flows

### Receipt decision (spec 11.2)
store media -> extract evidence -> insert receipt (UNIQUE provider message id) ->
exact duplicate? -> fingerprint duplicate? -> probable similarity -> deterministic
rules -> ATOMIC commit {validation, receipt decision, entry-if-qualified, review
task-if-review, outbox message, CRM event, audit} — in one SQLite transaction.

### Draw (spec 11.5)
close period -> freeze eligible entries + exclusions (snapshot hash) ->
CSPRNG seed -> HMAC-SHA256 sortition -> operator executes -> separate approver
approves -> publish. Output hash recorded; `scripts/reconstruct-draw.mjs`
recomputes it from the frozen evidence (acceptance test A-10).

## Idempotency map (spec 14)

| Scenario | Mechanism |
|---|---|
| Webhook replay | unique provider_message_id (inbound_events) |
| Worker retry | idempotency_key on outbound_messages |
| Same image resent | unique SHA-256 on media_assets + receipts |
| Re-photographed | normalized receipt fingerprint; perceptual similarity -> review |
| Concurrent submits | transaction + unique constraints |
| CRM outage | transactional outbox; dead letters; reconcile view |
| Rule change mid-flight | receipt bound to immutable campaign_version_id |

## Security posture (spec 15)
TLS everywhere; Meta signature verification; scrypt password hashes; bearer
tokens stored as SHA-256; identity values AES-256-GCM encrypted + masked;
raw receipt media private with short-lived HMAC-signed review URLs; PII never
in logs (masked phone tails only); retention (configured in `.env.example`).

## Honest boundary (spec "Do not present as launch-ready")
The extractor shipped is a deterministic simulator for dev/test. Production
requires the labelled receipt corpus benchmark (G-07), Meta asset onboarding
(D-20), final campaign rules (D-01..D-09), CRM contract (D-14), and named
operational owners (D-17) before activation — see docs/DECISIONS.md.