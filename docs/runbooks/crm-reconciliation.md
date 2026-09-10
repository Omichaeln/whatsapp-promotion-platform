# CRM reconciliation [support, platform_admin]

Integrations → CRM outbox shows pending/delivered/failed/unknown/reconciled with the last error. *Reconcile* reads back every unknown/failed event from the vendor: present with our version → `reconciled`; absent → re-queued (safe: keyed upsert). Older versions are dropped as `superseded` so the vendor never regresses. A CRM outage never affects entries or participant messages.
