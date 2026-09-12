import crypto from "node:crypto";
import { id, tx, nowIso } from "./db.mjs";
import { canonicalJson, sha256 } from "./audit.mjs";

/**
 * Auditable draws (spec §14).
 *  freeze   cutoff barrier -> immutable ordered candidate snapshot + CSPRNG seed
 *           committed BEFORE any result exists (no selective rerolling).
 *  execute  one durable reservation per draw; the result is a pure function of
 *           (snapshot, seed, prize plan) so a crashed/retried execution resumes
 *           to the SAME result. Unbiased: HMAC-SHA256(seed, entry) ordering.
 *  approve  a different named user; verifies the stored output hash the
 *           approver saw (never accepts winner ids from the browser).
 *  void     a permitted replacement is a NEW linked draw; approved draws are
 *           never edited in place.
 * Candidate weighting: one entry = one chance; weight_units > 1 (approved
 * multiplier only) expands to that many chances. One prize per participant
 * per draw is enforced after each selection.
 */
export const DRAW_ALGORITHM = "hmac-sha256-sortition-v2";
export const VERIFIER_VERSION = "draw-verifier/2";

/** Deterministic ordering of candidate chances keyed by the committed seed. */
export function sortition(candidates, seedHex) {
  const key = Buffer.from(seedHex, "hex");
  const scored = [];
  for (const c of candidates) {
    const units = Math.max(1, Number(c.weightUnits || 1));
    for (let u = 0; u < units; u++) {
      const h = crypto.createHmac("sha256", key).update(`entry:${c.entryId}:unit:${u}`).digest("hex");
      scored.push({ entryId: c.entryId, participantId: c.participantId, score: h });
    }
  }
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.entryId < b.entryId ? -1 : 1));
  return scored;
}

/** Apply the prize plan: winners then alternates, one prize per participant. Pure. */
export function selectWinners(ordered, plan) {
  const winners = [], alternates = [], seenP = new Set(), seenE = new Set();
  const total = plan.totalWinners, altN = plan.totalAlternates;
  for (const s of ordered) {
    if (seenE.has(s.entryId)) continue;
    if (plan.onePrizePerParticipant && seenP.has(s.participantId)) continue;
    seenE.add(s.entryId); seenP.add(s.participantId);
    if (winners.length < total) winners.push({ position: winners.length + 1, entryId: s.entryId, participantId: s.participantId, prize_code: prizeCodeFor(winners.length + 1, plan) });
    else if (alternates.length < altN) alternates.push({ position: alternates.length + 1, entryId: s.entryId, participantId: s.participantId });
    else break;
  }
  return { winners, alternates };
}
export function prizeCodeFor(rank, plan) {
  let cursor = 0;
  for (const t of plan.tiers) { cursor += Number(t.count) || 0; if (rank <= cursor) return t.code; }
  return plan.tiers.at(-1)?.code || "P1";
}
export function planFrom(prizeConfig = {}, drawConfig = {}) {
  // Resolve FIELD BY FIELD, not by picking one source object. Choosing a whole
  // source on `prizes?.length` silently discarded every other period override:
  // a period set to { alternates_per_winner: 3, one_prize_per_participant: false }
  // (tiers inherited from the campaign) resolved byte-identically to {}, so the
  // week ran with the campaign's alternates and cap and nothing reported it.
  // NOTE for whoever re-reads client period configs: `winner_exclusion` is in
  // this merge too, and it decides WHO IS ELIGIBLE. A period that supplies
  // `prizes` but no winner_exclusion used to resolve to "none"; it now inherits
  // the campaign's value, so a campaign set to winner_exclusion:"campaign"
  // starts excluding prior winners from that period's pool — a different
  // candidate set, snapshot_hash and result. Check it before the next draw.
  const pick = (k, dflt) => prizeConfig[k] ?? drawConfig[k] ?? dflt;
  const prizes = prizeConfig.prizes?.length ? prizeConfig.prizes : (drawConfig.prizes || []);
  const tiers = prizes.map((p) => ({ code: p.code || "P1", label: p.label || p.code || "Prize", count: Number(p.count ?? p.per_week ?? 1) }));
  const totalWinners = tiers.reduce((a, t) => a + t.count, 0);
  const alternatesPerWinner = Number(pick("alternates_per_winner", 1));
  // A period that states alternates_per_winner without a total is overriding the
  // alternate policy: derive the total from ITS rate rather than inheriting the
  // campaign's fixed total, which would cancel the override it just made.
  const totalAlternates = prizeConfig.total_alternates ?? (prizeConfig.alternates_per_winner != null ? totalWinners * alternatesPerWinner : drawConfig.total_alternates ?? totalWinners * alternatesPerWinner);
  return { tiers, totalWinners, alternatesPerWinner, totalAlternates: Number(totalAlternates), onePrizePerParticipant: pick("one_prize_per_participant", true) !== false, winnerExclusion: pick("winner_exclusion", null) || "none" };
}
export const outputHashOf = (output) => sha256(canonicalJson(output));
export const snapshotHashOf = (snapshot) => sha256(canonicalJson(snapshot));

