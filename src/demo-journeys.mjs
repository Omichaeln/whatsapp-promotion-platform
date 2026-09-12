// Populated TEST ONLY journeys: synthetic participants and real fixture images
// pushed through the REAL pipeline (OCR) so every screen has data — qualified
// entries, duplicates, rejected, pending review, a published historical draw
// (W-2) with winners in several states, and W-1 left drawable for UAT.
// Used by scripts/seed-demo.mjs and, when SEED_POPULATED=true, by the deploy
// bootstrap after the server is listening. Idempotent per campaign.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { fixtureBytes, SAMPLE_CODE } from "./demo-seed.mjs";

/** The synthetic phones this seed owns. Nothing outside this list may be touched. */
export const SEED_PHONES = Array.from({ length: 12 }, (_, i) => `2637700000${String(i + 1).padStart(2, "0")}`);
export const SEED_MARKER_KEY = "sample_journeys";

const seedPhoneFilter = (alias) => `${alias}.participant_id in (select id from participants where wa_phone_uid in (${SEED_PHONES.map(() => "?").join(",")}))`;

/**
 * Entries the seed itself created. The backdating UPDATEs below used to be
 * scoped by campaign_id alone, and they run 1-2 minutes AFTER the server and
 * worker are live on the same TEST ONLY campaign real UAT testers use — so a
 * genuine tester's current-period entry was rewritten into the historical W-2
 * pool and could be drawn as a demo winner.
 */
export function seedEntries(db, campaignId, { excludePeriods = [] } = {}) {
  const ex = excludePeriods.length ? ` and e.period_code not in (${excludePeriods.map(() => "?").join(",")})` : "";
  return db.prepare(`select e.id, e.receipt_id from entries e where e.campaign_id=? and e.status='active' and ${seedPhoneFilter("e")}${ex} order by e.created_at`).all(campaignId, ...SEED_PHONES, ...excludePeriods);
}

/** Undecided review tasks belonging to this seed's own receipts (never a tester's). */
export function seedReviewTasks(db, campaignId, periods) {
  return db.prepare(`select rt.receipt_id from review_tasks rt join receipts r on r.id=rt.receipt_id where rt.state!='decided' and r.campaign_id=? and r.period_code in (${periods.map(() => "?").join(",")}) and ${seedPhoneFilter("r")}`).all(campaignId, ...periods, ...SEED_PHONES);
}

/**
 * Has a previous run finished?
 *
 * The completion marker answers for every run since it was introduced. For
 * databases seeded BEFORE it existed the shape of the data has to answer, and
 * "a published draw with winners" was too narrow: runPopulatedSeed deliberately
 * skips the draw when the barrier is blocked (`draw W-2 blocked: … — left for
 * the tester`) and still finishes. Such a database was reported INCOMPLETE at
 * every boot, and `npm run seed` exited 1 telling the operator to run
 * `npm run reset:sample`, destroying working sample data. A run that reached
 * its last submissions has every one of its own 12 phones enrolled AND holding
 * a receipt, which the draw cannot affect either way.
 */
export function seedComplete(db, domain, campaignId) {
  const marker = domain.getSetting(SEED_MARKER_KEY, null);
  if (marker?.completedAt) return { complete: true, marker };
  const published = db.prepare(`select count(*) n from draws d join winners w on w.draw_id=d.id where d.campaign_id=? and d.status='published'`).get(campaignId).n;
  const ph = SEED_PHONES.map(() => "?").join(",");
  const populated = db.prepare(`select count(*) n from (select p.id from participants p join campaign_enrollments ce on ce.participant_id=p.id and ce.campaign_id=? join receipts r on r.participant_id=p.id and r.campaign_id=ce.campaign_id where p.wa_phone_uid in (${ph}) group by p.id)`).get(campaignId, ...SEED_PHONES).n;
  // The "every seed phone is enrolled and holds a receipt" heuristic exists only
  // for databases seeded BEFORE the marker existed. Applying it whenever
  // completedAt is missing reversed the fix it sits on top of: a run that was
  // interrupted after the receipt stage — the marker present, completedAt not —
  // was reported complete again, which is the "already present" lie that let a
  // half-seeded environment look finished.
  const complete = published > 0 || (!marker && populated === SEED_PHONES.length);
  return { complete, marker, inferred: complete && !marker?.completedAt };
}

