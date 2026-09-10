import crypto from "node:crypto";
import { nowIso, id } from "./db.mjs";

/**
 * Single audit writer (spec §7.10, §13.4).
 *
 * Every audited action in the platform goes through ONE writer that reads the
 * chain head from the database inside the caller's transaction. SQLite is a
 * single-writer database, so the read-modify-append sequence is serialised
 * by the connection; there is no in-memory head cache (the previous
 * implementation kept one per writer, which broke the chain whenever two
 * writers interleaved — observed in the pre-build smoke run).
 *
 * Encoding: canonical JSON (sorted keys, no whitespace) of the body; entry
 * hash = sha256(prev_hash + body). `payload_json` stores exactly the encoded
 * body so a verifier recomputes the same bytes.
 *
 * A hash chain does not stop a privileged database operator rewriting the
 * whole chain. `checkpoint()` records an HMAC-signed head that can be kept
 * outside the database (exported in draw bundles and evidence exports).
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function createAudit(db, { checkpointKey = "", now = nowIso } = {}) {
  const head = db.prepare(`select entry_hash from audit_events order by id desc limit 1`);
  const insert = db.prepare(
    `insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id,
       prev_hash, entry_hash, payload_json, created_at, scope, correlation_id)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  function record({ actorType = "system", actorId = "system", action, targetType, targetId = null, reason = null, requestId = null, payload = null, scope = null, correlationId = null }) {
    if (!action || !targetType) throw new Error("audit: action and targetType are required");
    const when = now();
    const body = canonicalJson({ action, targetType, targetId, payload, when });
    const prev = head.get()?.entry_hash || "";
    const entryHash = sha256(prev + body);
    const r = insert.run(actorType, actorId, action, targetType, targetId, reason, requestId, prev, entryHash, body, when, scope, correlationId);
    return { id: Number(r.lastInsertRowid), entryHash };
  }

  /** Verify the whole chain (or a range). Returns { ok, total, broken[] }. */
  function verify({ fromId = 0 } = {}) {
    const rows = db.prepare(`select id, prev_hash, entry_hash, payload_json from audit_events where id > ? order by id`).all(fromId);
    let prev = fromId ? (db.prepare(`select entry_hash from audit_events where id = ?`).get(fromId)?.entry_hash || "") : "";
    const broken = [];
    for (const r of rows) {
      if (r.prev_hash !== prev) broken.push({ id: r.id, what: "prev_mismatch" });
      if (r.entry_hash !== sha256((r.prev_hash || "") + String(r.payload_json || ""))) broken.push({ id: r.id, what: "entry_mismatch" });
      prev = r.entry_hash;
    }
    return { ok: broken.length === 0, total: rows.length, broken: broken.slice(0, 50), brokenCount: broken.length, head: prev };
  }

  /** Sign the current head so it can be retained outside the database. */
  function checkpoint(actorId = "system") {
    const last = db.prepare(`select id, entry_hash from audit_events order by id desc limit 1`).get();
    if (!last) return null;
    const signature = crypto.createHmac("sha256", checkpointKey || "unsigned").update(`${last.id}|${last.entry_hash}`).digest("hex");
    const cid = id("ckp");
    db.prepare(`insert into audit_checkpoints (id, upto_id, head_hash, signature, created_by, created_at) values (?,?,?,?,?,?)`)
      .run(cid, last.id, last.entry_hash, signature, actorId, now());
    return { id: cid, uptoId: last.id, headHash: last.entry_hash, signature, signed: !!checkpointKey };
  }

  function verifyCheckpoint(ckp) {
    const expected = crypto.createHmac("sha256", checkpointKey || "unsigned").update(`${ckp.uptoId ?? ckp.upto_id}|${ckp.headHash ?? ckp.head_hash}`).digest("hex");
    const row = db.prepare(`select entry_hash from audit_events where id = ?`).get(ckp.uptoId ?? ckp.upto_id);
    return { signatureOk: expected === ckp.signature, headMatches: row?.entry_hash === (ckp.headHash ?? ckp.head_hash) };
  }

  return { record, verify, checkpoint, verifyCheckpoint };
}
