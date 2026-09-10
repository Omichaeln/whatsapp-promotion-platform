# Incident response

1. Contain: pause intake/outbound/draws (campaign pause switches); disable affected staff accounts (sessions revoked immediately); rotate provider tokens if exposed.
2. Preserve: sign an audit checkpoint (Audit → Sign checkpoint) and take a backup (`npm run restore:rehearsal` performs backup + isolated restore verification).
3. Assess: audit search by actor/target; export scoped records (auditor).
4. Recover: follow restore-and-rollback.md if data was altered; replay queues.
5. Report: correlation ids from responses/logs identify requests; personal data in the report must be masked as in the console.
