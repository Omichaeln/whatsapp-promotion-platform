// Authorisation, adversarial API use, privacy and audit (T-29, T-30, T-31, T-36, T-15 concurrency).
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

describe("security, RBAC, privacy, audit", () => {
  let h, admin, tokens = {};
  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    admin = await h.login("admin@x.test", "TestAdminPassword123");
    for (const e of ["reviewer", "support", "draw", "approver", "fulfilment", "auditor", "manager"]) tokens[e] = await h.staffToken(`${e}@example.test`);
    await h.register("263771000301", { first: "Sec", last: "One", identity: "TESTSEC1X" });
    await h.submit("263771000301", await h.simImage(h.simReceipt({ no: "SEC-1" })));
  });
  after(async () => { await h.close(); });

  it("T-29: unauthenticated and under-privileged calls are denied server-side; technical admin cannot run or approve draws", async () => {
    assert.equal((await h.api("/api/receipts")).status, 401);
    assert.equal((await h.api("/api/receipts", { token: "0".repeat(64) })).status, 401);
    assert.equal((await h.api("/api/users", { token: tokens.reviewer })).status, 403);
    assert.equal((await h.api("/api/reports/export?scope=participants", { token: tokens.reviewer })).status, 403);
    const period = h.domain.listPeriods(h.campaign.id)[0];
    assert.equal((await h.api("/api/draws", { method: "POST", token: admin, body: { campaign_id: h.campaign.id, period_id: period.id } })).status, 403, "platform_admin is not a draw officer");
    assert.equal((await h.api("/api/draws", { method: "POST", token: tokens.reviewer, body: { campaign_id: h.campaign.id, period_id: period.id } })).status, 403);
    assert.equal((await h.api("/api/winners", { token: tokens.reviewer })).status, 403);
    assert.equal((await h.api("/api/participants/ptc_nope/reveal-identity", { method: "POST", token: tokens.support, body: { reason: "x" } })).status, 403);
    // ID enumeration returns 404 without leakage
    const r = await h.api("/api/receipts/rcpt_doesnotexist", { token: tokens.reviewer }); assert.equal(r.status, 404); assert.ok(r.data.error.correlationId);
    // role revocation revokes sessions
    const u = h.app.auth.listUsers().find((x) => x.email === "support@example.test");
    assert.equal((await h.api("/api/whoami", { token: tokens.support })).status, 200);
    await h.api(`/api/users/${u.id}`, { method: "PATCH", token: admin, body: { roles: ["support"], status: "disabled" } });
    assert.equal((await h.api("/api/whoami", { token: tokens.support })).status, 401);
    await h.api(`/api/users/${u.id}`, { method: "PATCH", token: admin, body: { status: "active" } });
    tokens.support = await h.staffToken("support@example.test");
  });
  it("T-30: signed media links expire and are role-gated; identity numbers are masked everywhere and reveal is audited", async () => {
    const rc = h.db.prepare(`select * from receipts limit 1`).get();
    const detail = await h.api(`/api/receipts/${rc.id}`, { token: tokens.reviewer }); assert.equal(detail.status, 200);
    const url = detail.data.media.original.url;
    assert.equal((await h.api(url, { token: tokens.reviewer, raw: true })).status, 200);
    assert.equal((await h.api(url, { token: tokens.support, raw: true })).status, 403, "support cannot view receipt images");
    assert.equal((await h.api(url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)), { token: tokens.reviewer, raw: true })).status, 403);
    assert.equal((await h.api(url.replace(/exp=\d+/, "exp=1"), { token: tokens.reviewer, raw: true })).status, 403);
    assert.equal((await h.api(url, { raw: true })).status, 401);
    const p = h.db.prepare(`select * from participants limit 1`).get();
    const view = await h.api(`/api/participants/${p.id}`, { token: tokens.support }); assert.equal(view.status, 200);
    assert.match(view.data.participant.identity_masked, /\*/); assert.ok(!JSON.stringify(view.data).includes("TESTSEC1X")); assert.match(view.data.participant.phone, /^\*\*\*\d{4}$/);
    const rev = await h.api(`/api/participants/${p.id}/reveal-identity`, { method: "POST", token: tokens.auditor, body: { reason: "winner verification" } });
    assert.equal(rev.data.identity, "TESTSEC1X");
    assert.ok(h.db.prepare(`select 1 from audit_events where action='participant.identity.reveal' and target_id=?`).get(p.id));
    // exports are formula-safe and audited
    const csv = await (await h.api("/api/reports/export?scope=participants&format=csv", { token: tokens.auditor, raw: true })).text();
    assert.ok(!csv.includes("TESTSEC1X"));
    h.domain.updateParticipant(p.id, { firstName: "=HYPERLINK(x)" }, "adm_test");
    const csv2 = await (await h.api("/api/reports/export?scope=participants&format=csv", { token: tokens.auditor, raw: true })).text();
    assert.ok(csv2.includes("'=HYPERLINK(x)"));
    assert.ok(h.db.prepare(`select 1 from audit_events where action='export'`).get());
  });
  it("audit chain stays intact across all writers and verifies; checkpoints sign the head", async () => {
    const v = await h.api("/api/audit/verify", { token: tokens.auditor }); assert.equal(v.data.ok, true); assert.ok(v.data.total > 20);
    const c = await h.api("/api/audit/checkpoint", { method: "POST", token: tokens.auditor }); assert.equal(c.data.signed, true);
    assert.deepEqual(h.domain.auditService.verifyCheckpoint(c.data), { signatureOk: true, headMatches: true });
  });
  it("T-15: concurrent reviewer decisions — stale version conflicts; only one credit", async () => {
    const ph = "263771000302"; await h.register(ph, { first: "Rev", last: "Two", identity: "TESTREV2X" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "" })));   // missing number -> review
    assert.equal(r.receipt.status, "REVIEW_REQUIRED");
    const before = await h.api(`/api/receipts/${r.receiptId}`, { token: tokens.reviewer });
    const v = before.data.receipt.row_version;
    // reviewer A supplies the identity via a reprocess? No: reviewer cannot credit without identity -> IDENTITY_INCOMPLETE
    const a = await h.api(`/api/receipts/${r.receiptId}/review`, { method: "POST", token: tokens.reviewer, body: { decision: "QUALIFIED", expected_version: v } });
    assert.equal(a.status, 409); assert.equal(a.data.error.code, "IDENTITY_INCOMPLETE");
    const b = await h.api(`/api/receipts/${r.receiptId}/review`, { method: "POST", token: tokens.reviewer, body: { decision: "NOT_QUALIFIED", reason_code: "reviewer_decision", expected_version: v } });
    assert.equal(b.status, 200);
    const c = await h.api(`/api/receipts/${r.receiptId}/review`, { method: "POST", token: tokens.reviewer, body: { decision: "NOT_QUALIFIED", expected_version: v } });
    assert.equal(c.status, 409, "second decision with the stale version conflicts");
    await h.app.worker.tick();
    const msgs = h.db.prepare(`select payload_json from outbound_messages where idempotency_key like ?`).all(`receipt:${r.receiptId}:outcome%`);
    assert.ok(msgs.some((m) => /After review/.test(JSON.parse(m.payload_json).body)), "participant told the review result");
  });
  it("T-31: withdrawal and anonymisation remove personal data but keep ledger references", async () => {
    const p = h.domain.getParticipantByPhone("263771000302");
    const w = await h.api(`/api/participants/${p.id}/withdraw`, { method: "POST", token: tokens.support, body: { reason: "request" } }); assert.equal(w.data.participant.status, "withdrawn");
    const an = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } }); assert.equal(an.data.participant.first_name, "[deleted]");
    const row = h.db.prepare(`select * from participants where id=?`).get(p.id); assert.equal(row.identity_enc, null); assert.equal(row.identity_fp, null);
    assert.ok(h.db.prepare(`select count(*) n from receipts where participant_id=?`).get(p.id).n >= 1, "submissions retained for audit");
  });
  it("T-36: production activation preflight fails precisely on sample configuration and open decisions; non-production is unaffected", async () => {
    const v = await h.api(`/api/campaigns/${h.campaign.id}/activation`, { token: tokens.manager });
    const codes = v.data.failures.map((f) => f.code);
    for (const c of ["DECISION_OPEN_D-01", "SAMPLE_CONFIGURATION", "TRANSPORT", "EXTRACTOR", "OUTLETS_SAMPLE", "STAFF_SAMPLE", "WINNER_TEMPLATE", "BENCHMARK_ACCEPTANCE", "ENVIRONMENT"]) assert.ok(codes.includes(c), `expected ${c}`);
    assert.equal(v.data.ok, false); assert.equal(v.data.blockingCount, 1, "in a test environment only the ENVIRONMENT check blocks");
    h.db.prepare(`update schema_meta set value='production' where key='environment'`).run();
    const s = await h.api(`/api/campaigns/${h.campaign.id}/status`, { method: "POST", token: tokens.manager, body: { status: "paused" } }); assert.equal(s.status, 200);
    const act = await h.api(`/api/campaigns/${h.campaign.id}/status`, { method: "POST", token: tokens.manager, body: { status: "active" } });
    assert.equal(act.status, 409); assert.ok(act.data.error.failures.length > 10);
    h.db.prepare(`update schema_meta set value='test' where key='environment'`).run();
    assert.equal((await h.api(`/api/campaigns/${h.campaign.id}/status`, { method: "POST", token: tokens.manager, body: { status: "active" } })).status, 200);
  });
  it("login rate limiting and temporary-password gate", async () => {
    const ip = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 5; i++) await h.api("/api/login", { method: "POST", headers: ip, body: { email: "nobody@x.test", password: "wrong-wrong-wrong" } });
    const r = await h.api("/api/login", { method: "POST", headers: ip, body: { email: "nobody@x.test", password: "wrong-wrong-wrong" } }); assert.equal(r.status, 429); assert.ok(r.headers.get("retry-after"));
    const created = await h.api("/api/users", { method: "POST", token: admin, body: { email: "new.reviewer@example.test", roles: ["reviewer"] } });
    assert.equal(created.status, 201); assert.ok(created.data.temporaryPassword.length >= 12);
    const t = await h.login("new.reviewer@example.test", created.data.temporaryPassword); assert.ok(t);
    assert.equal((await h.api("/api/receipts", { token: t })).status, 403, "must change temporary password first");
    assert.equal((await h.api("/api/password", { method: "POST", token: t, body: { currentPassword: created.data.temporaryPassword, newPassword: "ANewStrongPassword123" } })).status, 200);
    const t2 = await h.login("new.reviewer@example.test", "ANewStrongPassword123"); assert.equal((await h.api("/api/receipts", { token: t2 })).status, 200);
  });
});
