# Architecture

Risk classification: **production service with critical-tier components** (national identity numbers, personal data, privileged staff operations, prize-selection integrity). Critical-tier controls (threat model, ADRs, migration rehearsal, restore rehearsal, independent verification) apply to the identity, ledger, draw and access modules.

## Shape

One Node.js 22 application (ES modules, no framework) with an embedded durable worker, SQLite (WAL) as the transactional system of record, private file storage for receipt media, a React console served statically, and three provider boundaries behind small interfaces: WhatsApp transport, receipt extractor, CRM adapter.

```
Consumer phone ──WhatsApp Cloud API──▶ POST /webhooks/whatsapp (signature check)
                                            │ durable insert: channel_events (UNIQUE provider+account+message+kind)
                                            ▼ 200 OK
                                   worker: intake.processNext()  ──▶ conversation.handle() ──▶ outbox (replies)
                                            │ image ⇒ pipeline.submit(): media store (sharp) + receipts row + job
                                            ▼
                                   worker: jobs receipt.process ──▶ extractor (tesseract.js | vision-LLM)
                                            │                      ──▶ parse-receipt (deterministic)
                                            │                      ──▶ eligibility (integer grams, versioned rules)
                                            │                      ──▶ canonical_receipts claim (UNIQUE)
                                            ▼ one transaction: receipt decision + entry + audit + outbox + crm_events
                                   worker: outbox ──▶ transport.send()   crm_events ──▶ adapter.upsert() + read()
Staff browser ──▶ /api/* (bearer, roles server-side) ──▶ services / pipeline.review / draw / winners
```

## Modules (spec §6)

| Module | File(s) | Owns |
|---|---|---|
| Channel adapter | `src/transport/*.mjs`, webhook in `src/server.mjs` | verify handshake, `X-Hub-Signature-256`, event normalisation, media download (Meta hosts only), sends, delivery callbacks |
| Intake/queue | `src/intake.mjs` | durable event log with leases and dead letters; background jobs |
| Conversation | `src/conversation.mjs`, `src/copy.mjs` | persisted per-phone state machine, menus, registration, outlet navigation, handoff |
| Campaign | `src/services.mjs` | campaigns, immutable versions (rules/content/flags), periods, outlets, products, decisions, settings, pause flags |
| Participant | `src/services.mjs` | profile, encrypted identity + keyed fingerprint, enrollment/consent versions, correction, withdrawal, anonymisation |
| Receipt | `src/media.mjs`, `src/extract/*`, `src/receipt-pipeline.mjs` | private media, normalisation, hashes, extraction attempts, canonical identity, duplicate candidates, review |
| Eligibility | `src/eligibility.mjs` | pure, versioned rule evaluation with reason codes and evidence |
| Entry ledger | `src/receipt-pipeline.mjs` (commit), `entries`, `entry_events` | atomic award, uniqueness, disqualification events |
| Draw | `src/draw.mjs`, `scripts/verify-draw-bundle.mjs` | barrier, snapshot, committed seed, crash-safe execution, approval, void/rerun, bundle |
| Winner | `src/winner-service.mjs` | notify, claim lifecycle, alternates, fulfilment, publication projection |
| CRM | `src/crm.mjs`, `scripts/crm-receiver.mjs` | canonical events, mapping v1, versioned outbox, read-back, reconciliation |
| Operations | `src/routes/admin.mjs`, `src/audit.mjs`, `src/activation.mjs`, `src/worker.mjs` | staff/RBAC, reports, exports, audit chain + checkpoints, alerts, activation validator |

Legacy "WhatsApp Desk" code (`src/desk.mjs`, `src/ai.mjs`, `src/nlp.mjs`, `src/transport/linked-device.mjs`, `src/routes/desk.mjs`, `src/web-console/src/desk/*`) is retained as the user's prior work, quarantined behind roles, and not part of any promotion journey. `linked-device` is refused in production by `validateConfig`.

## Consistency contracts (spec §7)

| Contract | Enforcement |
|---|---|
| Inbound event identity | `channel_events` UNIQUE(provider, provider_account, provider_message_id, event_kind); delivery statuses are distinct kinds |
| Provider retry returns existing result | replay → `duplicate: true`, no reprocessing |
| Channel identity unique | `participants.wa_phone_uid` UNIQUE; E.164 digits with country code retained (`normalizePhone`) |
| One credited receipt per campaign | `canonical_receipts` UNIQUE(campaign_id, canonical_key); key = outlet+date+number+total |
| One award per canonical receipt | `entries` partial UNIQUE(canonical_receipt_id); `weight_units` models an approved multiplier without re-award |
| Atomic decision | `pipeline.commit()` inside one SQLite transaction: validation row, receipt status, entry, canonical status, audit, outbox, CRM event |
| Versions immutable | `campaign_versions.status=activated` cannot be edited; new versions are prospective; receipts pin `campaign_version_id` |
| Draw execution once | `draws.status frozen→executing` reservation; output is a pure function of (snapshot, seed) so retries reproduce it; partial UNIQUE (campaign, period) where status≠voided |
| Approver ≠ operator | checked in `approve()` and by the verifier |
| Audit ordering | single writer reading the chain head inside the caller's transaction; canonical JSON; HMAC checkpoints exported in bundles |
| Optimistic concurrency | `row_version` on receipts, winners, sessions, participants; stale writes return 409 |

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Persist fails at webhook | 503 to the provider → provider retries; nothing acknowledged that is not stored |
| Worker crash mid-job | lease expires → job re-taken; receipt claim `received/delayed/processing → processing` is idempotent; award UNIQUE |
| Extractor down/timeout | receipt `delayed`, participant told, bounded retries with backoff, alert; never a rejection |
| WhatsApp send timeout after possible acceptance | `unknown_outcome`, never auto-retried; operator resolves |
| CRM down | events retry with backoff; entries unaffected; read-back confirms; timeout-after-write → unknown → reconcile |
| Duplicate submitted concurrently | canonical UNIQUE decides; loser gets `DUPLICATE` |

## Data flow for personal data

Identity numbers: AES-256-GCM (`IDENTITY_KEY`) + mask + HMAC fingerprint; reveal requires `winner_ops`/`auditor` with a reason and is audited. Phones masked in lists/exports. Receipt images private on disk, served only through 30-minute HMAC-signed links to reviewers/auditors, purged after `RETENTION_RAW_RECEIPTS_DAYS`. Logs carry correlation ids and masked phone tails only. CRM mapping excludes identity numbers and raw receipts.

## ADR index

See `docs/adr/`: 0001 transport, 0002 persistence and queue, 0003 receipt extraction, 0004 receipt identity and duplicates, 0005 draw auditability, 0006 identity protection, 0007 draws table rebuild (migration 008).
