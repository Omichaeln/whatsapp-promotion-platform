# Runbooks

All runbooks assume console access with the named role in brackets and, where stated, shell access to the deployment. Never run sample-reset or seed commands against production (`ENVIRONMENT=production` refuses them).

| Runbook | Trigger |
|---|---|
| campaign-activation-closure.md | going live, pausing, closing, archiving |
| review-operations.md | review backlog alert, cutoff approaching |
| draw-and-verification.md | weekly draw, dispute |
| winners-claims.md | winner contact failures, expiry, alternates |
| support-handoff.md | participant asks for a human |
| provider-outage.md | WhatsApp unavailable / delivery failures |
| queue-replay.md | dead-lettered events or jobs |
| media-and-extraction.md | OCR failures, delayed receipts |
| crm-reconciliation.md | CRM failures / unknown outcomes |
| incident-response.md | security or data incident |
| privacy-requests.md | access, correction, withdrawal, deletion |
| restore-and-rollback.md | data loss, bad release |
