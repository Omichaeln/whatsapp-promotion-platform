# ADR-0003 Receipt extraction

**Status:** accepted

**Context.** The previous implementation's only extractor decoded facts embedded in fixture bytes (not real OCR) and the "vision" adapter was a stub. The spec requires actual pixel processing of images that were unknown when the code was written.

**Options.** (a) tesseract.js (WASM Tesseract 5, English data bundled from npm) run in-process; (b) system Tesseract binary; (c) vision LLM via an OpenAI-compatible endpoint; (d) hosted OCR (Google/AWS).

**Decision.** A single extractor contract (`src/extract/receipt-extractor.mjs`) with two real implementations: **tesseract.js** as the default (offline, deterministic, deploys on Railway without system packages, ≈1 s per clear image) and **vision-LLM** fully implemented behind a strict JSON schema with re-parsing by our own parser (available when a key is supplied; unverified live). Extraction output is evidence only; `parse-receipt.mjs` derives facts deterministically and `eligibility.mjs` decides. The simulator extractor remains for fast unit tests, is marked `simulated`, and is rejected by the activation validator.

**Consequences.** OCR quality on real till paper must be benchmarked on the client corpus before launch (`docs/testing/receipt-benchmark.md`); thresholds (`review_thresholds`) are per campaign version. Rotation is handled by a bounded retry (90°/270°) when the upright pass does not look like a receipt. Text in images is never treated as instructions.
