// Independent draw verifier (spec §14). Consumes an exported audit bundle
// (JSON file) and recomputes everything WITHOUT the database or the live draw
// service: snapshot digest, HMAC sortition from the committed seed, prize plan
// application, output digest, prize/alternate counts, separation of duties,
// audit chain continuity for the draw's events and (optionally) the signed
// checkpoint. Exit 0 = verified, 1 = failed.
// Usage: node scripts/verify-draw-bundle.mjs <bundle.json> [--checkpoint-key <key>]
import fs from "node:fs";
import crypto from "node:crypto";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/verify-draw-bundle.mjs <bundle.json> [--checkpoint-key KEY]"); process.exit(2); }
const ki = process.argv.indexOf("--checkpoint-key");
const checkpointKey = ki > 0 ? process.argv[ki + 1] : process.env.AUDIT_CHECKPOINT_KEY || "";
const b = JSON.parse(fs.readFileSync(file, "utf8"));

// --- pure re-implementations (kept independent of src/draw.mjs on purpose) ---
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v === undefined ? null : v);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function sortition(candidates, seedHex) {
  const key = Buffer.from(seedHex, "hex"); const out = [];
  for (const c of candidates) for (let u = 0; u < Math.max(1, Number(c.weightUnits || 1)); u++) out.push({ entryId: c.entryId, participantId: c.participantId, score: crypto.createHmac("sha256", key).update(`entry:${c.entryId}:unit:${u}`).digest("hex") });
  return out.sort((a, b2) => (a.score < b2.score ? -1 : a.score > b2.score ? 1 : a.entryId < b2.entryId ? -1 : 1));
}
function prizeCode(rank, plan) { let c = 0; for (const t of plan.tiers) { c += Number(t.count) || 0; if (rank <= c) return t.code; } return plan.tiers.at(-1)?.code || "P1"; }
function select(ordered, plan) {
  const winners = [], alternates = [], seenP = new Set(), seenE = new Set();
  for (const s of ordered) {
    if (seenE.has(s.entryId)) continue; if (plan.onePrizePerParticipant && seenP.has(s.participantId)) continue;
    seenE.add(s.entryId); seenP.add(s.participantId);
    if (winners.length < plan.totalWinners) winners.push({ position: winners.length + 1, entryId: s.entryId, participantId: s.participantId, prize_code: prizeCode(winners.length + 1, plan) });
    else if (alternates.length < plan.totalAlternates) alternates.push({ position: alternates.length + 1, entryId: s.entryId, participantId: s.participantId });
    else break;
  }
  return { winners, alternates };
}

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const snap = b.snapshot, d = b.draw;
ok("bundle version", b.bundle_version === "draw-verifier/2", b.bundle_version);
ok("snapshot digest", sha(canon(snap)) === d.snapshot_hash, d.snapshot_hash);
ok("snapshot names this draw", snap.drawId === d.id && snap.periodCode === d.period);
ok("candidates unique", new Set(snap.candidates.map((c) => c.entryId)).size === snap.candidates.length, snap.candidates.length);
if (d.status === "frozen") { ok("no result yet (frozen)", b.output == null && b.seed_hex == null, "randomness withheld until execution"); }
else {
  ok("seed present", typeof b.seed_hex === "string" && b.seed_hex.length >= 32);
  const ordered = sortition(snap.candidates, b.seed_hex);
  const sel = select(ordered, snap.plan);
  const recomputed = { algorithm: d.algorithm, sequence: ordered.map((s) => s.entryId), winners: sel.winners, alternates: sel.alternates, plan: snap.plan };
  ok("output digest", sha(canon(recomputed)) === d.output_hash, d.output_hash);
  ok("stored output equals recomputation", JSON.stringify(recomputed) === JSON.stringify(b.output));
  ok("winner count matches plan", sel.winners.length === Math.min(snap.plan.totalWinners, sel.winners.length) && (b.output?.winners?.length ?? -1) === sel.winners.length, `${sel.winners.length}/${snap.plan.totalWinners}`);
  ok("alternate count within plan", (b.output?.alternates?.length ?? 0) <= snap.plan.totalAlternates);
  ok("winners are eligible candidates", sel.winners.every((w) => snap.candidates.some((c) => c.entryId === w.entryId)));
  ok("one prize per participant", !snap.plan.onePrizePerParticipant || new Set(sel.winners.map((w) => w.participantId)).size === sel.winners.length);
  ok("prize codes valid", sel.winners.every((w) => snap.plan.tiers.some((t) => t.code === w.prize_code)));
}
if (["approved", "published"].includes(d.status)) {
  ok("approver recorded", !!d.approver_id);
  ok("approver differs from operator", d.approver_id && d.approver_id !== d.operator_id, `${d.operator_id} / ${d.approver_id}`);
  ok("approval after execution", Date.parse(d.approved_at) >= Date.parse(d.executed_at));
}
// Audit chain continuity among the draw's events: each event hash recomputes
// from prev + the signed body, and — for version 2 bodies — the columns a
// reader would display must still match what was signed. Without the second
// check, "who approved this draw" is a mutable column outside the hash.
const events = b.audit_events || [];
const COLS = [["actorType", "actor_type"], ["actorId", "actor_id"], ["action", "action"], ["targetType", "target_type"],
  ["targetId", "target_id"], ["reason", "reason"], ["requestId", "request_id"], ["scope", "scope"],
  ["correlationId", "correlation_id"], ["when", "created_at"]];
