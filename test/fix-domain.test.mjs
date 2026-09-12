// Regression tests for the adjudicated "domain" audit package:
//   crosscut-5 / requirements-7  outlet + product master edits write no audit row
//   privacy-3                    anonymisation leaves the phone, the ID and the winner name behind
//                                (incl. after a support phone correction, and the queued work it leaves running)
//   authz-2                      POST /api/mfa/enroll silently disables MFA
//   schema-5 / schema-6          migrate(): racing migrators, stale schema_version ledger,
//                                and a ledger read failure that must not truncate schema_meta
//   schema-4 / schema-7          duplicate-detection and draw-barrier indexes, and the boot-time
//                                statistics refresh without which idx_receipts_media is never chosen
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApp, before, after, describe, it, assert, ROOT } from "./helpers.mjs";
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

  it("a published winner can still be erased, and the public list stops naming them", async () => {
    const phone = "263779900401";
    await h.register(phone, { first: "Nyasha", last: "Dube", identity: "ZZWIN5512X", town: "Harare" });
    const p = h.domain.getParticipantByPhone(phone);
    // Construct the published-winner state directly: the draw machinery is not
    // under test here, only what erasure does to a published result.
    h.db.exec("pragma foreign_keys=OFF");
    try {
      h.db.prepare(`insert into draws (id, campaign_id, draw_period, status, config_hash, snapshot_hash, created_at) values (?,?,?,?,?,?,?)`)
        .run("drw_fixdom", h.campaign.id, "W9", "published", "ch", "sh", "2026-01-01");
      h.db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, history_json, published_fields_json, publication_state, display_name, row_version)
        values (?,?,?,?,?,?,?,?,?,?,?,?)`).run("win_fixdom", "drw_fixdom", 1, "ent_fixdom", p.id, "P1", "collected", "[]", '{"prize":"Hamper"}', "published", "Nyasha D.", 1);
    } finally { h.db.exec("pragma foreign_keys=ON"); }
    assert.equal(h.app.winners.listPublic(h.campaign.id).find((w) => w.rank === 1 && w.period === "W9")?.name, "Nyasha D.", "precondition: the name is on the public list");

    // An earlier revision refused this with 409 ("withdraw the publication
    // first"). listPublic now derives the name from the live participant status,
    // so the refusal blocked a lawful erasure for no privacy gain.
    const r = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(r.status, 200, "a lawful erasure request is not blocked by a published draw result");
    assert.equal(h.domain.getParticipant(p.id).status, "deleted");
    assert.equal(h.db.prepare(`select display_name from winners where id='win_fixdom'`).get().display_name, null, "the frozen published name is cleared");
    const pub = h.app.winners.listPublic(h.campaign.id).find((w) => w.rank === 1 && w.period === "W9");
    assert.ok(pub, "the result itself stays published: rank and prize are a compliance record");
    assert.equal(pub.name, "[removed]", "the unauthenticated public list no longer names the erased person");
    assert.equal(pub.location, null);
    h.db.exec("pragma foreign_keys=OFF");
    h.db.prepare(`delete from winners where id='win_fixdom'`).run();
    h.db.prepare(`delete from draws where id='drw_fixdom'`).run();
    h.db.exec("pragma foreign_keys=ON");
  });

  it("erasure after a support phone correction leaves nothing under the old number", async () => {
    const oldPhone = "263779900501";
    const newPhone = "263779900502";
    await h.register(oldPhone, { first: "Rudo", last: "Chuma", identity: "ZZMOVE331X", town: "Harare" });
    const p = h.domain.getParticipantByPhone(oldPhone);
    const inbound = h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(oldPhone).n;
    assert.ok(inbound > 0, "precondition: history exists under the original number");

    const moved = await h.api(`/api/participants/${p.id}/phone`, { method: "POST", token: admin, body: { phone: newPhone, reason: "support correction" } });
    assert.equal(moved.status, 200);
    // the correction must carry the history with the person, not orphan it
    assert.equal(h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(oldPhone).n, 0, "inbound history follows the corrected number");
    assert.equal(h.db.prepare(`select count(*) n from channel_events where wa_phone_uid=?`).get(newPhone).n, inbound);
    assert.equal(h.db.prepare(`select count(*) n from conversation_sessions where wa_phone_uid=?`).get(newPhone).n, 1, "the session follows too");
    const chg = h.db.prepare(`select payload_json from audit_events where action='participant.phone_change' and target_id=? order by id desc limit 1`).get(p.id);
    assert.ok(JSON.parse(chg.payload_json).payload.moved.channelEvents >= 1, "the audit row records what moved");

    const r = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(r.status, 200);
    for (const t of ["channel_events", "outbound_messages", "conversation_sessions"]) {
      assert.equal(h.db.prepare(`select count(*) n from ${t} where wa_phone_uid=?`).get(oldPhone).n, 0, `${t} rows under the pre-correction number are erased too`);
      assert.equal(h.db.prepare(`select count(*) n from ${t} where wa_phone_uid=?`).get(newPhone).n, 0, `${t} rows under the corrected number are erased`);
    }
    assert.deepEqual(scanForString(h.db, oldPhone).map((x) => x.table), [], "the pre-correction MSISDN survives nowhere");
    assert.deepEqual(scanForString(h.db, "ZZMOVE331X").map((x) => x.table), [], "nor does the national ID");
  });

  it("erasure cancels queued inbound work instead of replying to a dead number", async () => {
    const phone = "263779900601";
    await h.register(phone, { first: "Tapiwa", last: "Sibanda", identity: "ZZQUEUE41X", town: "Gweru" });
    const p = h.domain.getParticipantByPhone(phone);
    // a message that arrived but has not been drained when the erasure lands
    h.app.intake.receive({ provider: "simulator", providerMessageId: "fixdom_queued_1", phoneUid: phone, type: "message.text", text: "menu", timestamp: new Date().toISOString() });
    // a reply that is leased to a worker (status 'sending') and never sent: outbox.next re-picks these once the lease expires
    h.app.outbox.enqueueWhatsApp({ waPhoneUid: phone, payload: "held reply", idempotencyKey: "fixdom:held:1" });
    h.db.prepare(`update outbound_messages set status='sending', lease_until='2000-01-01T00:00:00Z' where idempotency_key='fixdom:held:1'`).run();

    const r = await h.api(`/api/participants/${p.id}/anonymise`, { method: "POST", token: admin, body: { reason: "deletion request" } });
    assert.equal(r.status, 200);
    assert.equal(h.db.prepare(`select count(*) n from outbound_messages where idempotency_key='fixdom:held:1'`).get().n, 0, "a leased but unsent message is dropped, not re-addressed to 'deleted:<id>'");
    assert.equal(h.db.prepare(`select status from channel_events where provider_message_id='fixdom_queued_1'`).get().status, "ignored", "the queued inbound event is cancelled");

    const dead = `deleted:${p.id}`;
    const before = h.db.prepare(`select count(*) n from outbound_messages where wa_phone_uid=?`).get(dead).n;
    await h.app.intake.drain(); await h.app.worker.tick();
    assert.equal(h.db.prepare(`select status from channel_events where provider_message_id='fixdom_queued_1'`).get().status, "ignored", "the worker does not pick the cancelled event back up");
    assert.equal(h.db.prepare(`select count(*) n from outbound_messages where wa_phone_uid=?`).get(dead).n, before, "no reply is enqueued to the erased participant");
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
    const file = path.join(dir, "idx.db");
    let db = openDb(file);
    migrate(db, undefined, () => {});
    db.exec("pragma foreign_keys=OFF");
    const idx = db.prepare(`select name from sqlite_master where type='index'`).all().map((r) => r.name);
    assert.ok(idx.includes("idx_receipts_media"), "receipts(media_asset_id) is indexed");
    assert.ok(idx.includes("idx_entries_period_code"), "entries(campaign_id, period_code, status, participant_id) is indexed");
    assert.ok(!idx.includes("idx_entries_draw"), "the superseded v1 draw_period index is gone");
    assert.ok(!idx.includes("idx_receipts_processing"), "the never-chosen partial receipts(status) index is gone");
    assert.ok(idx.includes("idx_entries_eligibility"), "the partial active-entry index is KEPT: it is the one the campaign pool scan uses");

    db.exec("begin");
    const im = db.prepare(`insert into media_assets (id, object_key, sha256, phash, dhash, size_bytes, mime, status, created_at) values (?,?,?,?,?,?,?,?,?)`);
    const ir = db.prepare(`insert into receipts (id, provider_message_id, participant_id, campaign_id, campaign_version_id, media_asset_id, status, created_at, intake_at, period_code) values (?,?,?,?,?,?,?,?,?,?)`);
    const ip = db.prepare(`insert into participants (id, wa_phone_uid, first_name, surname, status, created_at, updated_at) values (?,?,?,?,?,?,?)`);
    const ie = db.prepare(`insert into entries (id, receipt_id, participant_id, campaign_id, campaign_version_id, draw_period, entry_no, status, created_at, period_code, weight_units) values (?,?,?,?,?,?,?,?,?,?,1)`);
    // Spread across campaigns, periods and statuses. A fixture where every row
    // shares one campaign and one period is degenerate: the filters then select
    // 100% of the table and, once real statistics exist, a full scan IS the
    // cheapest plan — the assertions below would be measuring the fixture, not
    // the indexes.
    for (let i = 0; i < 600; i++) {
      const campaign = `cmp_${i % 5}`, period = `W${i % 4}`;
      ip.run(`p_${i}`, `26377${String(i).padStart(7, "0")}`, "x", "y", "active", "2026-01-01", "2026-01-01");
      im.run(`m_${i}`, `k_${i}`, `sha_${i}`, `${i}`, `${i}`, 10, "image/jpeg", "stored", "2026-01-01");
      ir.run(`r_${i}`, `pm_${i}`, `p_${i}`, campaign, "cv_1", `m_${i}`, i % 9 ? "QUALIFIED" : "received", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", period);
      ie.run(`e_${i}`, `r_${i}`, `p_${i}`, campaign, "cv_1", period, i, i % 11 ? "active" : "excluded", "2026-01-01", period);
    }
    db.exec("commit");
    db.close();

    // Reopen exactly the way the server boots (openDb + migrate). Nothing in the
    // product ever runs ANALYZE, so a test that calls it itself manufactures a
    // precondition no deployed database reaches; migrate() ends with
    // `PRAGMA analysis_limit=400; PRAGMA optimize`, and that is what has to make
    // these plans come out right.
    db = openDb(file);
    migrate(db, undefined, () => {});
    assert.equal(db.prepare(`select count(*) n from sqlite_master where name='sqlite_stat1'`).get().n, 1, "boot collected planner statistics");

    const barrier = `select e.id from entries e join participants p on p.id=e.participant_id where e.campaign_id=? and e.period_code=? and e.status='active' and p.status='active' order by e.id`;
    const bplan = db.prepare("explain query plan " + barrier).all("cmp_1", "W1").map((r) => r.detail).join(" | ");
    assert.match(bplan, /idx_entries_period_code \(campaign_id=\? AND period_code=\? AND status=\?\)/, "the weekly barrier seeks on the period, it does not scan the campaign");

    const count = `select count(*) n from entries where participant_id=? and campaign_id=? and period_code=? and status='active'`;
    const cplan = db.prepare("explain query plan " + count).all("p_1", "cmp_1", "W1").map((r) => r.detail).join(" | ");
    assert.match(cplan, /COVERING INDEX idx_entries_period_code \(campaign_id=\? AND period_code=\? AND status=\? AND participant_id=\?\)/, "the per-receipt entry count is a covering seek on the claimed index, not just any SEARCH");

    // The exact-duplicate lookup must be driven from the image hash, not by
    // walking every receipt in the campaign.
    const sha = `select r.id, r.status from receipts r join media_assets m on m.id = r.media_asset_id where m.sha256 = ? and r.campaign_id = ? and r.id != ? order by r.created_at limit 5`;
    const splan = db.prepare("explain query plan " + sha).all("sha_5", "cmp_1", "r_9").map((r) => r.detail).join(" | ");
    assert.ok(!/SCAN r\b/.test(splan), `exact-duplicate lookup still scans receipts: ${splan}`);
    assert.match(splan, /SEARCH m USING INDEX idx_media_sha/, `duplicate lookup is not driven from the image hash: ${splan}`);
    assert.match(splan, /SEARCH r USING INDEX idx_receipts_media/, `duplicate lookup does not seek receipts by media id: ${splan}`);

    // The draw barrier's unresolved-receipt check: idx_receipts_period already
    // serves it, which is why widening idx_receipts_processing's predicate
    // (finding schema-7's other option) would only have added a second dead index.
    const unresolved = `select status, count(*) n from receipts where campaign_id=? and period_code=? and intake_at < ? and status in ('received','processing','delayed','REVIEW_REQUIRED') group by status`;
    assert.match(db.prepare("explain query plan " + unresolved).all("cmp_1", "W1", "2030-01-01").map((r) => r.detail).join(" | "), /idx_receipts_period/, "the unresolved-receipt check seeks by campaign and period");
    db.close();
  });

  it("a transient ledger read failure inside a migration aborts instead of truncating schema_meta", () => {
    const file = path.join(dir, "ledger.db");
    const partial = path.join(dir, "mig-partial");
    fs.mkdirSync(partial, { recursive: true });
    const all = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    for (const f of all) if (Number(f.slice(0, 3)) <= 10) fs.copyFileSync(path.join(ROOT, "db", "migrations", f), path.join(partial, f));
    const real = openDb(file);
    migrate(real, partial, () => {});
    const ledgerBefore = real.prepare(`select value from schema_meta where key='migrations'`).get().value;

    // readApplied() is now called a second time INSIDE the migration's
    // BEGIN IMMEDIATE and its result is written straight back with
    // `insert or replace`. Swallowing a storage failure there rebuilt the ledger
    // from an EMPTY set and committed it.
    let inTx = false;
    const proxy = {
      get isTransaction() { return real.isTransaction; },
      exec: (sql) => { if (/^\s*begin/i.test(sql)) inTx = true; if (/^\s*(commit|rollback)/i.test(sql)) inTx = false; return real.exec(sql); },
      prepare: (sql) => { if (inTx && /from schema_meta where key='migrations'/.test(sql)) throw new Error("disk I/O error"); return real.prepare(sql); },
    };
    assert.throws(() => migrate(proxy, undefined, () => {}), /disk I\/O error/, "the migration aborts on a real read failure");
    assert.equal(real.prepare(`select value from schema_meta where key='migrations'`).get().value, ledgerBefore, "the ledger is not rewritten from an empty set");
    real.close();

    const next = openDb(file);
    migrate(next, undefined, () => {});   // must not die replaying 007's ADD COLUMNs
    assert.ok(next.prepare(`select value from schema_meta where key='migrations'`).get().value.split(",").some((f) => f.startsWith("012")), "the next boot completes the migration normally");
    next.close();
  });
});
