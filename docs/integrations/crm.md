# CRM integration

The client's CRM is **not selected** (D-19; Zoho was a supplier capability example). The platform implements the vendor-independent part completely and exposes the provider as `not_configured` until an adapter and sandbox exist.

## Canonical events and mapping (`crm-mapping/1`)

| Entity | Emitted when | Fields (identity numbers and raw receipts excluded) |
|---|---|---|
| participant | registration / profile change | external_key, first_name, surname, phone (masked), town, status |
| enrollment | terms accepted for a campaign | participant_key, campaign, terms_version, privacy_version, marketing_consent, enrolled_at |
| submission | every receipt decision (versioned by attempt) | participant_key, campaign, reference, outlet_code, status, reason, submitted_at |
| entry | award / disqualification | participant_key, campaign, period, outlet_code, submission_reference, status, awarded_at |
| winner | selection and each status change | participant_key, campaign, period, prize, rank, status |
| claim | each claim transition | winner_key, state, collection_outlet, fulfilled_at |

External key: `<environment>:<entity>:<id>` (stable across retries). Preview: `GET /api/crm/mapping-preview?type=entry`.

## Adapter contract (`src/crm.mjs`)

```
upsert({ externalKey, entityType, payload, entityVersion, eventType }) -> { externalId }   // 409 = older version rejected
read({ externalKey, entityType }) -> record with entity_version | null                  // authoritative read-back
health() -> { ok, mode }
```
Delivery is confirmed only when read-back returns `entity_version >= ours`; otherwise the event is `unknown_outcome` and reconciliation resolves it. Older events never overwrite newer state (`crm_external_refs.last_entity_version`).

## Local contract-test receiver

`npm run crm:receiver` (port 5197) implements the contract with fault injection (`CRM_RECEIVER_FAULT=down|timeout-after-write`). Configure `CRM_PROVIDER=webhook CRM_WEBHOOK_URL=http://127.0.0.1:5197`. Tests T-26/T-27 run against it.

## Remaining work for the selected vendor

1. Client names the CRM, provides a sandbox, credentials (kept in the secret store), and the object/field mapping sign-off.
2. Implement `<Vendor>CrmAdapter` with the three methods (OAuth refresh, rate limits, field mapping) in `src/crm.mjs`; select it in `createCrm`.
3. Run T-26/T-27 against the sandbox and record vendor read-back ids in `docs/testing/evidence/`.
4. Approve D-19 (or approve it as "post-launch" to allow activation without the CRM).
