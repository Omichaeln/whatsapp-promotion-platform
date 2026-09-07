import { describe, it, assert, buildTestApp, seedCampaign, registerParticipant, validReceiptFacts, encodeReceiptFacts } from "./helpers.mjs";
import { sortition, DRAW_ALGORITHM } from "../src/draw.mjs";

function qualify(ctx, campaign, participant, phone, msgId, receiptNo) {
  const version = ctx.domain.getActiveVersion(campaign.id);
  const facts = validReceiptFacts(); facts.receiptNo = receiptNo;
  return ctx.pipeline.process({
    campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
    phoneUid: phone, selectedOutletId: "out_OK-HRE-01", providerMessageId: msgId,
    imageBytes: encodeReceiptFacts(facts), mime: "image/png",
  });
}

describe("draw lifecycle (G-13, REQ-21)", () => {
  it("freezes only eligible entries, executes sortition, requires separate approver, and reconstructs from evidence", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const { participant: p1 } = registerParticipant(ctx, "0771230101");
    const { participant: p2 } = registerParticipant(ctx, "0771230102");
    const r1 = await qualify(ctx, campaign, p1, "0771230101", "wamid_d1", "R-9001");
    const r2 = await qualify(ctx, campaign, p2, "0771230102", "wamid_d2", "R-9002");
    assert.equal(r1.decision, "QUALIFIED");
    assert.equal(r2.decision, "QUALIFIED");

    const entryIds = ctx.db.prepare(`select id, draw_period from entries order by created_at`).all();
    const period = entryIds[0].draw_period;

    // freeze (draw officer)
    const f = ctx.drawService.freeze({ campaignId: campaign.id, drawPeriod: period, configHash: "cfg-test", entryIds: entryIds.map((e) => e.id), operatorId: "officer-1" });
    assert.equal(f.status, "frozen");
    assert.equal(f.snapshot_hash.length, 64);

    // execute requires officer; approve requires a DIFFERENT approver
    const executed = ctx.drawService.execute(f.id, "officer-2");
    assert.equal(executed.status, "executed");
    assert.ok(executed.output_hash, "output hash recorded");
    const approved = ctx.drawService.approve(f.id, "approver-1");
    assert.equal(approved.status, "approved");

    // independent reconstruction from frozen evidence (spec A-10)
    const crypto = await import("node:crypto");
    const candidates = ctx.drawService.candidates(f.id).filter((c) => c.status === "eligible");
    const ordered = sortition(candidates.map((c) => c.entry_id), f.seed_hex);
    // P0-07: recompute the same prize plan — 1 winner (default), rest alternates.
    const winnerCount = 1;
    const winners = ordered.slice(0, winnerCount).map((entryId, i) => ({ position: i + 1, entryId, prize_code: "P1" }));
    const alternates = ordered.slice(winnerCount).map((entryId, i) => ({ position: i + 1, entryId }));
    const recomputed = {
      sequence: ordered, winners, alternates,
      prize_plan: { tiers: [], perTier: [], totalWinners: 1, alternatesPerWinner: 0 },
    };
    const hash = crypto.createHash("sha256").update(JSON.stringify(recomputed)).digest().toString("hex");
    assert.equal(hash, executed.output_hash, "a second operator reproduces the result");

    // approved draw is immutable: approve/publish moves forward; a rerun is a NEW draw
    const published = ctx.drawService.publish(f.id);
    assert.equal(published.status, "published");
    // unique (campaign_id, draw_period) blocks a second draw for the same period
    assert.throws(() => ctx.drawService.freeze({ campaignId: campaign.id, drawPeriod: period, configHash: "x", entryIds: entryIds.map((e) => e.id), operatorId: "officer-1" }));
  });

  it("segregation of duties: the executing officer cannot approve their own draw (P0-07)", async () => {
    const ctx = buildTestApp();
    const { campaign } = seedCampaign(ctx);
    const r1 = await qualify(ctx, campaign, registerParticipant(ctx, "0771230501").participant, "0771230501", "wamid_sd1", "R-9101");
    const r2 = await qualify(ctx, campaign, registerParticipant(ctx, "0771230502").participant, "0771230502", "wamid_sd2", "R-9102");
    assert.equal(r1.decision, "QUALIFIED");
    assert.equal(r2.decision, "QUALIFIED");
    const entries = ctx.db.prepare(`select id, draw_period from entries order by created_at`).all();
    const f = ctx.drawService.freeze({ campaignId: campaign.id, drawPeriod: entries[0].draw_period, configHash: "cfg-sd", entryIds: entries.map((e) => e.id), operatorId: "officer-sd" });
    ctx.drawService.execute(f.id, "officer-sd");
    assert.throws(() => ctx.drawService.approve(f.id, "officer-sd"), /cannot approve their own/);
    // a different named approver succeeds
    const approved = ctx.drawService.approve(f.id, "approver-sd");
    assert.equal(approved.status, "approved");
  });

  it("sortition is deterministic for a given seed and stable across calls", () => {
    const seed = "a".repeat(64);
    const entries = ["e1", "e2", "e3", "e4", "e5"];
    const a = sortition(entries, seed);
    const b = sortition(entries, seed);
    assert.deepEqual(a, b);
    const c = sortition(entries, "b".repeat(64));
    assert.notDeepEqual(a, c, "different seed -> different order (statistically)");
  });
});