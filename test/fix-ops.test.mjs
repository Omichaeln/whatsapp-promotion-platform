// Regression tests for the audited ops/deploy defects (package "ops"):
//   docs-2       `src/db.js migrate --dry` must not write
//   ops-3/ops-4  production configuration gates (transport, checkpoint key)
//   ops-9        the durable data volume must prove itself before boot
//   ops-8        preflight must validate the configuration the service runs
//   ops-10       `reset:sample` must delete only the sample campaign
//   durability-6 an interrupted sample seed must not report "already present"
//   durability-2 the sample seed must never rewrite a real tester's entry
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, before, after, assert, buildApp, ROOT } from "./helpers.mjs";
import { loadConfig, validateConfig, dataVolumeStatus, markDataVolume } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { runPopulatedSeed, seedEntries, seedReviewTasks, SEED_PHONES, SEED_MARKER_KEY } from "../src/demo-journeys.mjs";

const NODE = process.execPath;
const tmpDirs = [];
const tmp = (label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `wpp-ops-${label}-`)); tmpDirs.push(d); return d; };
const run = (script, args, env) => {
  try { return { code: 0, out: execFileSync(NODE, ["--no-warnings=ExperimentalWarning", script, ...args], { cwd: ROOT, env, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};
const baseEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });

describe("ops package fixes", () => {
  after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

  it("docs-2: `migrate --dry` lists pending migrations without applying them", () => {
    const dir = tmp("dry"); const dbFile = path.join(dir, "d.db");
    const dry = run("src/db.js", ["migrate", "--dry"], baseEnv({ DATABASE: dbFile }));
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /dry run: [1-9]\d* migration\(s\) would apply/);
    assert.equal(fs.existsSync(dbFile), false, "a dry run must not even create the database file");

    const applied = run("src/db.js", ["migrate"], baseEnv({ DATABASE: dbFile }));
    assert.equal(applied.code, 0, applied.out);
    const db = openDb(dbFile);
    const migrations = db.prepare(`select value from schema_meta where key='migrations'`).get().value.split(",");
    assert.ok(migrations.length > 5, "real migrate applied the schema");
    db.close();
    const dry2 = run("src/db.js", ["migrate", "--dry"], baseEnv({ DATABASE: dbFile }));
    assert.match(dry2.out, /dry run: 0 migration\(s\) would apply/);
  });

  it("ops-3/ops-4: production refuses the simulator transport, a typo'd transport and a missing AUDIT_CHECKPOINT_KEY", () => {
    const dir = tmp("cfg");
    const prod = (extra) => loadConfig({ ENVIRONMENT: "production", DATABASE: path.join(dir, "p.db"), MEDIA_DIR: path.join(dir, "media"), ADMIN_PASSWORD: "ProductionPassword123", IDENTITY_KEY: "identity-key-0123456789", ...extra });

    const silent = validateConfig(prod({ WHATSAPP_TRANSPORT: "simulator" }));
    assert.ok(silent.some((p) => /cloud-api/.test(p)), `expected a transport problem, got ${JSON.stringify(silent)}`);
    assert.ok(silent.some((p) => /AUDIT_CHECKPOINT_KEY/.test(p)), `expected a checkpoint-key problem, got ${JSON.stringify(silent)}`);

    // a typo used to fall through to the simulator rather than being rejected
    const typo = validateConfig(prod({ WHATSAPP_TRANSPORT: "cloud_api", AUDIT_CHECKPOINT_KEY: "k" }));
    assert.ok(typo.some((p) => /WHATSAPP_TRANSPORT="cloud_api" is not one of/.test(p)), JSON.stringify(typo));
    const typoX = validateConfig(prod({ RECEIPT_EXTRACTOR: "tesserract" }));
    assert.ok(typoX.some((p) => /RECEIPT_EXTRACTOR="tesserract" is not one of/.test(p)), JSON.stringify(typoX));

    const good = validateConfig(prod({ WHATSAPP_TRANSPORT: "cloud-api", AUDIT_CHECKPOINT_KEY: "checkpoint-key", PUBLIC_BASE_URL: "https://promo.example.com", META_ACCESS_TOKEN: "t", META_APP_SECRET: "s", WHATSAPP_WEBHOOK_TOKEN: "w" }));
    assert.deepEqual(good, [], "a fully configured production deployment still validates");
    assert.deepEqual(validateConfig(loadConfig({ DATABASE: path.join(dir, "l.db") })), [], "local is unchanged");
  });

  it("ops-9: a data directory without the volume marker fails validation until it is provisioned", () => {
    const dir = tmp("vol");
    const cfg = loadConfig({ ENVIRONMENT: "staging", VOLUME_PATH: dir, DATABASE: path.join(dir, "promotions.db"), MEDIA_DIR: path.join(dir, "media"), ADMIN_PASSWORD: "StagingPassword12345", IDENTITY_KEY: "identity-key-0123456789" });
    assert.equal(dataVolumeStatus(cfg).ok, false);
    assert.ok(validateConfig(cfg).some((p) => /VOLUME_PATH/.test(p)), "an unmounted volume must block the boot");
    markDataVolume(cfg);
    assert.equal(dataVolumeStatus(cfg).ok, true);
    assert.deepEqual(validateConfig(cfg), []);
    const local = loadConfig({ ENVIRONMENT: "local", VOLUME_PATH: tmp("vol-local"), DATABASE: path.join(dir, "promotions.db") });
    assert.equal(dataVolumeStatus(local).checked, false, "local development is never gated on a volume");
  });

  it("ops-8: preflight validates the configuration from the env file, not the defaults", () => {
    const dir = tmp("env");
    const envFile = path.join(dir, "deploy.env");
    fs.writeFileSync(envFile, `ENVIRONMENT=production\nDATABASE=${path.join(dir, "p.db")}\nMEDIA_DIR=${path.join(dir, "media")}\nWHATSAPP_TRANSPORT=simulator\n`);
    const r = run("scripts/preflight.mjs", [], baseEnv({ ENV_FILE: envFile }));
    const report = JSON.parse(r.out.slice(r.out.indexOf("{")));
    assert.equal(report.environment, "production", "preflight must read the same .env the service reads");
    assert.equal(report.ok, false);
    assert.equal(r.code, 1, "the pre-deploy gate must not exit 0 on this configuration");
    const cfgCheck = report.checks.find((c) => c.name === "configuration valid for environment");
    assert.equal(cfgCheck.pass, false, JSON.stringify(cfgCheck));
    const key = report.checks.find((c) => c.name === "secret AUDIT_CHECKPOINT_KEY");
    assert.ok(key.blocking && !key.pass, "an unset AUDIT_CHECKPOINT_KEY blocks outside local");
  });

  it("privacy-6: the restore rehearsal deletes its restored copy and prunes old backups", () => {
    const dir = tmp("rehearsal"); const dbFile = path.join(dir, "p.db"); const backups = path.join(dir, "bk");
    assert.equal(run("src/db.js", ["migrate"], baseEnv({ DATABASE: dbFile })).code, 0);
    const env = baseEnv({ DATABASE: dbFile, MEDIA_DIR: path.join(dir, "media") });
    const first = run("scripts/backup-restore-rehearsal.mjs", ["--backup-dir", backups, "--keep", "1"], env);
    assert.equal(first.code, 0, first.out);
    const report = JSON.parse(first.out.slice(first.out.indexOf("{")));
    assert.equal(report.restore.removed, true);
    assert.equal(fs.existsSync(report.restore.dir), false, "a full unencrypted copy of the database and media must not be left behind");
    assert.equal(fs.existsSync(path.join(backups, "restore-test")), false);
    const second = run("scripts/backup-restore-rehearsal.mjs", ["--backup-dir", backups, "--keep", "1"], env);
    assert.equal(second.code, 0, second.out);
    const stamps = fs.readdirSync(path.join(backups, "backups"));
    assert.equal(stamps.length, 1, `backups must be pruned to the retention window, found ${stamps.join(", ")}`);
  });

  describe("with a running app", () => {
    let h, dir, closed = false;
    before(async () => { dir = tmp("app"); h = await buildApp({ extractor: "simulator", env: { DATABASE: path.join(dir, "t.db"), MEDIA_DIR: path.join(dir, "media") } }); });
    after(async () => { if (!closed) await h.close(); });

    it("durability-2: the sample seed's backdating never selects a real tester's entry or review task", async () => {
      const tester = "263771555001";
      await h.register(tester);
      const s = await h.submit(tester, await h.simImage(h.simReceipt({ no: "770001" })));
      assert.equal(s.receipt.status, "QUALIFIED", JSON.stringify(s.outcomes));
      const testerEntry = h.db.prepare(`select id from entries where receipt_id=?`).get(s.receiptId);
      assert.ok(testerEntry, "the tester has a live entry");

      // the query the seed used to run (campaign-scoped only) does pick it up
      const unscoped = h.db.prepare(`select e.id from entries e where e.campaign_id=? and e.status='active'`).all(h.campaign.id).map((e) => e.id);
      assert.ok(unscoped.includes(testerEntry.id), "precondition: an unscoped sweep would rewrite this entry");
      assert.deepEqual(seedEntries(h.db, h.campaign.id).map((e) => e.id), [], "the seed owns no entries yet");

      // a seed-owned entry is still selected
      const seedPhone = SEED_PHONES[0];
      await h.register(seedPhone, { identity: "TEST9001X" });
      const s2 = await h.submit(seedPhone, await h.simImage(h.simReceipt({ no: "770002" })));
      assert.equal(s2.receipt.status, "QUALIFIED");
      const seedIds = seedEntries(h.db, h.campaign.id).map((e) => e.receipt_id);
      assert.deepEqual(seedIds, [s2.receiptId], "only the seed's own entry is backdated");

      // the same for the review sweep that auto-rejects tasks in W-2/W-1
      h.db.prepare(`update receipts set period_code='W-2' where id=?`).run(s.receiptId);
      h.db.prepare(`insert into review_tasks (id, receipt_id, state, sla_due_at, created_at) values (?,?,'open',?,?)`).run("rt_tester", s.receiptId, new Date().toISOString(), new Date().toISOString());
      const unscopedTasks = h.db.prepare(`select rt.receipt_id from review_tasks rt join receipts r on r.id=rt.receipt_id where rt.state!='decided' and r.period_code in ('W-2','W-1')`).all().map((t) => t.receipt_id);
      assert.ok(unscopedTasks.includes(s.receiptId), "precondition: the unscoped sweep would auto-reject the tester's receipt");
      assert.deepEqual(seedReviewTasks(h.db, h.campaign.id, ["W-2", "W-1"]).map((t) => t.receipt_id), [], "the seed decides only its own review tasks");
    });

    it("durability-6: an interrupted sample seed reports INCOMPLETE instead of 'already present'", async () => {
      const receipts = h.db.prepare(`select count(*) n from receipts where campaign_id=?`).get(h.campaign.id).n;
      assert.ok(receipts > 0, "precondition: receipts exist, as after a seed that died mid-run");
      const logs = [];
      const partial = await runPopulatedSeed(h.app, { log: (m) => logs.push(m) });
      assert.equal(partial.incomplete, true, JSON.stringify(partial));
      assert.ok(logs.some((l) => /INCOMPLETE/.test(l)), logs.join("\n"));

      h.domain.setSetting(SEED_MARKER_KEY, { stage: "complete", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
      const done = await runPopulatedSeed(h.app, { log: () => {} });
      assert.equal(done.complete, true);
      assert.ok(!done.incomplete);
    });

    it("ops-10: reset:sample keeps activation evidence, anonymised participants and unrelated jobs/CRM refs", async () => {
      const now = new Date().toISOString();
      h.domain.setSetting("evidence.client_uat_signoff", { at: now, by: "client" });
      h.domain.setSetting("evidence.restore_rehearsal", { at: now });
      h.db.prepare(`insert into participants (id, wa_phone_uid, first_name, surname, status, age_confirmed, created_at, updated_at) values ('p_erased','263999000001','erased','erased','deleted',1,?,?)`).run(now, now);
      h.db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) values ('job_keepme','winner.expire','{}','pending',?,?)`).run(now, now);
      h.db.prepare(`insert into crm_external_refs (entity_type, entity_id, provider, external_id, last_entity_version, updated_at) values ('participant','p_erased','webhook','ext-1',1,?)`).run(now);
      const dbFile = h.cfg.database;
      await h.close(); closed = true;

      const r = run("scripts/reset-sample.mjs", ["--confirm"], baseEnv({ DATABASE: dbFile, MEDIA_DIR: path.join(dir, "media") }));
      assert.equal(r.code, 0, r.out);
      const db = openDb(dbFile);
      const setting = (k) => db.prepare(`select value_json from settings where key=?`).get(k);
      assert.ok(setting("evidence.client_uat_signoff"), "client UAT sign-off must survive a sample reset");
      assert.ok(setting("evidence.restore_rehearsal"), "restore rehearsal evidence must survive a sample reset");
      assert.ok(db.prepare(`select id from participants where id='p_erased'`).get(), "an anonymised participant is not sample data");
      assert.ok(db.prepare(`select id from jobs where id='job_keepme'`).get(), "unrelated jobs must survive");
      assert.ok(db.prepare(`select external_id from crm_external_refs where entity_id='p_erased'`).get(), "unrelated CRM references must survive");
      assert.equal(db.prepare(`select count(*) n from campaigns`).get().n, 0, "the sample campaign itself is gone");
      assert.equal(db.prepare(`select count(*) n from receipts`).get().n, 0);
      assert.equal(db.prepare(`select count(*) n from settings where key='sample_journeys'`).get().n, 0, "the seed completion marker goes with the sample data");
      db.close();
    });
  });
});
