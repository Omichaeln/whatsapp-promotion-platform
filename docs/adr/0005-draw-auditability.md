# ADR-0005 Draw auditability

**Status:** accepted

**Decision.** Freeze = barrier check (period closed, on-time submissions resolved, enough candidates) + immutable ordered candidate snapshot (entries with `weight_units`) + digest + a 32-byte CSPRNG seed committed **before** any result exists. Execute = one reservation (`frozen→executing`), HMAC-SHA256(seed, entry, unit) ordering (unbiased, no modulo), prize plan applied with one prize per participant, output digest; retries recompute the identical result. Approve requires a different named user and the output hash the approver saw; approved draws are never edited; void/rerun creates a new linked draw and retains the original. The bundle (`GET /api/draws/:id/bundle`) includes the snapshot, seed (only after execution), output, attempts, the draw's audit events and an HMAC-signed audit checkpoint; `scripts/verify-draw-bundle.mjs` recomputes everything without the database.

**Limitation recorded.** Randomness is generated server-side. A witnessed or externally sourced entropy commitment (e.g. a published hash of the seed before execution) is possible — the seed is committed at freeze and could be published as `sha256(seed)` — but is not exposed by default pending the client's governance choice (D-16/D-17).
