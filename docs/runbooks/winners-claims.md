# Winners and claims [winner_ops]

Lifecycle: selected → notified → verified → accepted → collected; side states unreachable, declined, disputed, ineligible, expired, replaced.

- **Notify**: sends the approved winner message with a claim reference and 7-day deadline (test value, D-17). Outside the 24-hour window Cloud API requires the configured template; a held message shows `TEMPLATE_REQUIRED` under Integrations → Outbound.
- **Verify**: check identity (Participants → Reveal ID, audited) and the original receipt (Entries → Trace); record the evidence note.
- **Accept**: assign a collection outlet (only outlets with collection enabled are accepted).
- **Collect**: record once with a fulfilment reference; a second attempt is refused.
- **Unreachable/declined/expired**: after the configured deadline the expiry job marks winners expired; *Replace with alternate* promotes the next stored alternate (no new randomness) and the replaced winner's publication is withdrawn.
- **Publish**: only verified/accepted/collected winners; projection = first name + initial, town, prize, week. *Withdraw publication* hides it again. The WhatsApp menu (6) and `GET /api/winners/public` read the same projection.
- Delivery states (sent/delivered/read) appear on the winner page; a provider receipt is not acceptance.
