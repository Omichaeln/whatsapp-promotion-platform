// Regression cases for the draw/winner audit package (drawwin).
// Each case reproduces a defect that was confirmed against this tree:
//   draw-6  a campaign with no prize plan draws nobody and still "verifies"
//   draw-5  the user who froze the pool could also approve the draw
//   draw-4  one actor could void an EXECUTED draw and re-roll, undisclosed
//   draw-3  a bundle's audit events were unkeyed, so attribution was editable
//   draw-8  a frozen (pre-commitment) bundle always failed verification
//   draw-9  a partial period prize_config discarded every override
//   draw-7  scripts/reconstruct-draw.mjs failed on every valid draw
//   crosscut-4/6  silent candidate drops and an unlabelled rules version
//   winners-1/3/4/7 and crm-6  claim clock, disqualified entries, erasure,
//   campaign collection flag, and the missing CRM event for a promotion.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, before, after, assert, buildApp, ROOT } from "./helpers.mjs";
import { planFrom } from "../src/draw.mjs";
import { canonicalJson, sha256 } from "../src/audit.mjs";

const KEY = "test-checkpoint-key";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drawwin-"));
function verify(bundle) {
  const file = path.join(tmp, `b_${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle));
  try { return { code: 0, out: JSON.parse(execFileSync("node", ["--no-warnings", path.join(ROOT, "scripts", "verify-draw-bundle.mjs"), file, "--checkpoint-key", KEY], { encoding: "utf8" })) }; }
  catch (e) { return { code: e.status, out: JSON.parse(e.stdout) }; }
}
const failed = (r) => r.out.checks.filter((c) => !c.pass).map((c) => c.name);

describe("drawwin audit fixes", () => {
  let h, g, officer, approver, ops, auditor, period, w2period, parts = [];
  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    officer = h.app.auth.listUsers().find((u) => u.email === "draw@example.test");
    approver = h.app.auth.listUsers().find((u) => u.email === "approver@example.test");
    ops = h.app.auth.listUsers().find((u) => u.email === "fulfilment@example.test");
    auditor = h.app.auth.listUsers().find((u) => u.email === "auditor@example.test");
    period = h.domain.listPeriods(h.campaign.id).find((p) => p.code === "W-1");
    // A small, explicit prize plan: 3 winners (1 x P1, 2 x P2) + 3 alternates.
    h.db.prepare(`update campaigns set draw_config_json=? where id=?`)
      .run(JSON.stringify({ prizes: [{ code: "P1", label: "Test prize one", count: 1 }, { code: "P2", label: "Test prize two", count: 2 }], alternates_per_winner: 1, one_prize_per_participant: true, winner_exclusion: "none" }), h.campaign.id);
    for (let i = 1; i <= 8; i++) {
      const ph = `26377150000${i}`;
      await h.register(ph, { first: `Fix${"ABCDEFGH"[i - 1]}`, last: "Case", identity: `TESTFX${i}ZZ` });
      const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: `FX-${i}` })));
      assert.equal(r.receipt.status, "QUALIFIED");
      parts.push(h.db.prepare(`select * from participants where wa_phone_uid=?`).get(ph));
    }
    const at = new Date(Date.parse(period.starts_at) + 3600_000).toISOString();
    h.db.prepare(`update entries set period_code='W-1', draw_period='W-1', created_at=? where campaign_id=?`).run(at, h.campaign.id);
    h.db.prepare(`update receipts set period_code='W-1', intake_at=? where campaign_id=?`).run(at, h.campaign.id);

    // Second app for the W-2 cases so they cannot disturb the W-1 fixture.
    g = await buildApp({ extractor: "simulator" });
    w2period = g.domain.listPeriods(g.campaign.id).find((p) => p.code === "W-2");
    for (let i = 1; i <= 3; i++) {
      const ph = `26377160000${i}`;
      await g.register(ph, { first: `Two${"ABC"[i - 1]}`, last: "Case", identity: `TESTW2${i}ZZ` });
      await g.submit(ph, await g.simImage(g.simReceipt({ no: `W2-${i}` })));
    }
    const at2 = new Date(Date.parse(w2period.starts_at) + 3600_000).toISOString();
    g.db.prepare(`update entries set period_code='W-2', draw_period='W-2', created_at=? where campaign_id=?`).run(at2, g.campaign.id);
    g.db.prepare(`update receipts set period_code='W-2', intake_at=? where campaign_id=?`).run(at2, g.campaign.id);
  });
  after(async () => { await h?.close(); await g?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("draw-9: a period config that overrides only some fields keeps the campaign's prize tiers", () => {
    const campaign = { prizes: [{ code: "P1", count: 2 }], alternates_per_winner: 1, total_alternates: 2, one_prize_per_participant: true };
    const plan = planFrom({ alternates_per_winner: 3, one_prize_per_participant: false }, campaign);
    assert.equal(plan.totalWinners, 2, "tiers still inherited from the campaign");
    assert.equal(plan.alternatesPerWinner, 3, "the period override must not be discarded");
    assert.equal(plan.totalAlternates, 6, "derived from the overriding alternates_per_winner");
    assert.equal(plan.onePrizePerParticipant, false, "the period override must not be discarded");
    // a period that sets its own tiers still overrides them
    assert.equal(planFrom({ prizes: [{ code: "X", count: 4 }] }, campaign).totalWinners, 4);
  });

  it("draw-6: a campaign with no prize plan is blocked, and a zero-winner bundle does not verify", () => {
    g.db.prepare(`update campaigns set draw_config_json='{}' where id=?`).run(g.campaign.id);
    g.db.prepare(`update campaign_periods set prize_config_json='{}' where id=?`).run(w2period.id);
    const b = g.app.drawService.barrier(g.campaign.id, w2period.id);
    assert.equal(b.plan.totalWinners, 0);
    assert.ok(b.eligible.length > 0, "there are candidates; only the prize plan is missing");
    assert.ok(b.blockers.some((x) => x.code === "NO_PRIZE_PLAN"), `expected NO_PRIZE_PLAN, got ${JSON.stringify(b.blockers)}`);
    assert.equal(b.ok, false);
    assert.throws(() => g.app.drawService.freeze({ campaignId: g.campaign.id, periodId: w2period.id, actorId: officer.id }), /NO_PRIZE_PLAN/);

    // Forced through anyway: the exported bundle must not report "verified".
    const d = g.app.drawService.freeze({ campaignId: g.campaign.id, periodId: w2period.id, actorId: officer.id, override: { allow: ["NO_PRIZE_PLAN"], reason: "audit case" } });
    g.app.drawService.execute(d.id, officer.id);
    g.app.drawService.approve(d.id, approver.id);
    assert.equal(JSON.parse(g.app.drawService.get(d.id).output_json).winners.length, 0, "nobody was awarded");
    const r = verify(g.app.drawService.bundle(d.id, auditor.id));
    assert.equal(r.code, 1, "a draw that awarded nobody must not verify");
    assert.ok(failed(r).some((n) => /winner count/.test(n)), `expected the winner-count check to fail, failed: ${failed(r)}`);
    // a workable plan for the next W-2 case (3 candidates in that app)
    g.db.prepare(`update campaigns set draw_config_json=? where id=?`).run(JSON.stringify({ prizes: [{ code: "P1", label: "Test prize", count: 1 }], alternates_per_winner: 1 }), g.campaign.id);
    g.app.drawService.voidDraw(d.id, officer.id, "audit case complete", approver.id);
  });

  it("draw-5: the user who froze the candidate pool cannot approve (or reject) the draw", () => {
    // The approver freezes the pool (choosing the candidates and any override);
    // the officer executes, which is fully deterministic. Approval by the
    // freezer is not a second pair of eyes.
    const d = g.app.drawService.freeze({ campaignId: g.campaign.id, periodId: w2period.id, actorId: approver.id });
    g.app.drawService.execute(d.id, officer.id);
    assert.throws(() => g.app.drawService.approve(d.id, approver.id), /froze the candidate pool/);
    assert.throws(() => g.app.drawService.reject(d.id, approver.id, "no"), /froze the candidate pool/);
    assert.equal(g.app.drawService.get(d.id).status, "executed", "still awaiting a genuine second approver");
    const bundle = g.app.drawService.bundle(d.id, auditor.id);
    assert.equal(bundle.draw.frozen_by, approver.id, "the bundle must name who froze the pool");
  });

  it("crosscut-4/6: withdrawn and erased participants are recorded as exclusions, and the rules versions are disclosed", () => {
    h.domain.withdrawParticipant(parts[6].wa_phone_uid, ops.id, "audit case");   // participant 7
    h.domain.anonymiseParticipant(parts[7].id, ops.id, "erasure request");       // participant 8
    const b = h.app.drawService.barrier(h.campaign.id, period.id);
    // freeze first so the later cases have their draw whatever this one asserts
    const d = h.app.drawService.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: officer.id });
    assert.equal(h.db.prepare(`select count(*) n from entries where campaign_id=? and period_code='W-1' and status='active'`).get(h.campaign.id).n, 8);
    assert.equal(b.eligible.length, 6);
    const reasons = b.exclusions.map((x) => x.reason).sort();
    assert.deepEqual(reasons, ["participant_deleted", "participant_withdrawn"], `every dropped entry must carry a reason, got ${JSON.stringify(b.exclusions)}`);
    assert.ok(b.ok, `barrier should be clear: ${JSON.stringify(b.blockers)}`);
    const snap = JSON.parse(d.snapshot_json);
    assert.equal(snap.exclusions.length, 2, "the snapshot must account for the missing entries");
    assert.equal(h.db.prepare(`select count(*) n from draw_candidates where draw_id=? and status='excluded'`).get(d.id).n, 2);
    // the rules versions the candidates were judged under are stated separately
    assert.ok(Array.isArray(snap.candidateRulesVersions), "the snapshot must disclose the candidates' rules versions");
    assert.equal(snap.candidateRulesVersions.reduce((a, v) => a + v.entries, 0), snap.candidates.length);
    assert.equal(snap.activeVersionAtFreeze, d.config_hash);
  });

  it("draw-8: a frozen bundle (the pre-commitment evidence) verifies", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "frozen");
    const bundle = h.app.drawService.bundle(d.id, auditor.id);
    assert.equal(bundle.seed_hex, null); assert.equal(bundle.output, null);
    const r = verify(bundle);
    assert.equal(r.code, 0, `a frozen bundle must verify; failed: ${failed(r)}`);
    assert.equal(r.out.verified, true);
  });

  it("draw-4: one actor cannot void an executed draw and re-roll; the replacement discloses its predecessor", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "frozen");
    h.app.drawService.execute(d.id, officer.id);
    // The officer has now READ the winners. Record what each single-actor
    // re-roll attempt is allowed to do, then drive the period to an approved
    // replacement either way, so the assertions below are about THIS defect.
    const code = (fn) => { try { fn(); return "allowed"; } catch (e) { return e.code || e.message; } };
    const attempts = {
      void: code(() => h.app.drawService.voidDraw(d.id, officer.id, "re-roll")),
      selfApproved: code(() => h.app.drawService.voidDraw(d.id, officer.id, "re-roll", officer.id)),
      rerun: code(() => h.app.drawService.rerun(d.id, officer.id, "re-roll")),
    };
    const stillStanding = h.app.drawService.get(d.id).status;
    let cur = h.app.drawService.list(h.campaign.id).find((x) => x.status !== "voided");
    if (!cur || cur.id === d.id) cur = h.app.drawService.rerun(d.id, officer.id, "genuine dispute", approver.id);
    cur = h.app.drawService.get(cur.id);
    if (["frozen", "executing"].includes(cur.status)) cur = h.app.drawService.execute(cur.id, officer.id);
    if (cur.status === "executed") cur = h.app.drawService.approve(cur.id, approver.id, { expectedOutputHash: cur.output_hash });

    assert.deepEqual(attempts, { void: "SOD", selfApproved: "SOD", rerun: "SOD" }, "one actor must not be able to discard a result he has already seen");
    assert.equal(stillStanding, "executed", "the result the officer already read is still standing");
    assert.equal(h.app.drawService.get(d.id).status, "voided");
    assert.equal(cur.supersedes, d.id, "a replacement must name what it replaces");
    assert.equal(cur.status, "approved");
    const bundle = h.app.drawService.bundle(cur.id, auditor.id);
    assert.match(bundle.draw.draw_label, /#\d$/);
    assert.ok((bundle.period_draws || []).some((x) => x.id === d.id && x.status === "voided" && x.output_hash), "the discarded execution must be disclosed");
    const r = verify(bundle);
    assert.equal(r.code, 0, `the honest replacement must verify; failed: ${failed(r)}`);
  });

  it("draw-3: editing an exported audit event's attribution no longer verifies", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "approved");
    const bundle = h.app.drawService.bundle(d.id, auditor.id);
    assert.equal(verify(bundle).code, 0, "the honest bundle verifies");
    // The officer executed and (in the audited scenario) self-approved; he now
    // rewrites the file to name a colleague as the operator, in the mutable
    // column AND inside the signed body, and recomputes the unkeyed entry hash.
    const forged = JSON.parse(JSON.stringify(bundle));
    forged.draw.operator_id = ops.id;
    for (const e of forged.audit_events) {
      if (e.action !== "draw.executed") continue;
      const body = JSON.parse(e.payload_json);
      body.actorId = ops.id; e.actor_id = ops.id;
      e.payload_json = canonicalJson(body);
      e.entry_hash = sha256((e.prev_hash || "") + e.payload_json);
    }
    const r = verify(forged);
    assert.equal(r.code, 1, "a bundle whose events were rewritten must fail");
    assert.ok(failed(r).some((n) => /anchored/.test(n)), `expected the keyed anchor to catch it, failed: ${failed(r)}`);
    // stripping the anchor instead must not be a way out
    const stripped = JSON.parse(JSON.stringify(bundle)); stripped.audit_anchor = null;
    assert.equal(verify(stripped).code, 1, "an unanchored bundle must not pass with a key supplied");
  });

  it("draw-7: reconstruct-draw recomputes a genuine draw from its snapshot", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "approved");
    let out, code = 0;
    try { out = execFileSync("node", ["--no-warnings", path.join(ROOT, "scripts", "reconstruct-draw.mjs"), d.id], { encoding: "utf8", env: { ...process.env, ENVIRONMENT: "test", DATABASE: h.cfg.database, IDENTITY_KEY: "test-identity-key-0123456789" } }); }
    catch (e) { code = e.status; out = e.stdout; }
    assert.equal(code, 0, `reconstruction of a sound draw must succeed: ${out}`);
    const j = JSON.parse(out);
    assert.equal(j.reconstructs, true);
    assert.deepEqual(j.recomputed_winners, j.stored_winners);
    assert.equal(j.recomputed_output_hash, j.stored_output_hash);
  });

  it("winners-7: collection is refused at an outlet this campaign excludes", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "approved");
    h.app.drawService.publish(d.id, ops.id);
    assert.equal(h.app.winners.materialise(d.id, ops.id).created, 3);
    const [w1] = h.app.winners.listByDraw(d.id);
    const collect = h.domain.listCampaignOutlets(h.campaign.id).find((o) => o.collection_enabled && o.campaign_collection_enabled);
    h.app.winners.notify(w1.id, ops.id);
    h.app.winners.transition(w1.id, { status: "verified", actorId: ops.id });
    h.app.winners.transition(w1.id, { status: "accepted", actorId: ops.id });
    // the campaign excludes this branch from collection while the master flag stays on
    h.db.prepare(`update campaign_outlets set collection_enabled=0 where campaign_id=? and outlet_id=?`).run(h.campaign.id, collect.id);
    assert.throws(() => h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id, collectionOutletId: collect.id, fulfilmentRef: "SLIP-X" }), /collection point for this campaign/);
    assert.equal(h.app.winners.get(w1.id).status, "accepted");
    h.db.prepare(`update campaign_outlets set collection_enabled=1 where campaign_id=? and outlet_id=?`).run(h.campaign.id, collect.id);
    assert.equal(h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id, collectionOutletId: collect.id, fulfilmentRef: "SLIP-X" }).winner.status, "collected");
  });

  it("winners-4: withdrawal reaches the public winner list, and an erased participant cannot be published", async () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "published");
    const [w1, w2] = h.app.winners.listByDraw(d.id);
    h.app.winners.publish(w1.id, ops.id);
    const before = (await h.api("/api/winners/public?period=W-1")).data.winners;
    assert.equal(before.length, 1); assert.match(before[0].name, /^Fix[A-H] C\.$/);
    // display_name is a copy frozen at materialise; withdrawal never visits it.
    h.domain.withdrawParticipant(h.domain.getParticipant(h.app.winners.get(w1.id).participant_id).wa_phone_uid, ops.id, "participant request");
    const after = (await h.api("/api/winners/public?period=W-1")).data.winners;
    assert.equal(after.length, 1, "the compliance record stays, the identity does not");
    assert.equal(after[0].name, "[removed]", "a withdrawn participant's name must not stay published");
    assert.equal(after[0].location, null);
    // and a winner whose participant has been erased cannot be published at all
    h.app.winners.notify(w2.id, ops.id);
    h.app.winners.transition(w2.id, { status: "verified", actorId: ops.id });
    h.domain.anonymiseParticipant(h.app.winners.get(w2.id).participant_id, ops.id, "erasure request");
    assert.throws(() => h.app.winners.publish(w2.id, ops.id), /participant is deleted/);
  });

  it("winners-1: a winner whose notification never left is not auto-expired", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "published");
    const w3 = h.app.winners.listByDraw(d.id)[2];
    h.app.winners.notify(w3.id, ops.id);
    h.db.prepare(`update outbound_messages set status='permanent_failure', error_code='131047', last_error='template paused' where idempotency_key=?`).run(`winner:${w3.id}:notify:1`);
    h.db.prepare(`update winners set claim_expires_at='2000-01-01T00:00:00.000Z' where id=?`).run(w3.id);
    const r = h.app.winners.expireDue();
    assert.equal(r.expired, 0, "a winner who was never reached must not lose the prize on the clock alone");
    assert.equal(r.notContacted, 1);
    assert.equal(h.app.winners.get(w3.id).status, "notified");
    assert.ok(h.db.prepare(`select count(*) n from alerts where kind='winners.not_contacted'`).get().n > 0, "ops must be told to re-notify");
    // a delivered notification still expires on the deadline
    h.db.prepare(`update outbound_messages set status='sent' where idempotency_key=?`).run(`winner:${w3.id}:notify:1`);
    assert.equal(h.app.winners.expireDue().expired, 1);
    assert.equal(h.app.winners.get(w3.id).status, "expired");
  });

  it("winners-3/crm-6: a disqualified entry cannot advance or be promoted, and a promotion reaches the CRM", () => {
    const d = h.app.drawService.list(h.campaign.id).find((x) => x.status === "published");
    const w3 = h.app.winners.listByDraw(d.id)[2];
    const out = JSON.parse(h.app.drawService.get(d.id).output_json);
    // rank 3's receipt turns out to be a forgery, after publication
    const dq = h.app.pipeline.disqualifyEntry(w3.entry_id, { actorId: officer.id, reason: "forged receipt", approvedBy: approver.id });
    assert.ok(dq.affectedDraws.length >= 1);
    h.db.prepare(`update winners set status='notified' where id=?`).run(w3.id);   // as if ops had re-notified before the disqualification
    assert.throws(() => h.app.winners.transition(w3.id, { status: "verified", actorId: ops.id }), /entry is excluded/);
    assert.throws(() => h.app.winners.publish(w3.id, ops.id), /verified before publication|entry is excluded/);
    // the first stored alternate is disqualified too: it must be skipped, not promoted
    h.app.pipeline.disqualifyEntry(out.alternates[0].entryId, { actorId: officer.id, reason: "forged receipt", approvedBy: approver.id });
    const crmBefore = h.db.prepare(`select count(*) n from crm_events where entity_type='winner'`).get().n;
    const rep = h.app.winners.transition(w3.id, { status: "replaced", actorId: ops.id, reason: "disqualified" });
    assert.ok(rep.replacement, "an eligible alternate remained");
    assert.notEqual(rep.replacement.entry_id, out.alternates[0].entryId, "a disqualified alternate must never be promoted");
    assert.equal(rep.replacement.entry_id, out.alternates[1].entryId);
    assert.equal(h.db.prepare(`select count(*) n from audit_events where action='winner.alternate_skipped'`).get().n, 1);
    // the replacement winner exists in the CRM as a selection, not only later as a status change
    const ev = h.db.prepare(`select * from crm_events where entity_type='winner' and entity_id=?`).get(rep.replacement.id);
    assert.ok(ev, "promoting an alternate must emit the winner selection the CRM expects");
    assert.equal(ev.entity_version, 1);
    assert.match(ev.payload_json, /"status":"selected"/);
    assert.equal(h.db.prepare(`select count(*) n from crm_events where entity_type='winner'`).get().n, crmBefore + 2);
  });
});
