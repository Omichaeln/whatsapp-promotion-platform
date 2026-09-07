// Independent draw reconstruction (spec 22 A-10, 23). Reads the frozen draw
// record + candidate snapshot + seed + algorithm and recomputes the output.
// A second operator can confirm the stored output_hash matches.
// Usage: npm run reconstruct-draw -- <draw_id>
import { openDb } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { DRAW_ALGORITHM, sortition } from "../src/draw.mjs";

const drawId = process.argv[2];
if (!drawId) { console.error("usage: npm run reconstruct-draw -- <draw_id>"); process.exit(1); }

const cfg = loadConfig();
const db = openDb(cfg.database);
const d = db.prepare(`select * from draws where id=?`).get(drawId);
if (!d) { console.error("draw not found"); process.exit(1); }

const candidates = db.prepare(`select * from draw_candidates where draw_id=? and status='eligible' order by position`).all(drawId);
const ordered = sortition(candidates.map((c) => c.entry_id), d.seed_hex);
const recomputed = {
  sequence: ordered,
  winners: ordered.map((entryId, i) => ({ position: i + 1, entryId })),
};
const crypto = await import("node:crypto");
const outputHash = crypto.createHash("sha256").update(JSON.stringify(recomputed)).digest().toString("hex");
const storedOutput = JSON.parse(d.output_json || "{}");
const storedHash = d.output_hash;

const matches = outputHash === storedHash;
console.log(JSON.stringify({
  draw_id: d.id,
  algorithm: d.algorithm,
  status: d.status,
  candidate_count: candidates.length,
  seed_hex: d.seed_hex,
  snapshot_hash: d.snapshot_hash,
  recomputed_winners: recomputed.winners.map((w) => w.entryId),
  stored_winners: (storedOutput.winners || []).map((w) => w.entryId),
  stored_output_hash: storedHash,
  recomputed_output_hash: outputHash,
  reconstructs: matches,
}, null, 2));
process.exit(matches ? 0 : 1);