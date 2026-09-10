# Review operations [reviewer]

Queue: Receipts → status `REVIEW_REQUIRED`; the panel shows count, over-SLA (24 h test target, D-14), oldest, by reason.

1. Open the receipt; *Assign to me*. The signed image links expire after 30 minutes — reopen to refresh.
2. Check evidence: document classification, merchant text vs selected outlet, receipt number/date/total, line items with grams, rule results, duplicate candidates (kind, score, whether the same participant), related attempts.
3. Decide: Qualify (requires a complete identity: outlet, date, number; otherwise the API answers `IDENTITY_INCOMPLETE` — request a clearer image instead), Reject with a reason code, Duplicate, Re-upload. The participant is messaged automatically. Decisions carry the receipt's row version; a stale conflict means someone else decided — reload.
4. Duplicate candidates: resolve *same purchase* / *different purchase* for the audit trail; credit itself is decided by the canonical identity.
5. Before a cutoff: the draw barrier blocks freezing while on-time submissions are unresolved; the queue panel shows the period. Escalate to the campaign manager if the SLA cannot be met (D-14 policy).
6. Disqualifying an already credited entry: Entries → Trace → Disqualify with reason; if the entry sits in a frozen/executed draw an independent approver id is required.
