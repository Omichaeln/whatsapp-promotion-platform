# WhatsApp provider outage / delivery failures [platform_admin, support]

Signals: `outbound.failures` alert; Integrations → Outbound shows `retryable_failure` (backoff), `permanent_failure` (4xx: fix content/recipient, then Retry), `unknown_outcome` (timeout after possible acceptance: check the provider's message log before Retry to avoid duplicates). Inbound is unaffected: events persist before acknowledgement.

Steps: check transport health and `lastError`; confirm Meta status page; if the access token expired, rotate `META_ACCESS_TOKEN` and restart; retry failed rows from the console. Winner messages are never auto-retried from `unknown_outcome`.
