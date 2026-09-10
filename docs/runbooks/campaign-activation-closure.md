# Campaign activation and closure [campaign_manager]

**Activate (test environments).** Campaigns → open campaign → *Activate*. Requires an activated version. The sample campaign is already active.

**Activate (production).** `POST /api/campaigns/:id/status {status:"active"}` runs the activation validator; every blocking failure is listed (decisions, sample markers, providers, staff, evidence). Fix each, re-run *Campaigns → Activation*. Only `ENVIRONMENT=production` databases can pass.

**Pause.** Four independent switches under the campaign overview: intake (new receipts refused with the paused message), auto-qualify (every decision goes to review), outbound (messages held in the outbox), draws (freeze refused). Already accepted submissions remain queued and are processed when unpaused.

**Close.** Entries and information menus stop; winners remain browsable; unresolved review items, winners, claims and content are retained. **Archive** after the last claim is settled. Nothing is deleted.

**Rule/content change while live.** Create a new draft version (Rules & versions → *New draft from active*), edit, activate. In-flight receipts keep the version captured at intake (`receipts.campaign_version_id`).
