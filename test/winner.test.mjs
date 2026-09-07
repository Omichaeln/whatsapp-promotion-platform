import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedCampaign, registerParticipant, validReceiptFacts, encodeReceiptFacts } from "./helpers.mjs";
import { createWinnerService } from "../src/winner-service.mjs";

function qualify(ctx, campaign, participant, phone, msgId, receiptNo) {
  const version = ctx.domain.getActiveVersion(campaign.id);
  const facts = validReceiptFacts(); facts.receiptNo = receiptNo;
  return ctx.pipeline.process({
    campaignId: campaign.id, campaignVersionId: version.id, participantId: participant.id,
    phoneUid: phone, selectedOutletId: "out_OK-HRE-01", providerMessageId: msgId,
    imageBytes: encodeReceiptFacts(facts), mime: "image/png",
  });
}

async function buildPublishedDraw(ctx, drawConfig = {}) {
  const { campaign } = seedCampaign(ctx, drawConfig);
  const p1 = registerParticipant(ctx, "0771230201");
  const p2 = registerParticipant(ctx, "0771230202");
  const p3 = registerParticipant(ctx, "0771230203");
  await qualify(ctx, campaign, p1.participant, "0771230201", "w_win1", "R-W1");
  await qualify(ctx, campaign, p2.participant, "0771230202", "w_win2", "R-W2");
  await qualify(ctx, campaign, p3.participant, "0771230203", "w_win3", "R-W3");
  const entries = ctx.db.prepare(`select id, draw_period from entries order by created_at`).all();
  const period = entries[0].draw_period;
  const f = ctx.drawService.freeze({ campaignId: campaign.id, drawPeriod: period, configHash: "cfg", entryIds: entries.map((e) => e.id), operatorId: "officer" });
  ctx.drawService.execute(f.id, "executor");
  ctx.drawService.approve(f.id, "approver");
  return { campaign, f, entries };
}

describe("winners + claims lifecycle (DEF-03, REQ-20/22)", () => {
  it("publishing a draw materialises winners + claims + queued notifications, idempotently", async () => {
    const ctx = buildTestApp();
    const winners = createWinnerService(ctx.db, { outbox: ctx.outbox });
    const { f } = await buildPublishedDraw(ctx);

    const published = ctx.drawService.publish(f.id);
    assert.equal(published.status, "published");
    const r = winners.materialise(f.id);
    // P0-07: the seed campaign configures ONE weekly prize (default), so exactly
    // one winner is materialised — never one per entry. The rest stay alternates.
    assert.equal(r.created, 1, "exactly the configured prize count, not one per entry");
    assert.equal(r.idempotent, false);
    assert.equal(winners.listByDraw(f.id).length, 1);
    // each winner has a claim row + a queued notification
    for (const w of r.winners) {
      assert.equal(w.status, "pending");
      assert.equal(winners.claims(w.id).length, 1);
    }
    const queued = ctx.db.prepare(`select count(*) n from outbound_messages where payload_json like '%Congratulations%'`).get().n;
    assert.equal(queued, 1, "1 winner notification queued");
    // republish / re-materialise is a no-op (idempotent)
    const again = winners.materialise(f.id);
    assert.equal(again.idempotent, true);
    assert.equal(winners.listByDraw(f.id).length, 1);
  });

  it("claim transition appends history and creates a new claim; replacement promotes the alternate", async () => {
    const ctx = buildTestApp();
    const winners = createWinnerService(ctx.db, { outbox: ctx.outbox });
    // 2 weekly prizes -> 2 winners + 1 alternate (P0-07)
    const { campaign, f } = await buildPublishedDraw(ctx, { prizes: [{ code: "P1", per_week: 2 }] });
    winners.materialise(f.id);
    const [w1, w2] = winners.listByDraw(f.id);
    assert.equal(winners.listByDraw(f.id).length, 2, "two winners for two prizes");

    // notified -> verified -> accepted -> collected
    assert.ok(winners.transition(w1.id, { status: "notified", actorId: "ops" }).winner.status === "notified");
    assert.ok(winners.transition(w1.id, { status: "verified", actorId: "ops" }).winner.status === "verified");
    assert.ok(winners.transition(w1.id, { status: "collected", note: "collected at Westgate", actorId: "ops" }).winner.status === "collected");
    assert.equal(winners.claims(w1.id).length, 4, "awaiting + 3 transitions");

    // replacing w2 promotes the next sequence alternate as pending
    const replaced = winners.transition(w2.id, { status: "replaced", reason: "did not respond", actorId: "ops" });
    assert.equal(replaced.winner.status, "replaced");
    assert.ok(replaced.replacement, "an alternate is promoted");
    assert.equal(replaced.replacement.status, "pending");

    // invalid status rejected
    assert.throws(() => winners.transition(w1.id, { status: "bogus", actorId: "ops" }));
  });

  it("public winners view exposes disclosure fields only (no full phone / identity)", async () => {
    const ctx = buildTestApp();
    const winners = createWinnerService(ctx.db, { outbox: ctx.outbox });
    const { f } = await buildPublishedDraw(ctx);
    ctx.drawService.publish(f.id);
    winners.materialise(f.id);
    winners.listByDraw(f.id).forEach((w, i) => winners.transition(w.id, { status: "collected", actorId: "ops" }));
    const pub = winners.listPublic();
    assert.equal(pub.length, 1);
    for (const p of pub) {
      assert.ok(p.draw_period);
      assert.equal(typeof p.rank, "number");
      assert.ok(!p.id || !/^\d{9}$/.test(p.id || ""), "no raw phone in public view");
      assert.ok(p.winner === undefined || /^\*{3}\d{4}$/.test(p.winner), "phone is masked");
    }
  });
});