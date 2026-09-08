import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, seedCampaign } from "./helpers.mjs";
import { sha256hex } from "../src/db.mjs";

describe("audit chain integrity (P0-08)", () => {
  it("every audit row chains prev_hash -> entry_hash = sha256(prev||payload)", () => {
    const ctx = buildTestApp();
    seedCampaign(ctx); // emits several audited events
    const rows = ctx.db.prepare(`select id, prev_hash, entry_hash, payload_json from audit_events order by id`).all();
    assert.ok(rows.length >= 2, "seed produces audit events");
    let prev = "";
    for (const r of rows) {
      assert.equal(r.prev_hash, prev, `row ${r.id} prev must equal previous entry_hash`);
      assert.equal(r.entry_hash, sha256hex((r.prev_hash || "") + String(r.payload_json || "")), `row ${r.id} entry_hash recomputes`);
      prev = r.entry_hash;
    }
  });

  it("repair re-links a chain broken by an empty-hash row (regression for the export bug)", () => {
    const ctx = buildTestApp();
    seedCampaign(ctx);
    // simulate the old export bug: insert a row with empty prev_hash/entry_hash
    const brokenBody = JSON.stringify({ action: "export", targetType: "report", targetId: "members", payload: null, when: "2026-09-08T00:00:00Z" });
    ctx.db.prepare(`insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id, prev_hash, entry_hash, payload_json, created_at)
      values ('admin','adm_x','export','report','members',null,null,'','',?,'2026-09-08T00:00:00Z')`).run(brokenBody);
    // an event AFTER the break (would normally chain off the broken empty hash)
    const camp = ctx.domain.listCampaigns()[0];
    ctx.domain.setCampaignStatus(camp.id, "paused", "test");

    const rows = ctx.db.prepare(`select id, prev_hash, entry_hash, payload_json from audit_events order by id`).all();
    const brokenIdx = rows.findIndex((r) => r.payload_json.includes('"report"'));
    assert.ok(brokenIdx >= 0);
    assert.equal(rows[brokenIdx].prev_hash, "", "the broken row has empty prev");
    // chain is broken at this point
    const next = rows[brokenIdx + 1];
    assert.notEqual(next.prev_hash, rows[brokenIdx].entry_hash);

    // re-link from the broken row forward (same logic as /api/audit/repair)
    let prev = rows[brokenIdx - 1]?.entry_hash || "";
    const upd = ctx.db.prepare(`update audit_events set prev_hash=?, entry_hash=? where id=?`);
    for (let i = brokenIdx; i < rows.length; i++) {
      const r = rows[i];
      const h = sha256hex(prev + String(r.payload_json || ""));
      upd.run(prev, h, r.id);
      prev = h;
    }
    // verify the whole chain again
    const after = ctx.db.prepare(`select prev_hash, entry_hash, payload_json from audit_events order by id`).all();
    let p = "";
    for (const r of after) {
      assert.equal(r.prev_hash, p);
      assert.equal(r.entry_hash, sha256hex((r.prev_hash || "") + String(r.payload_json || "")));
      p = r.entry_hash;
    }
  });
});