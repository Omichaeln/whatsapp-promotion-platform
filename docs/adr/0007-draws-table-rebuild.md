# ADR-0007 Reruns and the v1 draws uniqueness constraint

**Status:** accepted (supersedes an earlier plan to rebuild the table)

**Context.** Migration 004 created `draws` with `UNIQUE(campaign_id, draw_period)`. An authorised rerun needs a second draw for the same period. A table rebuild (drop + recreate) was rehearsed and **rejected**: with foreign keys enforced, `DROP TABLE draws` fails once `draw_candidates`/`winners` reference it, and SQLite cannot toggle `foreign_keys` inside the migration transaction.

**Decision.** No schema change. `draws.draw_period` is an internal label: the first draw for a period uses the period code, a rerun uses `code#2`, `code#3` …. The period **code and label shown anywhere** (console, WhatsApp winners, public API, CRM, bundles) come from `campaign_periods` via `draws.period_id`. Linkage stays explicit through `supersedes` / `superseded_by`. The original constraint therefore still prevents two draws with the same label, and reruns are always distinguishable.

**Consequences.** Zero-risk on populated data; the verifier compares the snapshot's `periodCode` with the period code, not the label. Migration 007 (expand-only) was rehearsed on populated v1 data with foreign keys ON (`docs/testing/evidence/migration-rehearsal.json`).
