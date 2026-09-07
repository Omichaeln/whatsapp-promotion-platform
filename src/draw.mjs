import crypto from "node:crypto";
import { id, sha256hex, nowIso } from "./db.mjs";

/**
 * Auditable draws (G-13, spec 11.5, REQ-21).
 *  freeze  -> immutable candidate snapshot + CSPRNG seed + config hash
 *  execute -> HMAC-SHA256 sortition; evidence + output hash recorded
 *  approve -> separate approver; immutable after approval
 *  publish -> winners published; a rerun is a NEW linked draw, never a mutation
 */

export const DRAW_ALGORITHM = "hmac-sha256-sortition-v1";

/** Deterministic candidate ordering keyed by seed (fresh CSPRNG at freeze). */
export function sortition(candidates, seedHex) {
  const key = Buffer.from(seedHex, "hex");
  const scored = candidates.map((entryId, i) => {
    const h = crypto.createHmac("sha256", key).update(`entry:${entryId}:pos:${i}`).digest();
    return { entryId, _score: h.readUInt32BE(0), _pos: i };
  });
  scored.sort((a, b) => a._score - b._score || a._pos - b._pos);
  return scored.map(({ _score, _pos, ...c }) => c).map((c) => c.entryId);
}

const COLS = "id, campaign_id, draw_period, status, config_hash, snapshot_json, snapshot_hash, algorithm, seed_hex, evidence_json, output_json, output_hash, operator_id, approver_id, executed_at, approved_at, published_at, superseded_by, reason, created_at";

export function createDrawService(db, { randomBytes = 64, now = nowIso } = {}) {
  const get = db.prepare(`select ${COLS} from draws where id = ?`);
  const insertDraw = db.prepare(
    `insert into draws (id, campaign_id, draw_period, status, config_hash, snapshot_json, snapshot_hash,
       algorithm, seed_hex, evidence_json, operator_id, executed_at, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertCandidate = db.prepare(
    `insert into draw_candidates (id, draw_id, position, entry_id, status, exclusion_reason) values (?,?,?,?,?,?)`
  );
  const snapshotRows = db.prepare(`select * from draw_candidates where draw_id = ? order by position`);
  const setStatus = db.prepare(`update draws set status = ? where id = ? and status = ?`);
  const setEvidence = db.prepare(`update draws set evidence_json = ?, output_json = ?, output_hash = ? where id = ?`);
  const setExec = db.prepare(`update draws set operator_id = ?, executed_at = ? where id = ?`);
  const setApproved = db.prepare(`update draws set approver_id = ?, approved_at = ? where id = ?`);
  const setPublished = db.prepare(`update draws set published_at = ? where id = ?`);

  function freeze({ campaignId, drawPeriod, configHash, entryIds, exclusions = [], operatorId }) {
    if (!entryIds.length) throw new Error("no eligible entries to freeze");
    const drawId = id("drw");
    const candidates = entryIds.map((entryId) => ({ entryId }));
    const snapshotJson = JSON.stringify({ candidates, exclusions });
    const snapshotHash = sha256hex(snapshotJson);
    const seedHex = crypto.randomBytes(randomBytes).toString("hex");
    insertDraw.run(
      drawId, campaignId, drawPeriod, "frozen", configHash, snapshotJson, snapshotHash,
      DRAW_ALGORITHM, seedHex, JSON.stringify({ frozen_by: operatorId, frozen_at: now() }), operatorId, now(), now(),
    );
    entryIds.forEach((entryId, pos) =>
          insertCandidate.run(id("cand"), drawId, pos, entryId, "eligible", null));
        exclusions.forEach((ex, i) =>
          insertCandidate.run(id("cand"), drawId, 10_000 + i, ex.entryId, "excluded", ex.reason));
    return get.get(drawId);
  }

  function execute(drawId, operatorId) {
    const d = get.get(drawId);
    if (!d) throw new Error("draw not found");
    if (d.status !== "frozen") throw new Error(`draw not frozen (status=${d.status})`);
    const eligible = snapshotRows.all(drawId).filter((c) => c.status === "eligible");
    const orderedEntryIds = sortition(eligible.map((c) => c.entry_id), d.seed_hex);
    const output = {
      sequence: orderedEntryIds,
      winners: orderedEntryIds.map((entryId, i) => ({ position: i + 1, entryId })),
    };
    const outputHash = sha256hex(JSON.stringify(output));
    setStatus.run("executed", drawId, "frozen");
    setExec.run(operatorId, now(), drawId);
    setEvidence.run(JSON.stringify({ operator: operatorId, executed_at: now(), algorithm: DRAW_ALGORITHM, seed: d.seed_hex, snapshot_hash: d.snapshot_hash }), JSON.stringify(output), outputHash, drawId);
    return get.get(drawId);
  }

  function approve(drawId, approverId) {
    const d = get.get(drawId);
    if (!d || d.status !== "executed") throw new Error(`draw cannot be approved (status=${d?.status})`);
    setApproved.run(approverId, now(), drawId);
    setStatus.run("approved", drawId, "executed");
    return get.get(drawId);
  }

  function publish(drawId) {
    const d = get.get(drawId);
    if (!d || d.status !== "approved") throw new Error(`draw cannot be published (status=${d?.status})`);
    setStatus.run("published", drawId, "approved");
    setPublished.run(now(), drawId);
    return get.get(drawId);
  }

  function candidates(drawId) {
    return snapshotRows.all(drawId);
  }

  return { freeze, execute, approve, publish, get: (id) => get.get(id), candidates };
}

export { id, sha256hex, nowIso };