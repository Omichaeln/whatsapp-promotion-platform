// Independent draw reconstruction (spec 22 A-10, 23). Reads the frozen draw
// record + candidate snapshot + seed + algorithm and recomputes the output.
// A second operator can confirm the stored output_hash matches.
//
// It previously passed raw entry-id STRINGS into sortition(), which reads
// c.entryId/c.participantId/c.weightUnits off each candidate, so every chance
// hashed as `entry:undefined:unit:0` and every score collided; and it hashed
// JSON.stringify({sequence, winners}) instead of the canonical
// {algorithm, sequence, winners, alternates, plan}. Both made it report
// reconstructs:false and exit 1 on every sound draw — a second operator
// checking a genuine result got a hard integrity failure.
//
// The candidates come from the frozen snapshot, not from draw_candidates:
// draw_candidates has no weight column, so weightUnits (one entry = one chance,
// an approved multiplier = several) is only recoverable from snapshot_json.
// Usage: node scripts/reconstruct-draw.mjs <draw_id>
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { DRAW_ALGORITHM, sortition, selectWinners, outputHashOf, snapshotHashOf } from "../src/draw.mjs";

const drawId = process.argv[2];
if (!drawId) { console.error("usage: node scripts/reconstruct-draw.mjs <draw_id>"); process.exit(1); }

const cfg = loadConfig();
const db = openDb(cfg.database);
const d = db.prepare(`select * from draws where id=?`).get(drawId);
if (!d) { console.error("draw not found"); process.exit(1); }
if (!d.output_json || !d.seed_hex) { console.error(`draw ${d.id} has no result to reconstruct (status=${d.status}); the seed is withheld until execution`); process.exit(1); }
if (d.algorithm !== DRAW_ALGORITHM) { console.error(`draw ${d.id} used algorithm ${d.algorithm}; this build implements ${DRAW_ALGORITHM}`); process.exit(2); }

const snapshot = JSON.parse(d.snapshot_json || "{}");
const candidates = snapshot.candidates || [];
const ordered = sortition(candidates, d.seed_hex);
const { winners, alternates } = selectWinners(ordered, snapshot.plan);
// Exactly the object execute() hashes, in canonical JSON: anything else can
// never match output_hash even when the selection itself is reproduced.
const recomputed = { algorithm: DRAW_ALGORITHM, sequence: ordered.map((s) => s.entryId), winners, alternates, plan: snapshot.plan };
const outputHash = outputHashOf(recomputed);
const storedOutput = JSON.parse(d.output_json || "{}");
const storedHash = d.output_hash;

// The stored candidate rows must still agree with the snapshot that was hashed.
const rows = db.prepare(`select entry_id from draw_candidates where draw_id=? and status='eligible' order by position`).all(drawId).map((c) => c.entry_id);
const snapshotOk = snapshotHashOf(snapshot) === d.snapshot_hash;
const candidatesOk = JSON.stringify(rows) === JSON.stringify(candidates.map((c) => c.entryId));
const matches = outputHash === storedHash && snapshotOk && candidatesOk;

console.log(JSON.stringify({
  draw_id: d.id,
  algorithm: d.algorithm,
  status: d.status,
  candidate_count: candidates.length,
  seed_hex: d.seed_hex,
  snapshot_hash: d.snapshot_hash,
  snapshot_recomputes: snapshotOk,
  candidate_rows_match_snapshot: candidatesOk,
  recomputed_winners: recomputed.winners.map((w) => w.entryId),
  stored_winners: (storedOutput.winners || []).map((w) => w.entryId),
  stored_output_hash: storedHash,
  recomputed_output_hash: outputHash,
  reconstructs: matches,
}, null, 2));
process.exit(matches ? 0 : 1);
