import { describe, it, assert, buildTestApp, seedCampaign, validReceiptFacts, registerParticipant, encodeReceiptFacts } from "./helpers.mjs";

describe("eligibility rules (deterministic)", () => {
  it("qualifies 2x2kg qualifying product with confidence", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant } = registerParticipant(ctx, "0771230001");
    const version = ctx.domain.getActiveVersion(campaign.id);
    const media = await ctx.mediaStore.store({ bytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png", campaignId: campaign.id });
    const result = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230001", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_1001",
      imageBytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png",
    });
    assert.equal(result.decision, "QUALIFIED");
    const entry = ctx.db.prepare(`select * from entries where receipt_id=?`).get(result.receiptId);
    assert.ok(entry, "entry created");
  });

  it("rejects a receipt with only one 2kg pack", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant } = registerParticipant(ctx, "0771230002");
    const version = ctx.domain.getActiveVersion(campaign.id);
    const facts = validReceiptFacts();
    facts.lineItems = [{ description: "ZimSweet Brown Sugar 2kg", quantity: 1, amount: 5 }];
    const result = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230002", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_1002",
      imageBytes: encodeReceiptFacts(facts), mime: "image/png",
    });
    assert.equal(result.decision, "NOT_QUALIFIED");
    assert.equal(ctx.db.prepare(`select count(*) n from entries`).get().n, 0);
  });

  it("routes unclear receipts to NEEDS_REVIEW, never auto-qualifies", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant } = registerParticipant(ctx, "0771230003");
    const version = ctx.domain.getActiveVersion(campaign.id);
    const r = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230003", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_1003",
      imageBytes: encodeReceiptFacts({ ...validReceiptFacts(), _confidence: 0.2 }), mime: "image/png",
    });
    assert.equal(r.decision, "NEEDS_REVIEW");
    const task = ctx.db.prepare(`select * from review_tasks where receipt_id=?`).get(r.receiptId);
    assert.ok(task, "review task created");
  });
});

describe("duplicate prevention (G-09, spec 14)", () => {
  it("exact same provider message returns same outcome, no second entry", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant } = registerParticipant(ctx, "0771230010");
    const version = ctx.domain.getActiveVersion(campaign.id);
    const args = {
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230010", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_dup_1",
      imageBytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png",
    };
    const r1 = await ctx.pipeline.process(args);
    assert.equal(r1.decision, "QUALIFIED");
    // replay of the SAME webhook (same provider message id)
    const r2 = await ctx.pipeline.process(args);
    assert.equal(r2.kind, "idempotent_replay");
    assert.equal(ctx.db.prepare(`select count(*) n from entries where receipt_id=?`).get(r1.receiptId).n, 1, "exactly one entry");
    assert.equal(ctx.db.prepare(`select count(*) n from entries`).get().n, 1);
  });

  it("exact same image (SHA-256) is a duplicate for a different participant", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const version = ctx.domain.getActiveVersion(campaign.id);
    const bytes = encodeReceiptFacts(validReceiptFacts());
    const { participant: p1 } = registerParticipant(ctx, "0771230011");
    const r1 = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: p1.id,
      phoneUid: "0771230011", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_dup_2a",
      imageBytes: bytes, mime: "image/png",
    });
    assert.equal(r1.decision, "QUALIFIED");
    const { participant: p2 } = registerParticipant(ctx, "0771230012");
    const r2 = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: p2.id,
      phoneUid: "0771230012", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_dup_2b",
      imageBytes: bytes, mime: "image/png",
    });
    assert.equal(r2.receipt.status, "DUPLICATE");
    assert.equal(ctx.db.prepare(`select count(*) n from entries`).get().n, 1);
  });

  it("two distinct unique receipts from the same participant create two entries (REQ-14)", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const version = ctx.domain.getActiveVersion(campaign.id);
    const { participant } = registerParticipant(ctx, "0771230020");
    const r1 = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230020", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_3a",
      imageBytes: encodeReceiptFacts(validReceiptFacts()), mime: "image/png",
    });
    const f2 = validReceiptFacts(); f2.receiptNo = "R-2002";
    const r2 = await ctx.pipeline.process({
      campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
      phoneUid: "0771230020", selectedOutletId: "out_OK-HRE-01", providerMessageId: "wamid_3b",
      imageBytes: encodeReceiptFacts(f2), mime: "image/png",
    });
    assert.equal(r1.decision, "QUALIFIED");
    assert.equal(r2.decision, "QUALIFIED");
    assert.equal(ctx.db.prepare(`select count(*) n from entries where participant_id=?`).get(participant.id).n, 2);
  });
});