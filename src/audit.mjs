import crypto from "node:crypto";
import { nowIso, id } from "./db.mjs";

/**
 * Single audit writer (spec §7.10, §13.4).
 *
 * Every audited action in the platform goes through ONE writer that reads the
 * chain head from the database and appends to it.
 *
 * Encoding: canonical JSON (sorted keys, no whitespace) of the body; entry
 * hash = sha256(prev_hash + body). `payload_json` stores exactly the encoded
 * body so a verifier recomputes the same bytes.
 *
 * The body covers ATTRIBUTION as well as the action (body version 2): who did
 * it, why, and the request/correlation it belongs to. Version 1 bodies covered
 * only { action, targetType, targetId, payload, when }, which left actor_id and
 * reason outside the hash — a database operator could rewrite who approved a
 * draw and the chain still verified. verify() re-reads both encodings, cross-
 * checks the v2 columns against the signed body, and counts any remaining v1
 * rows as `unattributed` so the weakness is visible instead of silent.
 *
 * Appending is safe when more than one process writes (the deployment may run a
 * standalone worker alongside the server): a UNIQUE index on prev_hash for v2
 * rows turns a lost read-modify-append race into a constraint failure, which is
 * retried against the new head. Without it, two connections could read the same
 * head and fork the chain, which verify() then reports as broken forever.
 *
 * A hash chain does not stop a privileged operator rewriting the WHOLE chain.
 * `checkpoint()` records an HMAC-signed head that can be kept outside the
 * database (exported in draw bundles and evidence exports).
 */

/** Body encoding version. Bump only with a matching branch in verify(). */
export const AUDIT_BODY_VERSION = 2;

/** Fields that live both in the signed body and in their own column (v2). */
const ATTRIBUTED_COLUMNS = [
  ["actorType", "actor_type"],
  ["actorId", "actor_id"],
  ["action", "action"],
  ["targetType", "target_type"],
  ["targetId", "target_id"],
  ["reason", "reason"],
  ["requestId", "request_id"],
  ["scope", "scope"],
  ["correlationId", "correlation_id"],
  ["when", "created_at"],
];

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const nullish = (v) => (v === undefined ? null : v);