let chainOk = true, attributionOk = true, unattributed = 0;
for (const e of events) {
  if (sha((e.prev_hash || "") + String(e.payload_json)) !== e.entry_hash) chainOk = false;
  let body = null; try { body = JSON.parse(e.payload_json); } catch { chainOk = false; }
  if (body && Number(body.v) >= 2) {
    for (const [f, c] of COLS) {
      if (!(c in e)) continue;                     // column not exported in this bundle
      const a = body[f] === undefined ? null : body[f], bb = e[c] === undefined ? null : e[c];
      if (canon(a) !== canon(bb)) attributionOk = false;
    }
  } else unattributed += 1;
}
ok("draw audit events recompute", chainOk, events.length);
ok("audit event attribution matches the signed body", attributionOk, unattributed ? `${unattributed} legacy event(s) carry no signed attribution` : "all events signed with attribution");
ok("audit trail has freeze+execute(+approve)", ["draw.frozen", "draw.executed"].every((a) => events.some((e) => e.action === a)) && (d.status === "executed" || events.some((e) => e.action === "draw.approved") || d.status === "frozen"));
if (["approved", "published"].includes(d.status)) {
  // Separation of duties proven from the signed audit body, not from the draw row.
  const approvals = events.filter((e) => e.action === "draw.approved").map((e) => { try { return JSON.parse(e.payload_json); } catch { return null; } }).filter(Boolean);
  const signedApprover = approvals.length ? (approvals[approvals.length - 1].actorId ?? null) : null;
  ok("approval is attributable in the signed chain", !!signedApprover || unattributed > 0, signedApprover || "no signed approval event");
  if (signedApprover) {
    ok("signed approver matches the draw record", signedApprover === d.approver_id, `${signedApprover} / ${d.approver_id}`);
    ok("signed approver differs from the operator", signedApprover !== d.operator_id, `${d.operator_id} / ${signedApprover}`);
  }
}
if (b.audit_checkpoint) {
  const expected = crypto.createHmac("sha256", checkpointKey || "unsigned").update(`${b.audit_checkpoint.uptoId}|${b.audit_checkpoint.headHash}`).digest("hex");
  ok("audit checkpoint signature", expected === b.audit_checkpoint.signature, checkpointKey ? "keyed" : "unsigned key (set --checkpoint-key)");
}
const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ draw: d.id, status: d.status, verified: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
