// Regression tests for the adjudicated "domain" audit package:
//   crosscut-5 / requirements-7  outlet + product master edits write no audit row
//   privacy-3                    anonymisation leaves the phone, the ID and the winner name behind
//   authz-2                      POST /api/mfa/enroll silently disables MFA
//   schema-5 / schema-6          migrate(): racing migrators, stale schema_version ledger
//   schema-4 / schema-7          duplicate-detection and draw-barrier indexes
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApp, before, after, describe, it, assert } from "./helpers.mjs";
import { openDb, migrate } from "../src/db.mjs";
import { totp } from "../src/mfa.mjs";

/** Every text value stored anywhere in the database (used to prove erasure). */
function scanForString(db, needle) {
  const hits = [];
  const tables = db.prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%'`).all();
  for (const { name } of tables) {
    const cols = db.prepare(`pragma table_info(${name})`).all().map((c) => c.name);
    if (!cols.length) continue;
    const where = cols.map((c) => `coalesce(cast("${c}" as text),'') like ?`).join(" or ");
    const rows = db.prepare(`select * from "${name}" where ${where}`).all(...cols.map(() => `%${needle}%`));
    for (const r of rows) hits.push({ table: name, row: r });
  }
  return hits;
}

describe("domain fixes", () => {
  let h, admin;
  before(async () => { h = await buildApp(); admin = await h.login("admin@x.test", "TestAdminPassword123"); });
  after(async () => { await h.close(); });

  // ---- crosscut-5 / requirements-7 -------------------------------------------------
  it("outlet master edits write an audit row naming the actor and the before/after", async () => {
    const outlet = h.domain.listOutlets()[0];
    const before = h.db.prepare(`select count(*) n from audit_events where action='outlet.upsert'`).get().n;
    h.domain.upsertOutlet({ outlet_code: outlet.outlet_code, retailer: outlet.retailer, branch: "RENAMED", town: outlet.town, active: 0, aliases: [] }, "adm_tester");
    const rows = h.db.prepare(`select * from audit_events where action='outlet.upsert' order by id desc`).all();
    assert.equal(rows.length, before + 1, "one audit row per outlet change");
    const row = rows[0];
    assert.equal(row.actor_id, "adm_tester");
    assert.equal(row.target_type, "outlet");
    const payload = JSON.parse(row.payload_json).payload;
    assert.equal(payload.before.active, 1, "before-image records that the outlet was active");
    assert.equal(payload.after.active, 0, "after-image records the deactivation");
    assert.equal(payload.after.branch, "RENAMED");
    assert.ok(payload.changed.includes("active"), "the changed field list names active");
  });

  it("POST /api/outlets attributes the audit row to the signed-in campaign manager", async () => {
    const token = await h.staffToken("manager@example.test");
    const outlet = h.domain.listOutlets()[1];
    const r = await h.api("/api/outlets", { method: "POST", token, body: { outlet_code: outlet.outlet_code, retailer: outlet.retailer, branch: outlet.branch, town: outlet.town, collection_enabled: 0 } });
    assert.equal(r.status, 201);
    const me = h.app.auth.listUsers().find((u) => u.email === "manager@example.test");
    const row = h.db.prepare(`select * from audit_events where action='outlet.upsert' and target_id=? order by id desc limit 1`).get(outlet.id);
    assert.ok(row, "the route's edit is audited");
    assert.equal(row.actor_id, me.id);
  });

  it("product master edits write an audit row with the previous row", () => {
    h.domain.upsertProduct({ sku: "FIX-DOM-1", name: "Fixture Sugar 2kg", pack_grams: 2000 }, "adm_tester");
    h.domain.upsertProduct({ sku: "FIX-DOM-1", name: "Fixture Sugar 1kg", pack_grams: 1000 }, "adm_tester");
    const rows = h.db.prepare(`select * from audit_events where action='product.upsert' and target_id='prod_FIX-DOM-1' order by id`).all();
    assert.equal(rows.length, 2, "creation and change are both audited");
    const p = JSON.parse(rows[1].payload_json).payload;
    assert.equal(p.before.pack_grams, 2000);
    assert.equal(p.after.pack_grams, 1000);
    assert.equal(rows[1].actor_id, "adm_tester");
  });

  it("a no-op upsert writes no audit row", () => {
    const outlet = h.domain.listOutlets()[2];
    const same = { outlet_code: outlet.outlet_code, retailer: outlet.retailer, branch: outlet.branch, town: outlet.town, province: outlet.province, collection_enabled: outlet.collection_enabled, active: outlet.active, aliases: JSON.parse(outlet.aliases_json || "[]"), retailer_code: outlet.retailer_code, active_from: outlet.active_from, active_to: outlet.active_to };
    const before = h.db.prepare(`select count(*) n from audit_events`).get().n;
    h.domain.upsertOutlet(same, "adm_tester");
    assert.equal(h.db.prepare(`select count(*) n from audit_events`).get().n, before);
  });

  // ---- privacy-3 -------------------------------------------------------------------
  it("anonymisation erases the phone, the conversation and the national ID everywhere", async () => {
    const phone = "263779900301";
    const identity = "ZZERASE7711X";
    await h.register(phone, { first: "Tarisai", last: "Moyo", identity, town: "Mutare" });
    const p = h.domain.getParticipantByPhone(phone);
    assert.ok(h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(phone).n > 0, "precondition: inbound events exist");
    assert.ok(h.db.prepare(`select count(*) n from outbound_messages where wa_phone_uid=?`).get(phone).n > 0, "precondition: outbound replies exist");

    // an unrelated participant must be untouched by the scrub
    const other = "263779900302";
    await h.register(other, { first: "Kuda", last: "Banda", identity: "ZZKEEP0022X", town: "Gweru" });
    const otherEvents = h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(other).n;

    const r = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(r.status, 200);

    assert.equal(h.db.prepare(`select count(*) n from conversation_sessions where wa_phone_uid=?`).get(phone).n, 0, "conversation session (which holds the plaintext ID for an abandoned registration) is gone");
    assert.equal(h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(phone).n, 0, "inbound events no longer keyed by the real number");
    assert.equal(h.db.prepare(`select count(*) n from outbound_messages where wa_phone_uid=?`).get(phone).n, 0, "outbound messages no longer keyed by the real number");
    assert.ok(h.db.prepare(`select count(*) n from consents where participant_id=? and withdrawn_at is not null`).get(p.id).n > 0, "consent is withdrawn");

    assert.deepEqual(scanForString(h.db, identity).map((x) => x.table), [], "the national ID is not left in any table");
    assert.deepEqual(scanForString(h.db, phone).map((x) => x.table), [], "the MSISDN is not left in any table");

    assert.equal(h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(other).n, otherEvents, "another participant's events are untouched");
    assert.ok(h.db.prepare(`select count(*) n from receipts where participant_id=?`).get(p.id).n >= 0);
    const row = h.db.prepare(`select * from audit_events where action='participant.anonymise' and target_id=? order by id desc limit 1`).get(p.id);
    const payload = JSON.parse(row.payload_json).payload;
    assert.ok(payload.scrubbed.channelEvents >= 1, "the audit row records what was scrubbed");
    assert.ok(payload.scrubbed.sessions >= 1);
  });

  it("anonymisation refuses while the person is a published winner", async () => {
    const phone = "263779900401";
    await h.register(phone, { first: "Nyasha", last: "Dube", identity: "ZZWIN5512X", town: "Harare" });
    const p = h.domain.getParticipantByPhone(phone);
    // Construct the published-winner state directly: the draw machinery is not
    // under test here, only the erasure guard.
    h.db.exec("pragma foreign_keys=OFF");
    try {
      h.db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, history_json, published_fields_json, publication_state, display_name, row_version)
        values (?,?,?,?,?,?,?,?,?,?,?,?)`).run("win_fixdom", "drw_fixdom", 1, "ent_fixdom", p.id, "P1", "collected", "[]", '{"prize":"Hamper"}', "published", "Nyasha D.", 1);
    } finally { h.db.exec("pragma foreign_keys=ON"); }

    const r = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(r.status, 409, "erasure must not silently leave a published name behind");
    assert.equal(h.domain.getParticipant(p.id).status, "active", "nothing was erased");

    // once the publication is withdrawn the erasure goes through and the name goes with it
    h.app.winners.unpublish("win_fixdom", "adm_tester", "erasure request");
    const ok = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(ok.status, 200);
    assert.equal(h.db.prepare(`select display_name from winners where id='win_fixdom'`).get().display_name, null, "the published name is cleared");
    h.db.exec("pragma foreign_keys=OFF");
    h.db.prepare(`delete from winners where id='win_fixdom'`).run();
    h.db.exec("pragma foreign_keys=ON");
  });

  // ---- authz-2 ---------------------------------------------------------------------
  it("re-enrolling MFA cannot silently disable it, and enrolment is audited", async () => {
    const created = await h.api("/api/users", { method: "POST", token: admin, body: { email: "mfa.fixdom@example.test", roles: ["reviewer"] } });
    assert.equal(created.status, 201);
    const uid = created.data.user.id;

    const before = h.db.prepare(`select count(*) n from audit_events where action='staff.mfa_enroll' and target_id=?`).get(uid).n;
    const enrolled = h.app.auth.enrollMfa(uid);
    assert.ok(enrolled.secret);
    assert.equal(h.db.prepare(`select count(*) n from audit_events where action='staff.mfa_enroll' and target_id=?`).get(uid).n, before + 1, "enrolment is recorded in the audit chain");
    assert.ok(h.app.auth.enableMfa(uid, totp(enrolled.secret)).ok);
    assert.equal(h.db.prepare(`select mfa_enabled from admin_users where id=?`).get(uid).mfa_enabled, 1);

    assert.throws(() => h.app.auth.enrollMfa(uid), /already enabled|current MFA code/i, "a second enrol with no code is refused");
    const row = h.db.prepare(`select mfa_enabled, mfa_secret from admin_users where id=?`).get(uid);
    assert.equal(row.mfa_enabled, 1, "the second factor stays on");

    // the deliberate control still works: a valid code re-enrols without ever turning MFA off
    const re = h.app.auth.enrollMfa(uid, totp(enrolled.secret));
    assert.ok(re.secret && re.secret !== enrolled.secret, "a new secret is issued");
    assert.equal(h.db.prepare(`select mfa_enabled from admin_users where id=?`).get(uid).mfa_enabled, 1, "MFA is still enabled while the new secret is pending");
    assert.equal(h.db.prepare(`select mfa_secret from admin_users where id=?`).get(uid).mfa_secret, enrolled.secret, "the live secret only changes when the new one is confirmed");
    assert.ok(h.app.auth.enableMfa(uid, totp(re.secret)).ok, "confirming the pending secret swaps it in");
    assert.equal(h.db.prepare(`select mfa_secret from admin_users where id=?`).get(uid).mfa_secret, re.secret);
  });

  it("POST /api/mfa/enroll on an enabled account is rejected by the API", async () => {
    const email = "mfa.route@example.test";
    const created = await h.api("/api/users", { method: "POST", token: admin, body: { email, roles: ["reviewer"] } });
    const uid = created.data.user.id;
    const pw = "RouteMfaPassword123";
    const { scryptHash } = await import("../src/db.mjs");
    const hsh = scryptHash(pw);
    h.db.prepare(`update admin_users set password_hash=?, must_change_password=0 where id=?`).run(`${hsh.salt}:${hsh.hash}`, uid);
    const token = await h.login(email, pw);
    const first = await h.api("/api/mfa/enroll", { method: "POST", token });
    assert.equal(first.status, 200);
    assert.ok(h.app.auth.enableMfa(uid, totp(first.data.secret)).ok);
    const second = await h.api("/api/mfa/enroll", { method: "POST", token });
    assert.equal(second.status, 409, "the enrol route cannot be used to strip the second factor");
    assert.equal(h.db.prepare(`select mfa_enabled from admin_users where id=?`).get(uid).mfa_enabled, 1);
  });
});

// ---- schema-5 / schema-6 / schema-4 / schema-7 -------------------------------------
describe("migrations and indexes", () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-mig-")); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("schema_version reflects the highest applied migration and the dead retention keys are gone", () => {
    const db = openDb(path.join(dir, "ver.db"));
    migrate(db, undefined, () => {});
    const meta = Object.fromEntries(db.prepare(`select key, value from schema_meta`).all().map((r) => [r.key, r.value]));
    const highest = String(Math.max(...meta.migrations.split(",").map((f) => Number(f.slice(0, 3)))));
    assert.equal(meta.schema_version, highest, "the documented post-deploy check reports the real schema version");
    assert.equal(meta.retention_raw_receipts_days, undefined, "dead retention metadata is removed");
    assert.equal(meta.retention_facts_days, undefined);
    db.close();
  });

  it("a second migrator that applies a pending file first does not crash the boot", () => {
    const file = path.join(dir, "race.db");
    const real = openDb(file);
    let raced = false;
    // Stand in for a concurrent `npm run migrate` that commits between our
    // ledger read and our first write: the loser must observe the new ledger.
    const proxy = {
      prepare: (sql) => real.prepare(sql),
      exec: (sql) => {
        if (!raced && /^\s*begin/i.test(sql)) {
          raced = true;
          const other = openDb(file);
          migrate(other, undefined, () => {});
          other.close();
        }
        return real.exec(sql);
      },
    };
    migrate(proxy, undefined, () => {});   // must not throw "duplicate column name"
    const applied = real.prepare(`select value from schema_meta where key='migrations'`).get().value.split(",");
    assert.ok(applied.some((f) => f.startsWith("011")), "the ledger is complete");
    const cols = real.prepare(`pragma table_info(outlets)`).all().filter((c) => c.name === "aliases_json");
    assert.equal(cols.length, 1, "the racing migration was applied exactly once");
    real.close();
  });

  it("duplicate detection and the draw barrier have indexes to work with", () => {
    const db = openDb(path.join(dir, "idx.db"));
    migrate(db, undefined, () => {});
    db.exec("pragma foreign_keys=OFF");
    const idx = db.prepare(`select name from sqlite_master where type='index'`).all().map((r) => r.name);
    assert.ok(idx.includes("idx_receipts_media"), "receipts(media_asset_id) is indexed");
    assert.ok(idx.includes("idx_entries_period_code"), "entries(campaign_id, period_code, status, participant_id) is indexed");

    db.exec("begin");
    const im = db.prepare(`insert into media_assets (id, object_key, sha256, phash, dhash, size_bytes, mime, status, created_at) values (?,?,?,?,?,?,?,?,?)`);
    const ir = db.prepare(`insert into receipts (id, provider_message_id, participant_id, campaign_id, campaign_version_id, media_asset_id, status, created_at, period_code) values (?,?,?,?,?,?,?,?,?)`);
    const ip = db.prepare(`insert into participants (id, wa_phone_uid, first_name, surname, status, created_at, updated_at) values (?,?,?,?,?,?,?)`);
    const ie = db.prepare(`insert into entries (id, receipt_id, participant_id, campaign_id, campaign_version_id, draw_period, entry_no, status, created_at, period_code, weight_units) values (?,?,?,?,?,?,?,?,?,?,1)`);
    for (let i = 0; i < 300; i++) {
      ip.run(`p_${i}`, `26377${String(i).padStart(7, "0")}`, "x", "y", "active", "2026-01-01", "2026-01-01");
      im.run(`m_${i}`, `k_${i}`, `sha_${i}`, `${i}`, `${i}`, 10, "image/jpeg", "stored", "2026-01-01");
      ir.run(`r_${i}`, `pm_${i}`, `p_${i}`, "cmp_1", "cv_1", `m_${i}`, "QUALIFIED", "2026-01-01T00:00:00Z", "W1");
      ie.run(`e_${i}`, `r_${i}`, `p_${i}`, "cmp_1", "cv_1", "W1", i, "active", "2026-01-01", "W1");
    }
    db.exec("commit");

    const barrier = `select e.id from entries e join participants p on p.id=e.participant_id where e.campaign_id=? and e.period_code=? and e.status='active' and p.status='active' order by e.id`;
    const bplan = db.prepare("explain query plan " + barrier).all("cmp_1", "W1").map((r) => r.detail).join(" | ");
    assert.match(bplan, /idx_entries_period_code \(campaign_id=\? AND period_code=\? AND status=\?\)/, "the weekly barrier seeks on the period, it does not scan the campaign");

    const count = `select count(*) n from entries where participant_id=? and campaign_id=? and period_code=? and status='active'`;
    const cplan = db.prepare("explain query plan " + count).all("p_1", "cmp_1", "W1").map((r) => r.detail).join(" | ");
    assert.match(cplan, /SEARCH/, "the per-receipt entry count still seeks");

    // With table statistics present the exact-duplicate lookup must be driven
    // from the image hash, not by walking every receipt in the campaign.
    db.exec("ANALYZE");
    const sha = `select r.id, r.status from receipts r join media_assets m on m.id = r.media_asset_id where m.sha256 = ? and r.campaign_id = ? and r.id != ? order by r.created_at limit 5`;
    const splan = db.prepare("explain query plan " + sha).all("sha_5", "cmp_1", "r_9").map((r) => r.detail).join(" | ");
    assert.ok(!/SCAN r\b/.test(splan), `exact-duplicate lookup still scans receipts: ${splan}`);
    assert.match(splan, /idx_receipts_media/);
    db.close();
  });
});
