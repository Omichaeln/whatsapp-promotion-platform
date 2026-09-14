// The simulator must not show a conversation that reads as delivered when
// nothing left the building.
//
// Reported from a real deployment: every message showed as processed on the
// participant side while the outbound ledger said permanent_failure. Both were
// true. The conversation ran and the reply was produced; the DISPATCH of that
// reply was refused because the test number is not on the outbound allowlist —
// and neither the simulator nor the server transcript carried the reason, so
// "permanent_failure" was a dead end.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

describe("the simulator tells the truth about delivery", () => {
  let h, tok;
  const SIM = "263770000099";
  before(async () => { h = await buildApp({ extractor: "simulator" }); tok = await h.staffToken("manager@example.test"); });
  after(async () => { await h.close(); });

  it("a reply blocked by the allowlist is reported as such, not shown as a normal answer", async () => {
    // Exactly what the deployment guide tells an operator to set before testing.
    h.domain.setSetting("outbound.allowed_recipients", ["263771234567"], "ops");
    const r = await h.api("/api/simulator/inbound", { token: tok, method: "POST", body: { phone: SIM, text: "hi" } });
    assert.equal(r.status, 200);
    const reply = (r.data.replies || [])[0];
    assert.ok(reply, "the bot still answers — the conversation is not what failed");
    assert.ok(reply.text.length, "and its text is returned, because the state machine did run");

    // The half that was missing: the delivery outcome and its reason.
    assert.equal(reply.status, "permanent_failure", "the reply never reached a provider");
    assert.equal(reply.error_code, "RECIPIENT_NOT_ALLOWED", "and the simulator is told why");
    assert.match(reply.error || "", /not a designated test recipient/);

    // The inbound event really is processed: both statements were always true.
    assert.equal(h.db.prepare(`select status from channel_events where wa_phone_uid=? order by received_at desc limit 1`).get(SIM).status, "processed");
  });

  it("the server transcript carries the reason too, so the status is never a dead end", async () => {
    const t = await h.api(`/api/simulator/transcript/${SIM}`, { token: tok });
    assert.equal(t.status, 200);
    const out = (t.data.transcript || []).filter((x) => x.dir === "out");
    assert.ok(out.length, "the ledger is shown");
    assert.ok(out.every((x) => "error_code" in x), "every outbound row carries its reason field");
    assert.ok(out.some((x) => x.error_code === "RECIPIENT_NOT_ALLOWED"), `the blocked reply names its cause: ${JSON.stringify(out.map((x) => x.error_code))}`);
  });

  it("once the number is allowlisted the same conversation delivers", async () => {
    h.domain.setSetting("outbound.allowed_recipients", [SIM], "ops");
    const r = await h.api("/api/simulator/inbound", { token: tok, method: "POST", body: { phone: SIM, text: "hi" } });
    const reply = (r.data.replies || [])[0];
    assert.equal(reply.status, "sent", `the allowlist was the whole problem: ${JSON.stringify(reply)}`);
    assert.equal(reply.error_code, null);
  });
});
