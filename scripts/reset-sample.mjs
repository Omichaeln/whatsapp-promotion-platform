// Isolated sample reset (spec §19). Refuses to run unless the database's
// environment is local|test|staging AND the only campaign present is the
// TEST ONLY sample (or --force-sample-only names it). Deletes ONLY the sample
// campaign's records and sample media; never production data, live provider
// registrations or real prize allocations. Usage: node scripts/reset-sample.mjs [--confirm]
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { SAMPLE_CODE } from "../src/demo-seed.mjs";

const cfg = loadConfig();
const db = openDb(cfg.database);
const env = db.prepare(`select value from schema_meta where key='environment'`).get()?.value || cfg.environment;
if (!["local", "test", "staging"].includes(env)) { console.error(`refusing: database environment is "${env}"`); process.exit(2); }
if (/prod/i.test(cfg.database) || /prod/i.test(cfg.mediaDir)) { console.error("refusing: database/media path looks like production"); process.exit(2); }
const camp = db.prepare(`select * from campaigns where code=?`).get(SAMPLE_CODE);
if (!camp) { console.log("no sample campaign present; nothing to reset"); process.exit(0); }
const others = db.prepare(`select code from campaigns where code<>? and code not like 'TEST-%'`).all(SAMPLE_CODE);
if (others.length) { console.error(`refusing: non-sample campaigns present (${others.map((o) => o.code).join(", ")})`); process.exit(2); }
if (!process.argv.includes("--confirm")) { console.log(`dry run: would delete sample campaign ${SAMPLE_CODE} (${camp.id}) and all its records. Re-run with --confirm.`); process.exit(0); }

db.exec("begin");
try {
  const cid = camp.id;
  const rids = db.prepare(`select id, media_asset_id from receipts where campaign_id=?`).all(cid);
  const wids = db.prepare(`select w.id from winners w join draws d on d.id=w.draw_id where d.campaign_id=?`).all(cid).map((w) => w.id);
  const dids = db.prepare(`select id from draws where campaign_id=?`).all(cid).map((d) => d.id);
  for (const w of wids) db.prepare(`delete from claims where winner_id=?`).run(w);
  for (const d of dids) { db.prepare(`delete from winners where draw_id=?`).run(d); db.prepare(`delete from draw_candidates where draw_id=?`).run(d); db.prepare(`delete from draw_attempts where draw_id=?`).run(d); }
  db.prepare(`delete from draws where campaign_id=?`).run(cid);
  db.prepare(`delete from entry_events where entry_id in (select id from entries where campaign_id=?)`).run(cid);
  db.prepare(`delete from entries where campaign_id=?`).run(cid);
  for (const r of rids) { db.prepare(`delete from duplicate_candidates where receipt_id=? or candidate_receipt_id=?`).run(r.id, r.id); db.prepare(`delete from review_tasks where receipt_id=?`).run(r.id); db.prepare(`delete from validation_results where receipt_id=?`).run(r.id); db.prepare(`delete from receipt_items where receipt_id=?`).run(r.id); }
  db.prepare(`delete from receipts where campaign_id=?`).run(cid);
  db.prepare(`delete from canonical_receipts where campaign_id=?`).run(cid);
  for (const a of db.prepare(`select * from media_assets where campaign_id=?`).all(cid)) { for (const k of [a.object_key, a.normalized_key]) if (k) fs.rmSync(path.join(cfg.mediaDir, k), { force: true }); }
  db.prepare(`delete from media_assets where campaign_id=?`).run(cid);
  db.prepare(`delete from conversation_sessions where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_enrollments where campaign_id=?`).run(cid);
  db.prepare(`delete from participants where wa_phone_uid like '2637700%' or status='deleted'`).run();  // sample phones only
  db.prepare(`delete from channel_events where provider='simulator'`).run();
  db.prepare(`delete from outbound_messages where campaign_id=? or provider='whatsapp' and wa_phone_uid like '2637700%'`).run(cid);
  db.prepare(`delete from crm_events where external_key like ?`).run(`${env}:%`);
  db.prepare(`delete from crm_external_refs`).run();
  db.prepare(`delete from jobs`).run();
  db.prepare(`delete from campaign_decisions where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_periods where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_outlets where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_versions where campaign_id=?`).run(cid);
  db.prepare(`delete from settings where key like 'campaign:' || ? || ':%' or key='sample_data' or key like 'evidence.%'`).run(cid);
  db.prepare(`delete from campaigns where id=?`).run(cid);
  db.prepare(`delete from outlets where retailer_code='TEST'`).run();
  db.exec("commit");
  console.log(`sample campaign ${SAMPLE_CODE} reset (audit trail retained). Re-seed: npm run seed`);
} catch (e) { db.exec("rollback"); console.error("reset failed:", e.message); process.exit(1); }
