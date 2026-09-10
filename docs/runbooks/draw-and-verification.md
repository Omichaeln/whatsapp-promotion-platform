# Draw and independent verification [draw_officer, draw_approver, auditor]

1. Draws → choose the period → *Check barrier*. Blockers: `PERIOD_OPEN`, `UNRESOLVED_SUBMISSIONS` (list by status), `DRAW_EXISTS`, `NO_CANDIDATES`, `INSUFFICIENT_CANDIDATES`. Resolve them (review queue) — do not override in production.
2. *Freeze candidates* (draw officer). This snapshots the ordered candidate list and commits the random seed. The period becomes `closed`.
3. *Execute* (draw officer). Deterministic from the committed seed; a crash or double click yields the same result. The output hash is displayed.
4. *Approve* (a **different** user with `draw_approver`). The approval request carries the output hash the approver saw; an integrity recomputation runs first. Reject with a reason to void.
5. *Publish* (winner_ops): winner records are created (status `selected`); nothing is public yet.
6. Independent verification (auditor): `GET /api/draws/:id/bundle` → save as `bundle.json` → `npm run verify:draw -- bundle.json --checkpoint-key $AUDIT_CHECKPOINT_KEY`. Exit 0 = verified. The verifier recomputes digests, ordering, prize application and separation of duties without the database. Keep the bundle with the campaign records.
7. Dispute: never edit. *Void + rerun* requires a reason and a second approver; the original draw and evidence remain linked (`supersedes`/`superseded_by`); its winners are marked replaced/withdrawn.
