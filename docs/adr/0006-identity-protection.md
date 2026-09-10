# ADR-0006 Identity number protection

**Status:** accepted

**Decision.** Identity numbers are collected at registration as the client requested (D-11 keeps the option to defer to winners via `registration.identity_stage`). Storage: AES-256-GCM with a key derived from `IDENTITY_KEY`, a display mask, and a keyed HMAC fingerprint for equality checks (never a plain hash). Reveal is a separate audited action limited to `winner_ops`/`auditor` with a reason. Identity values are excluded from logs, exports and the CRM mapping. Anonymisation clears them while keeping ledger references.

**Alternatives rejected.** Plain SHA-256 (guessable from the small ID space); storing plaintext; collecting only from winners by default (would remove a requested capability without client approval).
