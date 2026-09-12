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
// `rules_version` names the version ACTIVE AT FREEZE; the versions the entries
// were actually judged under are listed separately. Check the disclosure is
// complete so it cannot be trimmed to hide a rules change mid-period.
if (Array.isArray(snap.candidateRulesVersions)) {
  ok("disclosed candidate rules versions cover every candidate", snap.candidateRulesVersions.reduce((a, v) => a + Number(v.entries || 0), 0) === snap.candidates.length,
    snap.candidateRulesVersions.map((v) => `${v.configHash || "none"}:${v.entries}`).join(", ") || "none");
}
if (d.status === "frozen") { ok("no result yet (frozen)", b.output == null && b.seed_hex == null, "randomness withheld until execution"); }
else {
  ok("seed present", typeof b.seed_hex === "string" && b.seed_hex.length >= 32);
  // The seed must match a commitment made BEFORE any result existed, otherwise
  // an operator could re-roll the draw until it produced the winners they
  // wanted and every self-consistent hash here would still agree.
  if (d.seed_commitment) {
    ok("seed matches the commitment made at freeze", sha(b.seed_hex) === d.seed_commitment, d.seed_commitment);
  } else {
    ok("seed was committed at freeze", false, "no seed_commitment in this bundle: the randomness was not pinned before the result, so a swapped seed cannot be ruled out");
  }
  const ordered = sortition(snap.candidates, b.seed_hex);
  const sel = select(ordered, snap.plan);
  const recomputed = { algorithm: d.algorithm, sequence: ordered.map((s) => s.entryId), winners: sel.winners, alternates: sel.alternates, plan: snap.plan };
  ok("output digest", sha(canon(recomputed)) === d.output_hash, d.output_hash);
  ok("stored output equals recomputation", JSON.stringify(recomputed) === JSON.stringify(b.output));
  // `winners.length === Math.min(totalWinners, winners.length)` was a tautology:
  // it held for ANY winner count, so a draw run against an empty prize plan
  // (0 winners) verified clean while awarding nobody. A short draw is still
  // legitimate — freeze() accepts an override on INSUFFICIENT_CANDIDATES — so
  // the bound is "at most the plan, and the plan awards at least one prize".
  ok("winner count within a plan that awards prizes", snap.plan.totalWinners > 0 && sel.winners.length <= snap.plan.totalWinners && (b.output?.winners?.length ?? -1) === sel.winners.length, `${sel.winners.length}/${snap.plan.totalWinners}`);
  if (snap.plan.totalWinners > 0 && sel.winners.length < snap.plan.totalWinners) {
    const bar = d.barrier || {};
    ok("fewer winners than planned (short candidate pool — informational)", true, JSON.stringify({ blockers: (bar.blockers || []).map((x) => x.code), overridden: bar.overridden ?? null }));
  }
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
// Tie the bundle's headline hashes to what the hash-chained audit events
// recorded at the time. Without this the bundle is only self-consistent: every
// digest agrees with every other digest in the same file.
const signedPayload = (action) => { const e = events.filter((x) => x.action === action).pop(); if (!e) return null; try { return JSON.parse(e.payload_json); } catch { return null; } };
const frozen = signedPayload("draw.frozen"), executed = signedPayload("draw.executed");
if (frozen) {
  ok("snapshot digest matches the signed freeze event", frozen.payload?.snapshotHash === d.snapshot_hash || frozen.snapshotHash === d.snapshot_hash, d.snapshot_hash);
  const committed = frozen.payload?.seedCommitment ?? frozen.seedCommitment ?? null;
  ok("seed commitment matches the signed freeze event", !d.seed_commitment || committed === d.seed_commitment,
    committed ? "recorded before any result existed" : "the freeze event carries no seed commitment");
}
if (executed && d.output_hash) {
  ok("output digest matches the signed execute event", (executed.payload?.outputHash ?? executed.outputHash) === d.output_hash, d.output_hash);
}
// The required actions depend on the STATUS. Demanding draw.executed for every
// bundle made a frozen draw — the pre-commitment evidence, deliberately
// exported with the randomness withheld — always report FAILED.
const NEEDED = { frozen: ["draw.frozen"], executing: ["draw.frozen"], executed: ["draw.frozen", "draw.executed"],
  approved: ["draw.frozen", "draw.executed", "draw.approved"], published: ["draw.frozen", "draw.executed", "draw.approved"] };
const need = NEEDED[d.status] || ["draw.frozen"];
const missing = need.filter((a) => !events.some((e) => e.action === a));
ok(`audit trail has ${need.map((a) => a.replace("draw.", "")).join("+")}`, missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `status ${d.status}`);
if (d.status === "voided") ok("voided draw records why", events.some((e) => ["draw.voided", "draw.rejected"].includes(e.action)));
if (["approved", "published"].includes(d.status)) {
  // Separation of duties proven from the signed audit body, not from the draw row.
  const approvals = events.filter((e) => e.action === "draw.approved").map((e) => { try { return JSON.parse(e.payload_json); } catch { return null; } }).filter(Boolean);
  const signedApprover = approvals.length ? (approvals[approvals.length - 1].actorId ?? null) : null;
  // No escape for legacy bodies: a bundle whose approval carries no signed
  // attribution cannot prove who approved the draw, which is the whole point.
  ok("approval is attributable in the signed chain", !!signedApprover, signedApprover || "no signed approval event (v1 body: attribution is outside the hash)");
  if (signedApprover) {
    ok("signed approver matches the draw record", signedApprover === d.approver_id, `${signedApprover} / ${d.approver_id}`);
    ok("signed approver differs from the operator", signedApprover !== d.operator_id, `${d.operator_id} / ${signedApprover}`);
    // Freeze chooses the candidate pool and waives barriers; execution is
    // deterministic. An approver who also froze the pool is not a second pair
    // of eyes, and the draw row alone never showed who froze it.
    const signedFreezer = frozen ? (frozen.actorId ?? null) : null;
    if (signedFreezer) ok("signed approver differs from the user who froze the pool", signedApprover !== signedFreezer, `${signedFreezer} / ${signedApprover}`);
  }
}
// A "#n" label means earlier draws for this period were discarded. They must be
// disclosed, otherwise a re-rolled draw looks like a first and only draw.
const seq = /#(\d+)$/.exec(String(d.draw_label || ""));
if (seq) {
  const others = (b.period_draws || []).filter((x) => x.id !== d.id);
  ok("replacement draw discloses its predecessors", others.length >= Number(seq[1]) - 1,
    `${others.length} predecessor(s) disclosed for ${d.draw_label}; supersedes ${d.supersedes || "(none)"}`);
}
if (b.audit_checkpoint) {
  const expected = crypto.createHmac("sha256", checkpointKey || "unsigned").update(`${b.audit_checkpoint.uptoId}|${b.audit_checkpoint.headHash}`).digest("hex");
  ok("audit checkpoint signature", expected === b.audit_checkpoint.signature, checkpointKey ? "keyed" : "unsigned key (set --checkpoint-key)");
}
// Every hash above is unkeyed: entry_hash = sha256(prev + body) is recomputable
// by anyone, so editing an event body and rewriting its hash left the whole
// bundle self-consistent and "verified". The anchor is the only thing here that
// an editor cannot forge: the export commits the exported events' hashes to the
// chain as `draw.bundle_exported`, and the HMAC-signed checkpoint covers that
// event's own hash through the exported tail. With a key supplied, an
// unanchored bundle proves nothing about who did what and must NOT pass.
if (checkpointKey) {
  const a = b.audit_anchor, ckp = b.audit_checkpoint;
  const tail = a?.chain_tail || [];
  let anchorOk = !!(a && ckp && tail.length), why = a ? "" : "no audit anchor in this bundle: the exported events are not tied to the signed checkpoint";
  if (anchorOk) {
    for (const [i, e] of tail.entries()) {
      if (sha((e.prev_hash || "") + String(e.payload_json)) !== e.entry_hash) { anchorOk = false; why = `anchor event ${e.id} does not recompute`; break; }
      if (i > 0 && e.prev_hash !== tail[i - 1].entry_hash) { anchorOk = false; why = `anchor chain breaks at event ${e.id}`; break; }
    }
  }
  const last = tail[tail.length - 1];
  if (anchorOk && (last.entry_hash !== ckp.headHash || Number(last.id) !== Number(ckp.uptoId))) { anchorOk = false; why = "the anchor chain does not end at the signed checkpoint head"; }
  let man = null;
  if (anchorOk) {
    try { man = JSON.parse(tail[0].payload_json); } catch { /* reported below */ }
    if (!man || man.action !== "draw.bundle_exported" || man.targetId !== d.id || Number(tail[0].id) !== Number(a.manifest_event_id)) { anchorOk = false; why = "the anchor does not start at this draw's export manifest"; }
  }
  if (anchorOk) {
    const listed = (man.payload?.events || []).map((e) => `${e.id}:${e.entryHash}`).sort();
    const exported = events.map((e) => `${e.id}:${e.entry_hash}`).sort();
    if (JSON.stringify(listed) !== JSON.stringify(exported)) { anchorOk = false; why = "the exported audit events differ from the set committed to the signed chain"; }
    if (anchorOk && (man.payload?.snapshotHash !== d.snapshot_hash || (man.payload?.outputHash ?? null) !== (d.output_hash ?? null))) { anchorOk = false; why = "the draw digests differ from those committed to the signed chain"; }
  }
  ok("audit events anchored to the signed checkpoint", anchorOk, anchorOk ? `${events.length} event(s) committed before the head was signed` : why);
}
const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ draw: d.id, status: d.status, verified: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
