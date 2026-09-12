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
{
  // `npm run reset:sample` passes --confirm, so this summary is the only
  // warning an operator gets: print it either way.
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const scope = { receipts: n(`select count(*) n from receipts where campaign_id=?`, camp.id), entries: n(`select count(*) n from entries where campaign_id=?`, camp.id), draws: n(`select count(*) n from draws where campaign_id=?`, camp.id), participants: n(`select count(*) n from campaign_enrollments where campaign_id=?`, camp.id) };
  console.log(`${process.argv.includes("--confirm") ? "deleting" : "dry run: would delete"} sample campaign ${SAMPLE_CODE} (${camp.id}): ${JSON.stringify(scope)}; activation evidence (settings 'evidence.*'), unrelated jobs and CRM references are kept.`);
  if (!process.argv.includes("--confirm")) { console.log("Re-run with --confirm to apply."); process.exit(0); }
}

db.exec("begin");
try {
  const cid = camp.id;
  const rids = db.prepare(`select id, media_asset_id from receipts where campaign_id=?`).all(cid);
  // Everything this reset may touch, by id. The deletes below used to clear
  // whole tables (jobs, crm_external_refs) and every settings row matching
  // 'evidence.%', none of which belong to the sample campaign: a reset on a
  // UAT box silently destroyed the recorded benchmark/restore/UAT sign-off
  // evidence that production activation requires.
  const eids = db.prepare(`select id from entries where campaign_id=?`).all(cid).map((e) => e.id);
  const pids = db.prepare(`select participant_id from campaign_enrollments where campaign_id=?`).all(cid).map((p) => p.participant_id);
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
  // Was `wa_phone_uid like '2637700%' or status='deleted'` with a comment
  // claiming "sample phones only": it wiped every anonymised participant in
  // the database, including erasure records that have nothing to do with the
  // sample. Only this campaign's own participants go, and only when no other
  // campaign still enrols them.
  let removedParticipants = 0;
  for (const pid of pids) {
    if (db.prepare(`select count(*) n from campaign_enrollments where participant_id=?`).get(pid).n) continue;
    db.prepare(`delete from consents where participant_id=?`).run(pid);
    db.prepare(`update conversation_sessions set participant_id=null where participant_id=?`).run(pid);
    db.prepare(`delete from participants where id=?`).run(pid);
    removedParticipants++;
  }
  db.prepare(`delete from channel_events where provider='simulator'`).run();
  db.prepare(`delete from outbound_messages where campaign_id=? or provider='whatsapp' and wa_phone_uid like '2637700%'`).run(cid);
  db.prepare(`delete from crm_events where external_key like ?`).run(`${env}:%`);
  // Scoped to the entities this reset actually deleted (was: the whole table).
  for (const eid of [cid, ...pids, ...rids.map((r) => r.id), ...eids, ...wids, ...dids]) db.prepare(`delete from crm_external_refs where entity_id=?`).run(eid);
  // Scoped to jobs about this campaign's rows: a blanket delete also removed
  // pending winner.expire / retention jobs belonging to nothing sample.
  for (const jid of [cid, ...rids.map((r) => r.id), ...eids, ...wids, ...dids]) db.prepare(`delete from jobs where payload_json like ?`).run(`%${jid}%`);
  db.prepare(`delete from campaign_decisions where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_periods where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_outlets where campaign_id=?`).run(cid);
  db.prepare(`delete from campaign_versions where campaign_id=?`).run(cid);
  // 'evidence.%' is client activation evidence, not sample data — leave it.
  // 'sample_journeys' is this seed's completion marker and must go with it.
  db.prepare(`delete from settings where key like 'campaign:' || ? || ':%' or key='sample_data' or key='sample_journeys'`).run(cid);
  db.prepare(`delete from campaigns where id=?`).run(cid);
  db.prepare(`delete from outlets where retailer_code='TEST'`).run();
  db.exec("commit");
  console.log(`sample campaign ${SAMPLE_CODE} reset: ${rids.length} receipt(s), ${eids.length} entry/entries, ${dids.length} draw(s), ${wids.length} winner(s), ${removedParticipants} participant(s). Activation evidence and unrelated jobs retained. Re-seed: npm run seed`);
} catch (e) { db.exec("rollback"); console.error("reset failed:", e.message); process.exit(1); }
