# Threat model (lightweight)

Assets: participant personal data (names, phones, towns, identity numbers), receipt images, the entry ledger, draw evidence, winner records, staff credentials, provider credentials.

| Surface | Threat | Control | Test |
|---|---|---|---|
| Inbound webhook | forged events, replay, flooding, oversized bodies | `X-Hub-Signature-256` with app secret (timing-safe); UNIQUE event identity; 4 MB body cap; durable-then-ack; simulator webhooks refused in production | T-28, T-13 |
| Uploads | malformed/oversized images, decompression bombs, non-image files, prompt injection in images | `sharp` metadata check (format allowlist, ≤10 MB, ≤40 MP, ≥64 px), original never executed, OCR text is data only, classification rejects non-receipts, instruction-like text flagged and ignored | T-08, T-09 |
| Extraction provider | data exfiltration, model manipulation, cost abuse | default extractor is offline; vision-LLM gets only the normalised image and a fixed system prompt with no tools; strict schema validation and re-parse; timeouts | benchmark, T-09 |
| Personal data | leakage via logs/exports/API | masks on phones and identity numbers; encrypted identity; audited reveal; CSV formula neutralisation; watermarked, role-gated exports; no PII in logs (correlation ids) | T-30, T-31 |
| Staff access | credential stuffing, shared accounts, privilege creep, stolen sessions | named accounts, scrypt, temporary passwords that must change, per-IP login rate limit, TOTP MFA, hashed bearer tokens with expiry, revocation on role change/disable, technical admin without draw/prize authority | T-29, security suite |
| Direct API abuse | bypassing UI permissions, ID enumeration, cross-campaign reads | roles on every route server-side; 404 without detail; campaign-scoped queries; PATCH/POST validation with size caps | T-29 |
| Media links | long-lived receipt URLs, sharing | 30-minute HMAC-signed links, reviewer/auditor only, `no-store`, timing-safe compare | T-30 |
| Duplicate/fraud attempts | same receipt from many phones, re-photographed copies, concurrent submissions, till-number reuse | canonical key with outlet+date+number+total; UNIQUE claim; concurrent loser → duplicate; reviewer candidates; ownership disputes to review | T-06, T-07, T-12, T-14 |
| Draw manipulation | selective rerolls, editing results, self-approval, tampering with evidence | seed committed at freeze; deterministic execution; reservation; approver ≠ operator; output hash verified at approval; void/rerun as new linked draw; bundle verifier; signed audit checkpoints | T-20, T-21, T-22 |
| Winner notification | premature or duplicate contact, contacting non-winners | notify only from approved draws; idempotency key per attempt; unknown outcomes held; recipient allowlist outside production; template requirement | T-23, T-28 |
| CRM | duplicate objects, older data overwriting newer, leaking identity | keyed upsert with external key; version guard; read-back; identity excluded from mapping | T-26, T-27 |
| Audit | rewriting history by a DB operator | hash chain + HMAC checkpoints exported outside the DB (bundles/evidence); single writer | audit test, T-22 |
| SSRF | attacker-controlled media URLs | media downloaded only from Meta hosts by regex allowlist; no user URLs fetched | code review |
| Availability | worker crash, provider outage, disk full | leases and dead letters; outbox retries; alerts with runbooks; webhook 503 on persist failure | T-13, T-28 |

Residual risks: (1) SQLite single-node availability; (2) OCR accuracy on real till paper unproven until the client corpus is benchmarked; (3) no POS feed, so refund/return after purchase is undetectable except by review; (4) server-side randomness without an external witness (ADR-0005).
