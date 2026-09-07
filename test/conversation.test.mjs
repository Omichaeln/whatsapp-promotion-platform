import { describe, it, assert, buildTestApp, seedCampaign, registerParticipant, validReceiptFacts, encodeReceiptFacts } from "./helpers.mjs";

describe("conversation state machine (spec 6, G-03)", () => {
  it("walks a new participant through register -> outlet -> receipt -> qualified entry", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const phone = "0771230450";

    const s1 = await ctx.conversation.handle({ providerMessageId: "c1", phoneUid: phone, type: "message.text", text: "2" });
    assert.equal(s1.state, "REGISTER_NAME");
    assert.equal(s1.replies.length, 1);

    const s2 = await ctx.conversation.handle({ providerMessageId: "c2", phoneUid: phone, type: "message.text", text: "Tapiwa Moyo" });
    assert.equal(s2.state, "REGISTER_IDENTITY");

    const s3 = await ctx.conversation.handle({ providerMessageId: "c3", phoneUid: phone, type: "message.text", text: "63-1234567F12" });
    assert.equal(s3.state, "REGISTER_LOCATION");

    const s4 = await ctx.conversation.handle({ providerMessageId: "c4", phoneUid: phone, type: "message.text", text: "Harare" });
    assert.equal(s4.state, "REGISTER_CONSENT");

    const s5 = await ctx.conversation.handle({ providerMessageId: "c5", phoneUid: phone, type: "message.text", text: "yes" });
    assert.equal(s5.state, "ENTRY_OUTLET");

    const s6 = await ctx.conversation.handle({ providerMessageId: "c6", phoneUid: phone, type: "message.text", text: "OK-HRE-01" });
    assert.equal(s6.state, "ENTRY_RECEIPT");

    const s7 = await ctx.conversation.handle({ providerMessageId: "c7", phoneUid: phone, type: "message.image", text: "", mediaBytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png" });
    assert.equal(s7.state, "QUALIFIED");
    assert.match(s7.replies[0], /Entry confirmed/);

    // idempotent replay of the same webhook: no second reply, no second entry
    const s8 = await ctx.conversation.handle({ providerMessageId: "c7", phoneUid: phone, type: "message.image", text: "", mediaBytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png" });
    assert.equal(s8.alreadySeen, true);
    assert.equal(ctx.db.prepare(`select count(*) n from entries`).get().n, 1);
  });

  it("returning participant goes straight to ENTER and a random image cannot qualify", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant } = registerParticipant(ctx, "0771230460");
    const phone = "0771230460";

    // returning: HOME + ENTER -> outlet
    const s1 = await ctx.conversation.handle({ providerMessageId: "r1", phoneUid: phone, type: "message.text", text: "3" });
    assert.equal(s1.state, "ENTRY_OUTLET");
    const s2 = await ctx.conversation.handle({ providerMessageId: "r2", phoneUid: phone, type: "message.text", text: "TM-HRE-01" });
    assert.equal(s2.state, "ENTRY_RECEIPT");

    // random non-receipt image (no embedded facts) -> NEEDS_REVIEW, never qualified
    const s3 = await ctx.conversation.handle({ providerMessageId: "r3", phoneUid: phone, type: "message.image", text: "", mediaBytes: Buffer.from("not a receipt at all"), mime: "image/jpeg" });
    assert.equal(s3.state, "NEEDS_REVIEW");
    assert.equal(ctx.db.prepare(`select count(*) n from entries`).get().n, 0);
  });
});

describe("admin auth + RBAC (G-12)", () => {
  it("scrypt login issues a hashed bearer token; guarded endpoints enforce roles", async () => {
    const ctx = buildTestApp();
    const { createAuth } = await import("../src/auth.mjs");
    const auth = createAuth(ctx.db, { bootstrap: { email: "admin@test.com", password: "SuperSecret123" } });

    const bad = auth.login({ email: "admin@test.com", password: "wrong" });
    assert.equal(bad, null);

    const ok = auth.login({ email: "admin@test.com", password: "SuperSecret123" });
    assert.ok(ok.token, "token issued");
    assert.equal(ok.user.roles.includes("platform_admin"), true);

    const principal = auth.authenticate(ok.token);
    assert.equal(principal.user.email, "admin@test.com");
    assert.equal(auth.hasRole(principal.user, "campaign_manager"), true, "platform_admin implies all");

    const reviewer = auth.createUser({ email: "rv@test.com", name: "Reviewer", password: "p@ssw0rd123", roles: ["reviewer"] });
    assert.equal(auth.hasRole(reviewer, "reviewer"), true);
    assert.equal(auth.hasRole(reviewer, "draw_approver"), false);
  });
});