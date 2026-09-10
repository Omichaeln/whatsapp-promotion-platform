# Receipt benchmark

Report: `docs/testing/evidence/receipt-benchmark.json` (regenerate with `npm run bench`). Extractor: tesseract.js 7 (English best-int model, bundled from npm, reads pixels), parser `parser/2`, rules v2 with the sample product catalogue and a purchase window covering the fixture dates.

Corpus: 40 synthetic fixtures (three till layouts, a ten-receipt draw pool, degraded and duplicate variants, non-receipts, three UAT-reserved images) — **not client receipts**. Split: all held out from parser tuning except that failures observed on the first run drove four parser/rule fixes (documented in the commit history); duplicate variants are grouped with their source so the FINAL outcome is judged with the source credited.

Latest run (10 September 2026; exact figures in the JSON): 40/40 expected outcomes; 17 clear receipts auto-qualified; 0 false automatic awards on invalid/duplicate fixtures; 0 false rejects; review rate 0.20 (the review fixtures are designed to be reviewed); p50 ≈0.9 s, p95 ≈4.5 s per image on one CPU (the ≈26 s outlier is the noise photo where OCR finds thousands of pseudo-words; it still ends REUPLOAD_REQUIRED).

Limitations: synthetic monospace renders are easier than thermal till paper; real corpora will lower recall on receipt numbers and dates first. Thresholds (`review_thresholds`, `outlet_match.min_score`) must be chosen on the client corpus and accepted (`POST /api/evidence/receipt_benchmark_accepted`) before activation.
