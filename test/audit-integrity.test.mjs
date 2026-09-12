// Audit chain integrity: the properties an auditor actually relies on.
// A hash chain that does not cover WHO acted, or that forks when a second
// process writes, proves nothing — both were live defects before this suite.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, createAudit, sha256, AUDIT_BODY_VERSION } from "../src/audit.mjs";
import { openDb, migrate } from "../src/db.mjs";

describe("audit chain integrity", () => {
  let h;
  before(async () => { h = await buildApp({ extractor: "simulator" }); });
  after(async () => { await h.close(); });

  it("covers WHO acted and WHY: rewriting actor or reason breaks verification", () => {
    const audit = h.app.domain.auditService;
    h.app.domain.audit({ actorType: "admin", actorId: "usr_alice", action: "draw.approved", targetType: "draw", targetId: "drw_integrity", reason: "checked the output hash", payload: { outputHash: "abc" } });
    assert.equal(audit.verify().ok, true, "clean chain verifies");
    const row = h.db.prepare(`select id from audit_events where target_id='drw_integrity'`).get();

    h.db.prepare(`update audit_events set actor_id='usr_mallory' where id=?`).run(row.id);
    let v = audit.verify();
    assert.equal(v.ok, false, "rewriting the actor must be detected");
    assert.ok(v.broken.some((b) => b.id === row.id && b.what === "column_mismatch:actor_id"), JSON.stringify(v.broken));
    h.db.prepare(`update audit_events set actor_id='usr_alice' where id=?`).run(row.id);
    assert.equal(audit.verify().ok, true, "restoring the actor restores verification");

    h.db.prepare(`update audit_events set reason='no reason given' where id=?`).run(row.id);
    assert.ok(audit.verify().broken.some((b) => b.what === "column_mismatch:reason"), "rewriting the reason must be detected");
    h.db.prepare(`update audit_events set reason='checked the output hash' where id=?`).run(row.id);

    const when = h.db.prepare(`select created_at from audit_events where id=?`).get(row.id).created_at;
    h.db.prepare(`update audit_events set created_at='1999-01-01T00:00:00.000Z' where id=?`).run(row.id);
    assert.ok(audit.verify().broken.some((b) => b.what === "column_mismatch:created_at"), "back-dating an event must be detected");
    h.db.prepare(`update audit_events set created_at=? where id=?`).run(when, row.id);
    assert.equal(audit.verify().ok, true, "chain left clean for the next test");
  });

  it("still detects payload tampering, deletion and reordering", () => {
    const audit = h.app.domain.auditService;
    for (const t of ["a", "b", "c"]) h.app.domain.audit({ actorType: "system", actorId: "sys", action: "entry.awarded", targetType: "entry", targetId: `ent_${t}`, payload: { t } });
    const ids = h.db.prepare(`select id from audit_events where target_id like 'ent_%' order by id`).all().map((r) => r.id);
    assert.equal(h.app.domain.auditService.verify({ fromId: ids[0] - 1 }).ok, true);

    h.db.prepare(`update audit_events set payload_json=replace(payload_json,'"t":"b"','"t":"Z"') where id=?`).run(ids[1]);
    assert.ok(audit.verify().broken.some((b) => b.id === ids[1] && b.what === "entry_mismatch"), "payload tampering detected");
    h.db.prepare(`update audit_events set payload_json=replace(payload_json,'"t":"Z"','"t":"b"') where id=?`).run(ids[1]);

    const saved = h.db.prepare(`select * from audit_events where id=?`).get(ids[1]);
    h.db.prepare(`delete from audit_events where id=?`).run(ids[1]);
    assert.ok(audit.verify().broken.some((b) => b.what === "prev_mismatch"), "deleting a middle row detected");
    h.db.prepare(`insert into audit_events (id, actor_type, actor_id, action, target_type, target_id, reason, request_id, prev_hash, entry_hash, payload_json, created_at, scope, correlation_id)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(saved.id, saved.actor_type, saved.actor_id, saved.action, saved.target_type, saved.target_id, saved.reason, saved.request_id, saved.prev_hash, saved.entry_hash, saved.payload_json, saved.created_at, saved.scope, saved.correlation_id);
    assert.equal(audit.verify().ok, true, "restored chain verifies");
  });

  it("a second writer cannot fork the chain (server + standalone worker)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-chain-"));
    const file = path.join(dir, "chain.db");
    const a = openDb(file); migrate(a, undefined, null);
    const b = openDb(file);                                   // a second process's connection
    const auditA = createAudit(a), auditB = createAudit(b);
    for (let i = 0; i < 25; i++) {                            // interleaved appends
      auditA.record({ actorId: "server", action: "job.tick", targetType: "job", targetId: `a${i}`, payload: { i } });
      auditB.record({ actorId: "worker", action: "job.tick", targetType: "job", targetId: `b${i}`, payload: { i } });
    }
    const v = createAudit(a).verify();
    assert.equal(v.ok, true, `chain forked across connections: ${JSON.stringify(v.broken)}`);
    assert.equal(v.total, 50);
    assert.equal(v.unattributed, 0, "every row carries signed attribution");
    a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it("canonical encoding is stable, so a verifier recomputes the same bytes", () => {
    const payload = { z: 1, a: { nested: [3, 2, 1], "ünï": "çödé" }, n: null, f: 1.5, empty: {} };
    const once = canonicalJson({ v: AUDIT_BODY_VERSION, payload });
    const twice = canonicalJson(JSON.parse(JSON.stringify({ v: AUDIT_BODY_VERSION, payload })));
    assert.equal(once, twice);
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }), "key order must not matter");
    assert.equal(canonicalJson(undefined), "null");
    assert.equal(sha256("") .length, 64);
  });

  it("the signed checkpoint detects a forged signature and a moved head", () => {
    const audit = h.app.domain.auditService;
    const ckp = audit.checkpoint("usr_auditor");
    assert.equal(audit.verifyCheckpoint(ckp).signatureOk, true);
    assert.equal(audit.verifyCheckpoint(ckp).headMatches, true);
    assert.equal(audit.verifyCheckpoint({ ...ckp, signature: "0".repeat(64) }).signatureOk, false, "forged signature rejected");
    assert.equal(audit.verifyCheckpoint({ ...ckp, signature: "short" }).signatureOk, false, "malformed signature rejected, not a crash");
    h.app.domain.audit({ actorType: "system", actorId: "sys", action: "entry.awarded", targetType: "entry", targetId: "ent_after_ckp", payload: {} });
    assert.equal(audit.verifyCheckpoint(ckp).headMatches, true, "checkpoint still pins the head it signed");
  });

});
