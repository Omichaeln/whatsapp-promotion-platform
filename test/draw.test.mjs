// Draw + winner lifecycle (T-19, T-20, T-21, T-22, T-23, T-24, T-25) using the
// labelled simulated extractor for speed; the draw layer is identical for OCR.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, before, after, assert, buildApp, ROOT } from "./helpers.mjs";
import { sortition, selectWinners, planFrom } from "../src/draw.mjs";

describe("draws, winners and publication", () => {
  let h, officer, approver, ops, auditor, period;
  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    officer = h.app.auth.listUsers().find((u) => u.email === "draw@example.test"); approver = h.app.auth.listUsers().find((u) => u.email === "approver@example.test"); ops = h.app.auth.listUsers().find((u) => u.email === "fulfilment@example.test"); auditor = h.app.auth.listUsers().find((u) => u.email === "auditor@example.test");
    period = h.domain.listPeriods(h.campaign.id).find((p) => p.code === "W-1");
    // 6 participants, 8 qualifying receipts (one participant has 3) backdated into W-1
    for (let i = 1; i <= 6; i++) { const ph = `26377100010${i}`; await h.register(ph, { first: `Part${"ABCDEF"[i - 1]}`, last: "Test", identity: `TEST00${i}ZZ` }); const n = i === 1 ? 3 : 1; for (let k = 0; k < n; k++) { const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: `W1-${i}-${k}` }))); assert.equal(r.receipt.status, "QUALIFIED"); } }
    const at = new Date(Date.parse(period.starts_at) + 3600_000).toISOString();
    h.db.prepare(`update entries set period_code='W-1', draw_period='W-1', created_at=? where campaign_id=?`).run(at, h.campaign.id);
    h.db.prepare(`update receipts set period_code='W-1', intake_at=? where campaign_id=?`).run(at, h.campaign.id);
  });
  after(async () => { await h.close(); });

  it("pure selection: equal chance per entry, one prize per participant, deterministic for a seed, unbiased ordering", () => {
    const cands = Array.from({ length: 50 }, (_, i) => ({ entryId: `e${i}`, participantId: `p${i % 20}`, weightUnits: 1 }));
    const seed = "ab".repeat(32);
    const a = sortition(cands, seed), b = sortition(cands, seed); assert.deepEqual(a.map((x) => x.entryId), b.map((x) => x.entryId));
    assert.notDeepEqual(a.map((x) => x.entryId).slice(0, 5), sortition(cands, "cd".repeat(32)).map((x) => x.entryId).slice(0, 5));
    const plan = planFrom({}, { prizes: [{ code: "P1", count: 5 }], alternates_per_winner: 2, one_prize_per_participant: true });
    const sel = selectWinners(a, plan);
    assert.equal(sel.winners.length, 5); assert.equal(new Set(sel.winners.map((w) => w.participantId)).size, 5); assert.equal(sel.alternates.length, 10);
    // a participant with 3 entries has 3 chances: appears 3 times in the ordering
    assert.equal(sortition([{ entryId: "x", participantId: "p", weightUnits: 3 }], seed).length, 3);
  });
  it("T-19: freeze is blocked while the period is open or on-time submissions are unresolved; boundary is half-open", async () => {
    const open = h.domain.listPeriods(h.campaign.id).find((p) => p.code === "W0");
    const b = h.app.drawService.barrier(h.campaign.id, open.id); assert.ok(b.blockers.some((x) => x.code === "PERIOD_OPEN"));
    // an on-time W-1 submission under review blocks; resolving it unblocks
    const ph = "263771000199"; await h.register(ph, { first: "Late", last: "Review", identity: "TEST199ZZ" });
    const r = await h.submit(ph, await h.simImage(h.simReceipt({ no: "", packs: 2 })));
    assert.equal(r.receipt.status, "REVIEW_REQUIRED");
    h.db.prepare(`update receipts set period_code='W-1', intake_at=? where id=?`).run(new Date(Date.parse(period.ends_at) - 1000).toISOString(), r.receiptId);
    assert.ok(h.app.drawService.barrier(h.campaign.id, period.id).blockers.some((x) => x.code === "UNRESOLVED_SUBMISSIONS"));
    assert.throws(() => h.app.drawService.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: officer.id }), /UNRESOLVED_SUBMISSIONS/);
    // exactly at cutoff => next period (half-open)
    h.db.prepare(`update receipts set intake_at=? where id=?`).run(period.ends_at, r.receiptId);
    assert.equal(h.domain.periodAt(h.campaign.id, period.ends_at).code, "W0");
    h.db.prepare(`update receipts set period_code='W0' where id=?`).run(r.receiptId);
    assert.ok(h.app.drawService.barrier(h.campaign.id, period.id).ok);
  });
  it("T-20/T-21: freeze commits randomness before execution; execute is crash-safe and idempotent; approver must differ; approval verifies the hash", async () => {
    const d = h.app.drawService.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: officer.id });
    assert.equal(d.status, "frozen"); assert.ok(d.seed_hex.length >= 64); assert.equal(d.output_json, null);
    assert.equal(JSON.parse(d.snapshot_json).candidates.length, 8);
    // simulate a crash: reservation held (executing) but no output stored, then a retry by another officer
    h.db.prepare(`update draws set status='executing', execution_attempts=1 where id=?`).run(d.id);
    const e1 = h.app.drawService.execute(d.id, officer.id); assert.equal(e1.status, "executed"); const hash1 = e1.output_hash;
    const e2 = h.app.drawService.execute(d.id, officer.id); assert.equal(e2.output_hash, hash1, "retry resumes the same result");
    const out = JSON.parse(e1.output_json); assert.equal(out.winners.length, 5); assert.equal(new Set(out.winners.map((w) => w.participantId)).size, 5);
    assert.throws(() => h.app.drawService.approve(d.id, officer.id), /cannot approve/);
    assert.throws(() => h.app.drawService.approve(d.id, approver.id, { expectedOutputHash: "deadbeef" }), /changed since/);
    const a = h.app.drawService.approve(d.id, approver.id, { expectedOutputHash: hash1 }); assert.equal(a.status, "approved");
    assert.equal(h.app.drawService.approve(d.id, approver.id).status, "approved", "approval replay is idempotent");
    // approved output cannot be edited through the service; direct tampering is detected
    h.db.prepare(`update draws set output_json=replace(output_json, ?, 'e_tampered') where id=?`).run(out.winners[0].entryId, d.id);
    assert.equal(h.app.drawService.verifyStored(h.app.drawService.get(d.id)).ok, false);
    h.db.prepare(`update draws set output_json=? where id=?`).run(e1.output_json, d.id);
    assert.equal(h.app.drawService.verifyStored(h.app.drawService.get(d.id)).ok, true);
    assert.throws(() => h.app.drawService.freeze({ campaignId: h.campaign.id, periodId: period.id, actorId: officer.id }), /DRAW_EXISTS/);
  });
  it("T-22: the exported bundle verifies independently and fails when tampered", async () => {
    const d = h.app.drawService.list(h.campaign.id)[0];
    const bundle = h.app.drawService.bundle(d.id, auditor.id);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-")); const file = path.join(dir, "b.json");
    fs.writeFileSync(file, JSON.stringify(bundle));
    const run = (f) => { try { return { code: 0, out: execFileSync("node", ["--no-warnings", path.join(ROOT, "scripts", "verify-draw-bundle.mjs"), f, "--checkpoint-key", "test-checkpoint-key"], { encoding: "utf8" }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
    const ok = run(file); assert.equal(ok.code, 0, ok.out); assert.equal(JSON.parse(ok.out).verified, true);
    for (const mutate of [(b) => { b.output.winners[0].entryId = b.output.alternates[0].entryId; }, (b) => { b.seed_hex = "00".repeat(32); }, (b) => { b.snapshot.candidates.pop(); }, (b) => { b.draw.approver_id = b.draw.operator_id; }, (b) => { b.audit_events[0].payload_json += " "; }, (b) => { b.audit_checkpoint.signature = "0".repeat(64); },
      // Forge the approver. The draw row is a mutable column, so a tamperer
      // rewrites it AND the matching audit column to stay self-consistent;
      // only the signed body still names the real approver.
      (b) => { for (const e of b.audit_events) if (e.action === "draw.approved") e.actor_id = b.draw.operator_id; },
      (b) => { b.draw.approver_id = b.draw.operator_id; for (const e of b.audit_events) if (e.action === "draw.approved") e.actor_id = b.draw.operator_id; },
      (b) => { for (const e of b.audit_events) e.created_at = "1999-01-01T00:00:00.000Z"; }]) {
      const t = JSON.parse(JSON.stringify(bundle)); mutate(t); fs.writeFileSync(file, JSON.stringify(t)); const r = run(file); assert.equal(r.code, 1, "tampered bundle must fail"); assert.equal(JSON.parse(r.out).verified, false);
    }
  });
  it("T-23/T-24/T-25: publish materialises winners; notify is queued only after approval; claim lifecycle; alternates; publication is separate and safe", async () => {
    const d = h.app.drawService.list(h.campaign.id)[0];
    assert.throws(() => h.app.winners.materialise("drw_nope", ops.id), /not found/);
    const pub = h.app.drawService.publish(d.id, ops.id); assert.equal(pub.status, "published");
    const m = h.app.winners.materialise(d.id, ops.id); assert.equal(m.created, 5); assert.equal(h.app.winners.materialise(d.id, ops.id).idempotent, true);
    const [w1, w2, w3] = h.app.winners.listByDraw(d.id);
    assert.deepEqual((await h.api("/api/winners/public")).data.winners, [], "nothing public before verification + publication");
    const n = h.app.winners.notify(w1.id, ops.id); assert.match(n.claimRef, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await h.app.worker.tick();
    const msg = h.db.prepare(`select * from outbound_messages where idempotency_key=?`).get(`winner:${w1.id}:notify:1`); assert.equal(msg.status, "sent"); assert.match(JSON.parse(msg.payload_json).body, /Congratulations Part/); assert.match(JSON.parse(msg.payload_json).body, new RegExp(n.claimRef));
    assert.equal(h.app.winners.verifyClaimToken(w1.id, n.claimRef), true); assert.equal(h.app.winners.verifyClaimToken(w1.id, "XXXX-XXXX"), false);
    assert.throws(() => h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id }), /cannot move/);
    h.app.winners.transition(w1.id, { status: "verified", actorId: ops.id });
    const nonCollect = h.domain.listCampaignOutlets(h.campaign.id).find((o) => !o.collection_enabled); const collect = h.domain.listCampaignOutlets(h.campaign.id).find((o) => o.collection_enabled);
    h.app.winners.transition(w1.id, { status: "accepted", actorId: ops.id });
    assert.throws(() => h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id, collectionOutletId: nonCollect.id }), /cannot distribute/);
    const col = h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id, collectionOutletId: collect.id, fulfilmentRef: "SLIP-1", expectedVersion: h.app.winners.get(w1.id).row_version });
    assert.equal(col.winner.status, "collected"); assert.ok(col.winner.fulfilled_at);
    assert.throws(() => h.app.winners.transition(w1.id, { status: "collected", actorId: ops.id, collectionOutletId: collect.id }), /cannot move|already/);   // second fulfilment blocked
    // stale version conflict
    assert.throws(() => h.app.winners.transition(w2.id, { status: "notified", actorId: ops.id, expectedVersion: 99 }), /changed since/);
    // replacement promotes the next alternate, never a new random draw
    const before = JSON.parse(h.app.drawService.get(d.id).output_json).alternates[0].entryId;
    const rep = h.app.winners.transition(w3.id, { status: "replaced", actorId: ops.id, reason: "no response" });
    assert.equal(rep.replacement.entry_id, before); assert.equal(rep.replacement.status, "selected"); assert.equal(h.app.winners.get(w3.id).replaced_by, rep.replacement.id);
    // expiry job vs fulfilment consistency
    h.app.winners.notify(w2.id, ops.id); h.db.prepare(`update winners set claim_expires_at=? where id=?`).run("2000-01-01T00:00:00Z", w2.id);
    assert.equal(h.app.winners.expireDue().expired, 1); assert.equal(h.app.winners.get(w2.id).status, "expired");
    // publication: only verified+published; projection has no phone/identity
    assert.throws(() => h.app.winners.publish(rep.replacement.id, ops.id), /verified before publication/);
    h.app.winners.publish(w1.id, ops.id);
    const pubList = (await h.api("/api/winners/public?period=W-1")).data;
    assert.equal(pubList.winners.length, 1); assert.deepEqual(Object.keys(pubList.winners[0]).sort(), ["location", "name", "period", "prize", "rank"]); assert.match(pubList.winners[0].name, /^Part[A-F] T\.$/);
    // WhatsApp winners browsing by week
    const ph = "263771000199"; await h.say(ph, "menu"); const wk = await h.say(ph, "6"); assert.match(wk.replies[0], /1\. Week/); const list = await h.say(ph, "1"); assert.match(list.replies[0], /1\. Part[A-F] T\. \(/); assert.doesNotMatch(list.replies[0], /2637/);
    // withdrawing publication hides it again
    h.app.winners.unpublish(w1.id, ops.id, "test"); assert.equal((await h.api("/api/winners/public?period=W-1")).data.winners.length, 0);
  });
  it("void + rerun: an approved draw is never edited; a replacement is a new linked draw with a different approver", async () => {
    const d = h.app.drawService.list(h.campaign.id)[0];
    assert.throws(() => h.app.drawService.voidDraw(d.id, officer.id, "dispute"), /second, different approver/);
    const r = h.app.drawService.rerun(d.id, officer.id, "dispute upheld", approver.id);
    assert.equal(r.status, "frozen"); assert.equal(r.supersedes, d.id); assert.equal(h.app.drawService.get(d.id).status, "voided"); assert.equal(h.app.drawService.get(d.id).superseded_by, r.id);
    assert.ok(h.app.drawService.get(d.id).output_json, "original evidence retained");
  });
  it("disqualification of an entry in a frozen draw needs independent approval and preserves the award history", async () => {
    const e = h.db.prepare(`select id from entries where campaign_id=? and status='active' limit 1`).get(h.campaign.id);
    assert.throws(() => h.app.pipeline.disqualifyEntry(e.id, { actorId: officer.id, reason: "refund found" }), /independent approval/);
    assert.throws(() => h.app.pipeline.disqualifyEntry(e.id, { actorId: officer.id, reason: "refund found", approvedBy: officer.id }), /differ/);
    const r = h.app.pipeline.disqualifyEntry(e.id, { actorId: officer.id, reason: "refund found", approvedBy: approver.id });
    assert.ok(r.affectedDraws.length >= 1); assert.equal(h.db.prepare(`select status from entries where id=?`).get(e.id).status, "excluded");
    assert.equal(h.db.prepare(`select count(*) n from entry_events where entry_id=?`).get(e.id).n, 1);
  });
});