export async function runPopulatedSeed(app, { log = console.log } = {}) {
  const { db, domain, intake, worker, auth, drawService, winners, pipeline } = app;
  const camp = domain.getCampaignByCode(SAMPLE_CODE);
  if (!camp) throw new Error("sample campaign not seeded");
  // The guard used to be "does this campaign have any receipts", so a run
  // interrupted anywhere in its 1-2 minutes (a redeploy, a health-check
  // restart, an OOM) left the environment half-populated for ever while every
  // later boot reported "already present". Completion is now recorded, and a
  // partial run is reported as partial.
  const { complete, marker, inferred } = seedComplete(db, domain, camp.id);
  const already = db.prepare(`select count(*) n from receipts where campaign_id=?`).get(camp.id).n;
  if (complete) {
    // Heal a pre-marker database once, so the (necessarily heuristic) inference
    // above is not re-run on every boot.
    if (inferred) domain.setSetting(SEED_MARKER_KEY, { stage: "complete", startedAt: marker?.startedAt || null, completedAt: new Date().toISOString(), inferredFromData: true });
    log(`[seed] journeys already seeded (${already} receipts); nothing to do`); return { already: true, complete: true };
  }
  if (already > 0) {
    const stage = marker?.stage || "unknown";
    log(`[seed] journeys are INCOMPLETE (${already} receipts, last stage: ${stage}); a previous run did not finish. Reset and re-seed: npm run reset:sample && npm run seed`);
    return { already: true, incomplete: true, stage, receipts: already };
  }
  // Captured once: computing it inside stage() rewrote startedAt to "now" at
  // every stage transition, so the marker recorded the last transition rather
  // than when the run began.
  const startedAt = marker?.startedAt || new Date().toISOString();
  const stage = (name) => domain.setSetting(SEED_MARKER_KEY, { stage: name, startedAt, completedAt: null });
  stage("starting");
  const phones = SEED_PHONES;
  const names = [["Tendai", "Ncube"], ["Rudo", "Chari"], ["Blessing", "Moyo"], ["Farai", "Dube"], ["Chipo", "Sibanda"], ["Tapiwa", "Mutasa"], ["Nyasha", "Gumbo"], ["Kudzai", "Mhlanga"], ["Rutendo", "Chikwanda"], ["Tinashe", "Banda"], ["Vimbai", "Mapfumo"], ["Simba", "Zulu"]];
  let n = 0; const mid = () => `seed_${++n}`;
  async function say(phone, text, image = null) { intake.receive({ provider: "simulator", providerMessageId: mid(), phoneUid: phone, type: image ? "message.image" : "message.text", text: text || "", inlineMediaB64: image ? image.toString("base64") : null, timestamp: new Date().toISOString() }); await intake.drain(); }
  async function register(i) { const p = phones[i]; await say(p, "hi"); await say(p, "1"); await say(p, names[i][0]); await say(p, names[i][1]); await say(p, `TEST${String(1000 + i)}X`); await say(p, ["Harare", "Bulawayo", "Mutare", "Gweru"][i % 4]); await say(p, "yes"); await say(p, "yes"); }
  async function enter(i, outletQuery, image) { const p = phones[i]; await say(p, "2"); await say(p, outletQuery); await say(p, "1"); await say(p, "", image); }
  stage("registering");
  log("[seed] registering 12 synthetic participants…");
  for (let i = 0; i < 12; i++) await register(i);
  const outletByFixture = (id) => id.includes("-B") ? "valuemart westgate harare" : id.includes("-C") ? "kwikshop westgate harare" : "sunrise westgate harare";
  // current-period submissions across outcomes (real OCR via the pipeline)
  const plan = [[0, "valid-two-pack-A"], [0, "valid-two-pack-B"], [1, "valid-two-pack-C"], [1, "dup-photo"], [2, "valid-three-pack"], [2, "one-pack"], [3, "wrong-sku"], [3, "random-photo"], [4, "missing-receipt-no"], [4, "valid-multi-line"], [5, "non-participating-outlet"], [5, "blurred"], [6, "date-before-window"], [7, "ambiguous-date"]];
  stage("current-period-submissions");
  log(`[seed] submitting ${plan.length} fixture receipts through the real pipeline (OCR)…`);
  for (const [i, fx] of plan) { await enter(i, outletByFixture(fx), fixtureBytes(fx)); await worker.tick(); }
  // historical periods: backdate a set of entries into W-2 and W-1 so draws can run
  const periods = domain.listPeriods(camp.id);
  const hist = periods.filter((p) => ["W-2", "W-1"].includes(p.code));
  const qualified = seedEntries(db, camp.id);
  for (const [k, e] of qualified.entries()) { const per = hist[k % 2]; const at = new Date(Date.parse(per.starts_at) + 3600_000 * (k + 1)).toISOString(); db.prepare(`update entries set period_code=?, draw_period=?, created_at=? where id=?`).run(per.code, per.code, at, e.id); db.prepare(`update receipts set period_code=?, intake_at=?, created_at=? where id=?`).run(per.code, at, at, e.receipt_id); }
  // extra synthetic entries for the historical weeks (simulator-labelled, no image): registered participants 8..11 get direct awards via review path is not allowed; instead add more real submissions
  // draw pool: ten distinct qualifying purchases from ten different participants (2..11), alternated into W-2 / W-1 below
  const poolFx = fs.readdirSync(path.join(ROOT, "fixtures", "receipts")).filter((f) => /^pool-\d+-[ABC]\.jpg$/.test(f)).sort().map((f) => f.replace(/\.jpg$/, ""));
  stage("draw-pool-submissions");
  log(`[seed] submitting ${poolFx.length} draw-pool receipts (real OCR)…`);
  for (const [k, fx] of poolFx.entries()) { await enter(2 + (k % 10), outletByFixture(fx), fixtureBytes(fx)); await worker.tick(); }
  const poolEntries = seedEntries(db, camp.id, { excludePeriods: ["W-2", "W-1"] });
  for (const [k, e] of poolEntries.entries()) { const per = hist[k % 2]; const at = new Date(Date.parse(per.starts_at) + 3600_000 * (k + 10)).toISOString(); db.prepare(`update entries set period_code=?, draw_period=?, created_at=? where id=?`).run(per.code, per.code, at, e.id); db.prepare(`update receipts set period_code=?, intake_at=?, created_at=? where id=?`).run(per.code, at, at, e.receipt_id); }
  for (const [i, fx] of [[8, "valid-two-pack-A"], [9, "valid-two-pack-B"], [10, "valid-two-pack-C"], [11, "valid-multi-line"]]) { /* same receipts from other phones must be duplicates: demonstrates cross-phone blocking */ await enter(i, outletByFixture(fx), fixtureBytes(fx)); await worker.tick(); }
  // resolve on-time review items for W-2 so its barrier passes: reviewer decides
  stage("reviews");
  const reviewer = auth.listUsers().find((u) => u.email === "reviewer@example.test");
  for (const t of seedReviewTasks(db, camp.id, ["W-2", "W-1"])) { try { pipeline.review(t.receipt_id, { reviewer: reviewer.id, decision: "NOT_QUALIFIED", reasonCode: "reviewer_decision", note: "seed: resolved for draw barrier" }); } catch { /* ignore */ } }
  await worker.tick();
  // draw W-2: freeze -> execute (draw officer) -> approve (approver) -> publish (fulfilment) -> winners in several states
  stage("draw");
  const officer = auth.listUsers().find((u) => u.email === "draw@example.test"), approver = auth.listUsers().find((u) => u.email === "approver@example.test"), ops = auth.listUsers().find((u) => u.email === "fulfilment@example.test");
  // W-2 is taken through the whole draw/winner lifecycle; W-1 is deliberately left un-drawn (barrier passes) for the UAT draw steps
  for (const code of ["W-2"]) {
  const per = periods.find((p) => p.code === code);
  const b = drawService.barrier(camp.id, per.id);
  if (!b.ok) { log(`[seed] draw ${code} blocked: ${b.blockers.map((x) => x.code).join(",")} — left for the tester`); continue; }
  const d = drawService.freeze({ campaignId: camp.id, periodId: per.id, actorId: officer.id });
  drawService.execute(d.id, officer.id);
  drawService.approve(d.id, approver.id, { expectedOutputHash: drawService.get(d.id).output_hash, note: "seed approval" });
  if (code === "W-2") {
    drawService.publish(d.id, ops.id); winners.materialise(d.id, ops.id);
    const ws = winners.listByDraw(d.id);
    if (ws[0]) { winners.notify(ws[0].id, ops.id); winners.transition(ws[0].id, { status: "verified", actorId: ops.id }); winners.transition(ws[0].id, { status: "accepted", actorId: ops.id, collectionOutletId: domain.listCampaignOutlets(camp.id).find((o) => o.campaign_collection_enabled)?.id }); winners.transition(ws[0].id, { status: "collected", actorId: ops.id, fulfilmentRef: "SEED-COLLECT-1" }); winners.publish(ws[0].id, ops.id); }
    if (ws[1]) { winners.notify(ws[1].id, ops.id); winners.transition(ws[1].id, { status: "verified", actorId: ops.id }); winners.publish(ws[1].id, ops.id); }
    if (ws[2]) { winners.notify(ws[2].id, ops.id); winners.transition(ws[2].id, { status: "replaced", actorId: ops.id, reason: "seed: no response" }); }
    if (ws[3]) winners.notify(ws[3].id, ops.id);
  }
  await worker.tick();
  }
  domain.setSetting(SEED_MARKER_KEY, { stage: "complete", startedAt, completedAt: new Date().toISOString() });
  const c = (sql) => db.prepare(sql).get(camp.id).n;
  const summary = { participants: c(`select count(*) n from campaign_enrollments where campaign_id=?`), receipts: c(`select count(*) n from receipts where campaign_id=?`), by_status: db.prepare(`select status, count(*) n from receipts where campaign_id=? group by status`).all(camp.id), entries: c(`select count(*) n from entries where campaign_id=? and status='active'`), draws: db.prepare(`select draw_period, status from draws where campaign_id=?`).all(camp.id), winners: db.prepare(`select status, count(*) n from winners group by status`).all() };

  log(JSON.stringify(summary, null, 2));
  return summary;
}