export function createAudit(db, { checkpointKey = "", now = nowIso } = {}) {
  const head = db.prepare(`select entry_hash from audit_events order by id desc limit 1`);
  const insert = db.prepare(
    `insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id,
       prev_hash, entry_hash, payload_json, created_at, scope, correlation_id)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  function record({ actorType = "system", actorId = "system", action, targetType, targetId = null, reason = null, requestId = null, payload = null, scope = null, correlationId = null }) {
    if (!action || !targetType) throw new Error("audit: action and targetType are required");
    const when = now();
    const fields = { v: AUDIT_BODY_VERSION, action, actorType, actorId, targetType, targetId, reason, requestId, scope, correlationId, payload, when };
    // Read head -> append. A concurrent writer that won the race trips the
    // UNIQUE index on prev_hash; re-read the head and extend the real chain.
    for (let attempt = 0; ; attempt++) {
      const prev = head.get()?.entry_hash || "";
      const body = canonicalJson(fields);
      const entryHash = sha256(prev + body);
      try {
        const r = insert.run(actorType, actorId, action, targetType, targetId, reason, requestId, prev, entryHash, body, when, scope, correlationId);
        return { id: Number(r.lastInsertRowid), entryHash };
      } catch (e) {
        if (attempt >= 8 || !/UNIQUE constraint failed: audit_events\.prev_hash/i.test(String(e && e.message))) throw e;
      }
    }
  }

  /**
   * Verify the chain (or a range): linkage, body hashes, and — for v2 rows —
   * that the attribution columns still match the signed body.
   * Returns { ok, total, unattributed, broken[] }.
   */
  function verify({ fromId = 0 } = {}) {
    const rows = db.prepare(`select id, actor_type, actor_id, action, target_type, target_id, reason, request_id,
      scope, correlation_id, prev_hash, entry_hash, payload_json, created_at from audit_events where id > ? order by id`).all(fromId);
    let prev = fromId ? (db.prepare(`select entry_hash from audit_events where id = ?`).get(fromId)?.entry_hash || "") : "";
    const broken = [];
    let unattributed = 0;
    for (const r of rows) {
      if (r.prev_hash !== prev) broken.push({ id: r.id, what: "prev_mismatch" });
      if (r.entry_hash !== sha256((r.prev_hash || "") + String(r.payload_json || ""))) broken.push({ id: r.id, what: "entry_mismatch" });
      let body = null;
      try { body = JSON.parse(r.payload_json || "null"); } catch { broken.push({ id: r.id, what: "payload_unparseable" }); }
      if (body && typeof body === "object" && Number(body.v) >= 2) {
        for (const [field, column] of ATTRIBUTED_COLUMNS) {
          if (canonicalJson(nullish(body[field])) !== canonicalJson(nullish(r[column]))) broken.push({ id: r.id, what: `column_mismatch:${column}` });
        }
      } else unattributed += 1;
      prev = r.entry_hash;
    }
    return { ok: broken.length === 0, total: rows.length, unattributed, broken: broken.slice(0, 50), brokenCount: broken.length, head: prev };
  }

  /**
   * Sign the current head so it can be retained outside the database.
   *
   * With no AUDIT_CHECKPOINT_KEY there is NO SIGNATURE. It used to sign with the
   * literal fallback key "unsigned", which anyone who can rewrite the chain can
   * also recompute — and the independent verifier, run without a key, computed
   * the same value and reported "audit checkpoint signature: pass", positively
   * asserting that the one control designed to survive a privileged operator
   * rewriting the audit log was intact. An unsigned checkpoint now says so:
   * signature null (the column is NOT NULL, so the row keeps a self-describing
   * sentinel that cannot be mistaken for an HMAC) and signed:false, which a
   * verifier must fail on rather than recompute.
   */
  const UNSIGNED = "UNSIGNED: no AUDIT_CHECKPOINT_KEY was configured when this checkpoint was written";
  function checkpoint(actorId = "system") {
    const last = db.prepare(`select id, entry_hash from audit_events order by id desc limit 1`).get();
    if (!last) return null;
    const signature = checkpointKey ? crypto.createHmac("sha256", checkpointKey).update(`${last.id}|${last.entry_hash}`).digest("hex") : null;
    const cid = id("ckp");
    db.prepare(`insert into audit_checkpoints (id, upto_id, head_hash, signature, created_by, created_at) values (?,?,?,?,?,?)`)
      .run(cid, last.id, last.entry_hash, signature ?? UNSIGNED, actorId, now());
    return { id: cid, uptoId: last.id, headHash: last.entry_hash, signature, signed: !!checkpointKey };
  }

  /**
   * signatureOk is never true "by agreement on a publicly known fallback key":
   * with no configured key, or against a checkpoint that carries no HMAC, there
   * is nothing to check and the answer is false. (The return shape is left
   * alone — callers deep-equal it — so a caller that needs to tell "unsigned"
   * from "forged" reads `signed` on the checkpoint itself.)
   */
  function verifyCheckpoint(ckp) {
    const given = String(ckp?.signature || "");
    const verifiable = !!checkpointKey && /^[0-9a-f]{64}$/.test(given);
    const expected = verifiable ? crypto.createHmac("sha256", checkpointKey).update(`${ckp.uptoId ?? ckp.upto_id}|${ckp.headHash ?? ckp.head_hash}`).digest("hex") : null;
    const signatureOk = verifiable && expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    const row = db.prepare(`select entry_hash from audit_events where id = ?`).get(ckp.uptoId ?? ckp.upto_id);
    return { signatureOk, headMatches: row?.entry_hash === (ckp.headHash ?? ckp.head_hash) };
  }

  return { record, verify, checkpoint, verifyCheckpoint };
}
