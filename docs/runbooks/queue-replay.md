# Queue replay [platform_admin, support]

Integrations → Queues lists dead/failed inbound events and jobs with the last error. Fix the cause (e.g. extractor down), then *Replay* / *Retry*. Replays are idempotent: the same provider message cannot create a second submission, and a receipt job that already decided returns the stored decision. Alerts `inbound.dead_letter`, `jobs.dead_letter`, `inbound.backlog`.