export function createDrawService(db, { domain, randomBytes = 32, now = nowIso } = {}) {
  const get = db.prepare(`select d.*, coalesce(cp.code, d.draw_period) as period_code, cp.label as period_label from draws d left join campaign_periods cp on cp.id = d.period_id where d.id = ?`);
  const cands = db.prepare(`select * from draw_candidates where draw_id = ? order by position`);
  /** Who froze the candidate pool. Recorded at freeze; execute() preserves it while overwriting operator_id. */
  const frozenBy = (d) => { try { return JSON.parse(d.evidence_json || "{}").frozen_by || null; } catch { return null; } };
  const adminUser = db.prepare(`select id, roles, status from admin_users where id = ?`);
  /**
   * The second name on a void must be a REAL, currently-authorised approver.
   * POST /api/draws/:id/rerun is draw_officer-only and passes approved_by
   * straight through src/http.mjs `str()`, which validates nothing at all, so
   * requiring a truthy, different STRING was not dual control: one officer sent
   * {reason, approved_by:"z"}, voided the EXECUTED draw whose winners he had
   * already read, re-froze for a fresh seed and repeated until the result
   * suited him. Resolve the name against admin_users here — the service already
   * holds `db` and admin_users lives in the same database.
   */
  function assertSecondApprover(actorId, approvedBy, what) {
    if (!approvedBy || approvedBy === actorId) throw Object.assign(new Error(`${what} requires a second, different approver`), { code: "SOD" });
    const ap = adminUser.get(approvedBy);
    if (!ap || ap.status !== "active") throw Object.assign(new Error(`${what} requires a second approver: "${String(approvedBy).slice(0, 60)}" is not an active staff account`), { code: "SOD" });
    let roles = []; try { roles = JSON.parse(ap.roles || "[]"); } catch { roles = []; }
    if (!roles.includes("draw_approver")) throw Object.assign(new Error(`${what} requires a second approver holding draw_approver`), { code: "SOD" });
  }

  /** Cutoff barrier + eligibility (pure read). */
  function barrier(campaignId, periodId) {
    const period = domain.getPeriod(periodId);
    if (!period || period.campaign_id !== campaignId) throw Object.assign(new Error("period not found"), { code: "NOT_FOUND" });
    const blockers = [];
    if (Date.parse(period.ends_at) > Date.parse(now())) blockers.push({ code: "PERIOD_OPEN", detail: `period ends ${period.ends_at}` });
    const unresolved = db.prepare(`select status, count(*) n from receipts where campaign_id=? and period_code=? and intake_at < ? and status in ('received','processing','delayed','REVIEW_REQUIRED') group by status`).all(campaignId, period.code, period.ends_at);
    if (unresolved.length) blockers.push({ code: "UNRESOLVED_SUBMISSIONS", detail: unresolved });
    const existing = db.prepare(`select id, status from draws where period_id=? and status not in ('voided') order by created_at desc limit 1`).get(periodId);
    if (existing) blockers.push({ code: "DRAW_EXISTS", detail: existing });
    const campaign = domain.getCampaign(campaignId);
    const plan = planFrom(JSON.parse(period.prize_config_json || "{}"), JSON.parse(campaign.draw_config_json || "{}"));
    // Select on entries alone and filter the participant status HERE: the old
    // inner join on p.status='active' dropped the entries of withdrawn and
    // erased participants before `exclusions` was built, so they appeared in
    // neither the snapshot, the candidate rows nor the signed freeze payload —
    // an evidence pack with an unexplained shortfall against "entries in W-1".
    const rows = db.prepare(`select e.id, e.participant_id, e.weight_units, e.campaign_version_id, p.status as participant_status from entries e left join participants p on p.id=e.participant_id where e.campaign_id=? and e.period_code=? and e.status='active' order by e.id`).all(campaignId, period.code);
    const exclusions = [];
    // reason carries a status word only — the snapshot is exported in the bundle handed to the client
    let eligible = rows.filter((r) => { if (r.participant_status === "active") return true; exclusions.push({ entryId: r.id, reason: `participant_${r.participant_status || "missing"}` }); return false; });
    if (plan.winnerExclusion === "campaign") {
      const prior = new Set(db.prepare(`select w.participant_id from winners w join draws d on d.id=w.draw_id where d.campaign_id=? and d.status in ('approved','published') and w.status not in ('replaced','rejected','expired','ineligible')`).all(campaignId).map((r) => r.participant_id));
      eligible = eligible.filter((r) => { if (prior.has(r.participant_id)) { exclusions.push({ entryId: r.id, reason: "prior_winner" }); return false; } return true; });
    }
    const distinct = new Set(eligible.map((r) => r.participant_id)).size;
    // A campaign or period with no prize tiers plans ZERO winners, and every
    // count check below passes vacuously (`n < 0` is false). Without this the
    // week freezes, executes, is approved, published and verified while awarding
    // nobody, and DRAW_EXISTS then blocks a corrective draw.
    if (plan.totalWinners < 1) blockers.push({ code: "NO_PRIZE_PLAN", detail: { tiers: plan.tiers.length, totalWinners: plan.totalWinners } });
    if (eligible.length === 0) blockers.push({ code: "NO_CANDIDATES" });
    else if (plan.onePrizePerParticipant ? distinct < plan.totalWinners : eligible.length < plan.totalWinners) blockers.push({ code: "INSUFFICIENT_CANDIDATES", detail: { eligibleEntries: eligible.length, distinctParticipants: distinct, required: plan.totalWinners } });
    return { period, plan, blockers, eligible, exclusions, ok: blockers.length === 0 };
  }

  function freeze({ campaignId, periodId, actorId, override = null }) {
    const b = barrier(campaignId, periodId);
    const blocking = b.blockers.filter((x) => !(override?.allow || []).includes(x.code));
    if (blocking.length) throw Object.assign(new Error(`draw blocked: ${blocking.map((x) => x.code).join(", ")}`), { code: "BLOCKED", blockers: blocking });
    const version = domain.getActiveVersion(campaignId);
    return tx(db, () => {
      const drawId = id("drw");
      // draw_period is the internal label; the v1 UNIQUE(campaign_id, draw_period)
      // is kept, so a rerun for the same period gets a "#n" suffix. The period
      // CODE (shown to participants and staff) always comes from campaign_periods.
      const priorCount = db.prepare(`select count(*) n from draws where period_id=?`).get(periodId).n;
      const label = priorCount ? `${b.period.code}#${priorCount + 1}` : b.period.code;
      const candidates = b.eligible.map((e) => ({ entryId: e.id, participantId: e.participant_id, weightUnits: Number(e.weight_units || 1) }));
      // `rulesVersion` is the version ACTIVE AT FREEZE, which is not necessarily
      // the version each entry was judged under (a manager may have activated a
      // new version after the entries were awarded). State both facts instead of
      // letting one stand in for the other, so the evidence pack cannot be read
      // as "these entries were judged under this rule set".
      const byVersion = new Map();
      for (const e of b.eligible) byVersion.set(e.campaign_version_id || null, (byVersion.get(e.campaign_version_id || null) || 0) + 1);
      const candidateRulesVersions = [...byVersion.entries()]
        // Codepoint order, NOT localeCompare: this array is hashed into
        // snapshot_hash, and localeCompare depends on the node's ICU data, so
        // two nodes could freeze the same candidate pool to different snapshots.
        .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : String(x[0]) > String(y[0]) ? 1 : 0))
        .map(([vid, n]) => ({ versionId: vid, configHash: vid ? domain.getVersion(vid)?.config_hash || null : null, entries: n }));
      const snapshot = { drawId, campaignId, periodCode: b.period.code, rulesVersion: version?.config_hash || null, activeVersionAtFreeze: version?.config_hash || null, candidateRulesVersions, plan: b.plan, candidates, exclusions: b.exclusions };
      const snapshotHash = snapshotHashOf(snapshot);
      // The seed must be COMMITTED before any result exists: sha256(seed) goes
      // into the draw row and into the hash-chained draw.frozen audit payload,
      // so swapping the seed before execution is detectable by anyone holding
      // the bundle. Storing the seed alone committed it to nothing.
      const seedHex = crypto.randomBytes(randomBytes).toString("hex");
      const seedCommitment = sha256(seedHex);
      db.prepare(`insert into draws (id, campaign_id, draw_period, status, config_hash, snapshot_json, snapshot_hash, algorithm, seed_hex, seed_commitment, evidence_json, operator_id, created_at, period_id, rules_version_id, prize_plan_json, barrier_json, verifier_version)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(drawId, campaignId, label, "frozen", version?.config_hash || "", JSON.stringify(snapshot), snapshotHash, DRAW_ALGORITHM, seedHex, seedCommitment, JSON.stringify({ frozen_by: actorId, frozen_at: now(), override }), actorId, now(), periodId, version?.id || null, JSON.stringify(b.plan), JSON.stringify({ checkedAt: now(), blockers: b.blockers, overridden: override }), VERIFIER_VERSION);
      const ins = db.prepare(`insert into draw_candidates (id, draw_id, position, entry_id, status, exclusion_reason) values (?,?,?,?,?,?)`);
      candidates.forEach((c, i) => ins.run(id("cand"), drawId, i, c.entryId, "eligible", null));
      b.exclusions.forEach((x, i) => ins.run(id("cand"), drawId, 100000 + i, x.entryId, "excluded", x.reason));
      // A replacement must name what it replaces. Only rerun() linked the chain,
      // so the plain void -> freeze path produced a draw labelled "#n" whose
      // bundle reported supersedes: null and disclosed nothing about the
      // execution(s) already seen and discarded.
      const prior = db.prepare(`select id from draws where period_id=? and id<>? order by created_at desc, rowid desc limit 1`).get(periodId, drawId);
      if (prior) {
        db.prepare(`update draws set supersedes=? where id=?`).run(prior.id, drawId);
        db.prepare(`update draws set superseded_by=? where id=?`).run(drawId, prior.id);
      }
      domain.setPeriodStatus(periodId, "closed", actorId);
      domain.audit({ actorType: "admin", actorId, action: "draw.frozen", targetType: "draw", targetId: drawId, payload: { periodCode: b.period.code, candidates: candidates.length, exclusions: b.exclusions.length, snapshotHash, seedCommitment, override, supersedes: prior?.id || null } });
      return get.get(drawId);
    });
  }

  /** Durable execution: reservation frozen->executing; result deterministic from committed seed; retry resumes. */
  function execute(drawId, actorId) {
    const d = get.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    if (d.status === "executed" || d.status === "approved" || d.status === "published") return d;
    if (!["frozen", "executing"].includes(d.status)) throw Object.assign(new Error(`draw cannot be executed (status=${d.status})`), { code: "CONFLICT" });
    const reserved = db.prepare(`update draws set status='executing', execution_attempts=execution_attempts+1 where id=? and status='frozen'`).run(drawId);
    if (!reserved.changes) {
      // another executor holds the reservation (or a crash left it): resume deterministically
      db.prepare(`insert into draw_attempts (id, draw_id, actor_id, outcome, detail, created_at) values (?,?,?,?,?,?)`).run(id("dat"), drawId, actorId, "resumed", "reservation already held; recomputing deterministically", now());
    } else db.prepare(`insert into draw_attempts (id, draw_id, actor_id, outcome, created_at) values (?,?,?,?,?)`).run(id("dat"), drawId, actorId, "reserved", now());
    // A seed that no longer matches the commitment made at freeze means the
    // randomness was replaced after the candidate pool was fixed. Refuse.
    if (d.seed_commitment && sha256(d.seed_hex) !== d.seed_commitment) {
      db.prepare(`insert into draw_attempts (id, draw_id, actor_id, outcome, detail, created_at) values (?,?,?,?,?,?)`)
        .run(id("dat"), drawId, actorId, "refused", "seed does not match the commitment made at freeze", now());
      domain.alert({ kind: "draw.seed_tampered", severity: "critical", runbook: "docs/runbooks/draw-and-verification.md",
        message: `draw ${drawId}: the seed does not match the commitment recorded at freeze; execution refused` });
      domain.audit({ actorType: "admin", actorId, action: "draw.seed_mismatch", targetType: "draw", targetId: drawId, payload: { expected: d.seed_commitment, actual: sha256(d.seed_hex) } });
      throw Object.assign(new Error("draw seed does not match the commitment recorded at freeze"), { code: "INTEGRITY" });
    }
    const snapshot = JSON.parse(d.snapshot_json);
    const output = computeOutput(snapshot, d.seed_hex);
    const outputHash = outputHashOf(output);
    return tx(db, () => {
      const cur = get.get(drawId);
      if (cur.status === "executed") return cur; // concurrent executor finished first with the same result
      db.prepare(`update draws set status='executed', output_json=?, output_hash=?, operator_id=?, executed_at=?, evidence_json=? where id=? and status='executing'`)
        .run(JSON.stringify(output), outputHash, actorId, now(), JSON.stringify({ ...JSON.parse(cur.evidence_json || "{}"), executed_by: actorId, executed_at: now(), algorithm: DRAW_ALGORITHM, snapshot_hash: cur.snapshot_hash, output_hash: outputHash, attempts: cur.execution_attempts }), drawId);
      db.prepare(`update draw_attempts set outcome='completed' where draw_id=? and actor_id=? and outcome in ('reserved','resumed')`).run(drawId, actorId);
      domain.audit({ actorType: "admin", actorId, action: "draw.executed", targetType: "draw", targetId: drawId, payload: { outputHash, winners: output.winners.length, alternates: output.alternates.length } });
      return get.get(drawId);
    });
  }
  function computeOutput(snapshot, seedHex) {
    const ordered = sortition(snapshot.candidates, seedHex);
    const { winners, alternates } = selectWinners(ordered, snapshot.plan);
    return { algorithm: DRAW_ALGORITHM, sequence: ordered.map((s) => s.entryId), winners, alternates, plan: snapshot.plan };
  }

  function approve(drawId, approverId, { expectedOutputHash = null, note = null } = {}) {
    return tx(db, () => {
      const d = get.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
      if (d.status === "approved" && d.approver_id === approverId) return d; // idempotent replay
      if (d.status !== "executed") throw Object.assign(new Error(`draw cannot be approved (status=${d.status})`), { code: "CONFLICT" });
      if (d.operator_id === approverId) throw Object.assign(new Error("the user who executed the draw cannot approve it"), { code: "SOD" });
      // execute() overwrites operator_id with the EXECUTOR, and execution is a
      // pure function of (snapshot, committed seed, plan) — the executor has no
      // discretion at all. Freeze is the step that picks the candidate pool and
      // waives barriers, so the freezer must not be the second pair of eyes
      // either; otherwise the person who chose the pool approves their own work.
      if (frozenBy(d) && frozenBy(d) === approverId) throw Object.assign(new Error("the user who froze the candidate pool cannot approve the draw"), { code: "SOD" });
      if (expectedOutputHash && expectedOutputHash !== d.output_hash) throw Object.assign(new Error("result changed since you reviewed it; reload"), { code: "CONFLICT" });
      // verify integrity before approving
      const check = verifyStored(d);
      if (!check.ok) throw Object.assign(new Error(`integrity check failed: ${check.problems.join("; ")}`), { code: "INTEGRITY" });
      const r = db.prepare(`update draws set status='approved', approver_id=?, approved_at=?, approval_note=? where id=? and status='executed'`).run(approverId, now(), note, drawId);
      if (!r.changes) throw Object.assign(new Error("concurrent approval"), { code: "CONFLICT" });
      domain.audit({ actorType: "admin", actorId: approverId, action: "draw.approved", targetType: "draw", targetId: drawId, payload: { outputHash: d.output_hash, note } });
      return get.get(drawId);
    });
  }
  function reject(drawId, approverId, reason) {
    const d = get.get(drawId); if (!d || d.status !== "executed") throw Object.assign(new Error("only executed draws can be rejected"), { code: "CONFLICT" });
    // Rejecting is the mirror of approving and discards a result that has
    // already been seen; without the same separation of duties one person could
    // reject their own draw and re-freeze for a fresh seed.
    if (d.operator_id === approverId) throw Object.assign(new Error("the user who executed the draw cannot reject it"), { code: "SOD" });
    if (frozenBy(d) && frozenBy(d) === approverId) throw Object.assign(new Error("the user who froze the candidate pool cannot reject the draw"), { code: "SOD" });
    db.prepare(`update draws set status='voided', voided_at=?, voided_by=?, void_reason=? where id=?`).run(now(), approverId, reason, drawId);
    domain.setPeriodStatus(d.period_id, "closed", approverId);
    domain.audit({ actorType: "admin", actorId: approverId, action: "draw.rejected", targetType: "draw", targetId: drawId, reason });
    return get.get(drawId);
  }
  function publish(drawId, actorId) {
    const d = get.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    if (d.status === "published") return d;
    if (d.status !== "approved") throw Object.assign(new Error(`draw cannot be published (status=${d.status})`), { code: "CONFLICT" });
    db.prepare(`update draws set status='published', published_at=? where id=? and status='approved'`).run(now(), drawId);
    domain.setPeriodStatus(d.period_id, "drawn", actorId);
    domain.audit({ actorType: "admin", actorId, action: "draw.published", targetType: "draw", targetId: drawId });
    return get.get(drawId);
  }
  /** Authorised void of an approved/published draw; a replacement is a new linked draw. */
  function voidDraw(drawId, actorId, reason, approvedBy) {
    const d = get.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    if (!reason) throw new Error("reason required");
    // 'executed' belongs in this list: the winners are readable as soon as the
    // draw is executed, so a single actor could void a result they had already
    // seen, re-freeze for a fresh seed and repeat until the outcome suited them.
    // A frozen draw has produced no result yet, so abandoning one stays single-actor.
    if (["executed", "approved", "published"].includes(d.status)) assertSecondApprover(actorId, approvedBy, `voiding a ${d.status} draw`);
    db.prepare(`update draws set status='voided', voided_at=?, voided_by=?, void_reason=? where id=?`).run(now(), actorId, `${reason} (approved by ${approvedBy || "n/a"})`, drawId);
    db.prepare(`update winners set status='replaced', publication_state='withdrawn' where draw_id=? and status not in ('collected')`).run(drawId);
    domain.setPeriodStatus(d.period_id, "closed", actorId);
    domain.audit({ actorType: "admin", actorId, action: "draw.voided", targetType: "draw", targetId: drawId, reason, payload: { approvedBy } });
    return get.get(drawId);
  }
  function rerun(drawId, actorId, reason, approvedBy) {
    const old = get.get(drawId); if (!old) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    if (old.status !== "voided") voidDraw(drawId, actorId, reason, approvedBy);
    const d = freeze({ campaignId: old.campaign_id, periodId: old.period_id, actorId });
    db.prepare(`update draws set supersedes=? where id=?`).run(drawId, d.id);
    db.prepare(`update draws set superseded_by=? where id=?`).run(d.id, drawId);
    domain.audit({ actorType: "admin", actorId, action: "draw.rerun", targetType: "draw", targetId: d.id, reason, payload: { supersedes: drawId } });
    return get.get(d.id);
  }

  /** Recompute everything from stored evidence (used by approve and by the audit endpoint). */
  function verifyStored(d) {
    const problems = [];
    const snapshot = JSON.parse(d.snapshot_json);
    if (snapshotHashOf(snapshot) !== d.snapshot_hash) problems.push("snapshot hash mismatch");
    const stored = cands.all(d.id).filter((c) => c.status === "eligible").map((c) => c.entry_id);
    if (JSON.stringify(stored) !== JSON.stringify(snapshot.candidates.map((c) => c.entryId))) problems.push("candidate rows differ from snapshot");
    if (d.output_json) {
      const out = computeOutput(snapshot, d.seed_hex);
      if (outputHashOf(out) !== d.output_hash) problems.push("output hash mismatch");
      if (JSON.stringify(out.winners.map((w) => w.entryId)) !== JSON.stringify(JSON.parse(d.output_json).winners.map((w) => w.entryId))) problems.push("winner order mismatch");
    }
    if (d.approver_id && d.approver_id === d.operator_id) problems.push("approver equals operator");
    return { ok: problems.length === 0, problems };
  }

  /** Export the audit bundle for independent verification (scripts/verify-draw-bundle.mjs). */
  function bundle(drawId, actorId) {
    const d = get.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    const events = db.prepare(`select id, actor_type, actor_id, action, target_type, target_id, reason, request_id, scope, correlation_id, prev_hash, entry_hash, payload_json, created_at from audit_events where target_type='draw' and target_id=? order by id`).all(drawId);
    // The exported events are SELF-certifying: entry_hash = sha256(prev + body)
    // needs no key, so whoever holds the file can rewrite "who executed this
    // draw" and recompute the hash, and every check still agreed. Commit the
    // exported events' hashes to the chain FIRST (this manifest event), then
    // sign the head: the manifest's own entry_hash is covered by the HMAC
    // checkpoint, and the tail below proves the manifest is an ancestor of that
    // signed head. Editing any exported event now contradicts a hash that
    // cannot be forged without AUDIT_CHECKPOINT_KEY.
    const manifest = domain.audit({ actorType: "admin", actorId, action: "draw.bundle_exported", targetType: "draw", targetId: drawId,
      payload: { events: events.map((e) => ({ id: e.id, entryHash: e.entry_hash })), snapshotHash: d.snapshot_hash, outputHash: d.output_hash } });
    const checkpoint = domain.auditService.checkpoint(actorId);
    const tail = checkpoint && manifest?.id
      ? db.prepare(`select id, prev_hash, entry_hash, payload_json from audit_events where id >= ? and id <= ? order by id`).all(manifest.id, checkpoint.uptoId)
      : [];
    return {
      bundle_version: VERIFIER_VERSION, exported_at: now(), exported_by: actorId,
      draw: { id: d.id, campaign_id: d.campaign_id, period: d.period_code, draw_label: d.draw_period, status: d.status, algorithm: d.algorithm, snapshot_hash: d.snapshot_hash, output_hash: d.output_hash, seed_commitment: d.seed_commitment, operator_id: d.operator_id, frozen_by: frozenBy(d), approver_id: d.approver_id, executed_at: d.executed_at, approved_at: d.approved_at, published_at: d.published_at, rules_version: d.config_hash, supersedes: d.supersedes, superseded_by: d.superseded_by, barrier: JSON.parse(d.barrier_json || "null") },
      snapshot: JSON.parse(d.snapshot_json), seed_hex: d.status === "frozen" ? null : d.seed_hex,   // pre-execution randomness is never exported
      output: d.output_json ? JSON.parse(d.output_json) : null,
      attempts: db.prepare(`select actor_id, outcome, detail, created_at from draw_attempts where draw_id=? order by created_at`).all(drawId),
      // Every draw ever frozen for this period, so a "#n" replacement cannot
      // hide the executions that were discarded before it.
      period_draws: d.period_id ? db.prepare(`select id, draw_period as draw_label, status, snapshot_hash, output_hash, operator_id, approver_id, voided_by, void_reason, voided_at, supersedes, superseded_by, created_at from draws where period_id=? order by created_at`).all(d.period_id) : [],
      audit_events: events, audit_checkpoint: checkpoint,
      audit_anchor: manifest?.id ? { manifest_event_id: manifest.id, chain_tail: tail } : null,
    };
  }

  return { barrier, freeze, execute, approve, reject, publish, voidDraw, rerun, verifyStored, bundle, get: (i) => get.get(i), candidates: (i) => cands.all(i), computeOutput, list: (campaignId) => db.prepare(`select d.id, d.period_id, d.draw_period, coalesce(cp.code, d.draw_period) as period_code, d.status, d.snapshot_hash, d.output_hash, d.operator_id, d.approver_id, d.executed_at, d.approved_at, d.published_at, d.created_at, d.supersedes, d.superseded_by, d.void_reason from draws d left join campaign_periods cp on cp.id=d.period_id where d.campaign_id=? order by d.created_at desc`).all(campaignId) };
}
