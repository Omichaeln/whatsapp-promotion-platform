# Support handoff [support]

A participant replying `SUPPORT` (or agent/human) puts the conversation in handoff: automation replies only "our team is handling this" and an `support.handoff` alert is raised. The conversation page (`GET /api/conversations/:phone`) shows the session state, transcript with delivery states and the participant.

- *Claim* the conversation, reply with *Send* (logged, purpose `support`), and *Release* when done — release resets the participant to the menu.
- Safe status: read submissions and statuses; *Resend result* re-sends the last outcome message for a receipt (logged).
- Corrections to name/surname/town are audited; identity numbers are never edited by support.
- Support cannot credit entries, decide reviews, run draws or reveal identity numbers.
