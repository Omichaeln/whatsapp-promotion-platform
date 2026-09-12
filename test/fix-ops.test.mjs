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
import { execFileSync, spawn } from "node:child_process";
import { describe, it, before, after, assert, buildApp, ROOT } from "./helpers.mjs";
import { loadConfig, validateConfig, dataVolumeStatus, markDataVolume, ensureDataVolume } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { runPopulatedSeed, seedComplete, seedEntries, seedReviewTasks, SEED_PHONES, SEED_MARKER_KEY } from "../src/demo-journeys.mjs";

const NODE = process.execPath;
const tmpDirs = [];
const tmp = (label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `wpp-ops-${label}-`)); tmpDirs.push(d); return d; };
const run = (script, args, env) => {
  try { return { code: 0, out: execFileSync(NODE, ["--no-warnings=ExperimentalWarning", script, ...args], { cwd: ROOT, env, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};
const baseEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });
/** Start an entrypoint that stays up, wait for `file` to appear, then kill it. */
const runUntilFile = (script, env, file, timeoutMs = 25_000) => new Promise((resolve) => {
  const child = spawn(NODE, ["--no-warnings=ExperimentalWarning", script], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; const add = (d) => { out += d; };
  child.stdout.on("data", add); child.stderr.on("data", add);
  const t0 = Date.now();
  const done = (appeared) => { clearInterval(timer); child.kill("SIGKILL"); resolve({ appeared, out }); };
  const timer = setInterval(() => {
    if (fs.existsSync(file)) return done(true);
    if (child.exitCode !== null || Date.now() - t0 > timeoutMs) return done(fs.existsSync(file));
  }, 100);
});

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

    // ...and must not touch the existing file either: openDb runs
    // `PRAGMA journal_mode=WAL`, which rewrites the header of a non-WAL
    // database and drops -wal/-shm beside it. A command whose defect was
    // "it writes when it says it does not" opens read-only.
    const plain = openDb(dbFile); plain.exec("PRAGMA journal_mode=delete"); plain.close();
    const before = fs.readFileSync(dbFile);
    const dry3 = run("src/db.js", ["migrate", "--dry"], baseEnv({ DATABASE: dbFile }));
    assert.match(dry3.out, /dry run: 0 migration\(s\) would apply/, dry3.out);
    assert.deepEqual(fs.readFileSync(dbFile), before, "a dry run must leave the database byte-identical");
    assert.equal(fs.existsSync(`${dbFile}-wal`), false, "a dry run must not leave WAL siblings beside the production file");
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

    // VOLUME_INIT is re-read on every boot and stays set in a Railway variable
    // group once used, so it must be loud in both directions: it disables the
    // check for every future deploy, including one onto an ephemeral directory
    // after the volume is detached.
    const fresh = tmp("vol-init");
    const cfg2 = loadConfig({ ENVIRONMENT: "staging", VOLUME_PATH: fresh, DATABASE: path.join(fresh, "promotions.db"), MEDIA_DIR: path.join(fresh, "media"), ADMIN_PASSWORD: "StagingPassword12345", IDENTITY_KEY: "identity-key-0123456789" });
    const errs = []; const log = { log: () => {}, error: (m) => errs.push(String(m)) };
    assert.equal(ensureDataVolume(cfg2, { init: "", log }).ok, false, "an empty directory is not the volume");
    assert.equal(fs.existsSync(path.join(fresh, ".volume-id")), false, "a refusal must write nothing");
    assert.equal(ensureDataVolume(cfg2, { init: "true", log }).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, ".volume-id"), "utf8")).provisionedBy, "VOLUME_INIT", "the marker records who provisioned it");
    assert.ok(errs.some((m) => /UNSET VOLUME_INIT/.test(m)), `provisioning must say to unset it: ${errs.join(" | ")}`);
    errs.length = 0;
    ensureDataVolume(cfg2, { init: "true", log });   // the next deploy, variable still set
    assert.ok(errs.some((m) => /still set/.test(m)), "a VOLUME_INIT left set must warn on every later boot, not pass silently");
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

    // Only THIS run's copy was removed, so the stamps earlier runs left behind
    // stayed for ever: the audit found two, 42 MB of full database plus every
    // receipt image, invisible to anonymisation, media purge and retention.
    const stale = path.join(backups, "restore-test", "2026-01-01T00-00-00-000Z");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "promotions.db"), "an earlier rehearsal's copy of every name, phone and receipt");
    const third = run("scripts/backup-restore-rehearsal.mjs", ["--backup-dir", backups, "--keep", "1"], env);
    assert.equal(third.code, 0, third.out);
    const thirdReport = JSON.parse(third.out.slice(third.out.indexOf("{")));
    assert.deepEqual(thirdReport.restore.prunedStale, ["2026-01-01T00-00-00-000Z"], JSON.stringify(thirdReport.restore));
    assert.equal(fs.existsSync(stale), false, "a restore copy from an earlier run must not survive the rehearsal");
    assert.equal(fs.existsSync(path.join(backups, "restore-test")), false);

    // npm's `restore:rehearsal` is not started with --env-file-if-exists, so
    // BACKUP_DIR in a .env was read by nobody and the rehearsal quietly wrote
    // its copies onto the data volume it exists to prove it can lose.
    const envFile = path.join(dir, "rehearsal.env");
    const fromEnv = path.join(dir, "bk-from-env");
    fs.writeFileSync(envFile, `BACKUP_DIR=${fromEnv}\n`);
    const viaEnv = run("scripts/backup-restore-rehearsal.mjs", [], baseEnv({ DATABASE: dbFile, MEDIA_DIR: path.join(dir, "media"), ENV_FILE: envFile }));
    assert.equal(viaEnv.code, 0, viaEnv.out);
    assert.ok(fs.existsSync(path.join(fromEnv, "backups")), "BACKUP_DIR from the env file must be honoured");
    assert.equal(fs.existsSync(path.join(ROOT, "data", "restore-test")), false, "the default data directory must not collect restore copies");
  });

  it("durability-2: runPopulatedSeed backdates only its own entries while a tester is using the same campaign", async () => {
    // The load-bearing half of durability-2 is WHERE the seed's UPDATEs point,
    // and that lives in runPopulatedSeed, not in the selectors: the call sites
    // can go back to the campaign-only queries with seedEntries/seedReviewTasks
    // still exported and still correct. So drive the real seed, with a tester
    // registering and submitting DURING the run — exactly the window the seed
    // occupies on a live UAT environment, 1-2 minutes after the server is up.
    const dir = tmp("seedrun");
    const h = await buildApp({ extractor: "simulator", env: { DATABASE: path.join(dir, "s.db"), MEDIA_DIR: path.join(dir, "media") } });
    try {
      const tester = "263771555002";
      const seedPhone = SEED_PHONES[11];
      const [imgA, imgB, imgS] = await Promise.all([h.simImage(h.simReceipt({ no: "880001" })), h.simImage(h.simReceipt({ no: "880002" })), h.simImage(h.simReceipt({ no: "880003" }))]);
      let mid = 0;
      const send = (phone, text, image = null) => h.app.intake.receive({ provider: "simulator", providerMessageId: `inj_${++mid}`, phoneUid: phone, type: image ? "message.image" : "message.text", text: text || "", inlineMediaB64: image ? image.toString("base64") : null, timestamp: new Date().toISOString() });
      const submit = (phone, image) => { send(phone, "2"); send(phone, "sunrise westgate harare"); send(phone, "1"); send(phone, "", image); };
      // intake.receive is synchronous and durable, so the seed's own
      // drain()/tick() picks these up: a tester message arriving mid-run.
      let joined = false, planted = false, lateStageAt = null;
      const logs = [];
      const log = (m) => {
        logs.push(String(m));
        if (!joined && /fixture receipts/.test(String(m))) {
          joined = true;
          for (const t of ["hi", "1", "Tester", "One", "TEST7777X", "Harare", "yes", "yes"]) send(tester, t);
          submit(tester, imgA); submit(tester, imgB);
          submit(seedPhone, imgS);  // a seed-owned entry, so "nothing was moved" cannot pass vacuously
        } else if (joined && !planted && /draw-pool receipts/.test(String(m))) {
          planted = true;
          lateStageAt = new Date().toISOString();
          const rs = h.db.prepare(`select r.id from receipts r join participants p on p.id=r.participant_id where p.wa_phone_uid=? order by r.created_at`).all(tester);
          assert.equal(rs.length, 2, "the tester's two receipts reached the pipeline mid-seed");
          // The second receipt is put where the seed's review sweep aims: a
          // tester's receipt awaiting a human decision in the historical window
          // (a back-dated or unreadable slip). The sweep decides every such task
          // NOT_QUALIFIED to clear the draw barrier; deciding a tester's is the
          // failure. REVIEW_REQUIRED matters — receipt-pipeline.review refuses a
          // QUALIFIED receipt, so a credited one could not show the difference.
          h.db.prepare(`update receipts set period_code='W-2', status='REVIEW_REQUIRED' where id=?`).run(rs[1].id);
          h.db.prepare(`delete from entries where receipt_id=?`).run(rs[1].id);
          h.db.prepare(`insert into review_tasks (id, receipt_id, state, sla_due_at, created_at) values (?,?,'open',?,?)`).run("rt_tester_seed", rs[1].id, new Date().toISOString(), new Date().toISOString());
        }
      };
      await runPopulatedSeed(h.app, { log });
      assert.ok(joined && planted, `the seed did not reach both injection points:\n${logs.join("\n")}`);

      const entriesFor = (phone) => h.db.prepare(`select e.period_code, e.draw_period from entries e join participants p on p.id=e.participant_id where p.wa_phone_uid=?`).all(phone);
      const testerEntries = entriesFor(tester);
      assert.equal(testerEntries.length, 1, "the tester's live entry survived the seed");
      for (const e of testerEntries) {
        assert.ok(!["W-2", "W-1"].includes(e.period_code), `the seed rewrote a tester's entry into the historical pool (${e.period_code})`);
        assert.ok(!["W-2", "W-1"].includes(e.draw_period), `the seed made a tester's entry drawable in ${e.draw_period}`);
      }
      assert.ok(entriesFor(seedPhone).some((e) => ["W-2", "W-1"].includes(e.period_code)), "the seed did backdate its OWN entry, so the sweep really ran");
      const strays = h.db.prepare(`select p.wa_phone_uid u from entries e join participants p on p.id=e.participant_id where e.period_code in ('W-2','W-1')`).all().map((r) => r.u).filter((u) => !SEED_PHONES.includes(u));
      assert.deepEqual(strays, [], "the historical draw pool must hold only the seed's own participants");
      assert.notEqual(h.db.prepare(`select state from review_tasks where id='rt_tester_seed'`).get().state, "decided", "the seed's review sweep decided a tester's task");

      // startedAt was recomputed inside stage(), so the marker recorded the LAST
      // stage transition instead of when the run began.
      const done = h.domain.getSetting(SEED_MARKER_KEY, null);
      assert.ok(done.startedAt < lateStageAt, `startedAt (${done.startedAt}) must predate the late stages (${lateStageAt}), not be rewritten by them`);
      assert.ok(done.startedAt <= done.completedAt);

      // durability-6: the same finished run, seen as a database seeded before
      // the completion marker existed. The draw here is left blocked (the seed
      // logs it and moves on), so "a published draw with winners" reported a
      // finished run as INCOMPLETE for ever — and told the operator to wipe it.
      assert.ok(logs.some((l) => /draw W-2 blocked/.test(l)), `this case needs the blocked-draw run:\n${logs.join("\n")}`);
      h.db.prepare(`delete from settings where key=?`).run(SEED_MARKER_KEY);
      assert.equal(seedComplete(h.db, h.domain, h.campaign.id).complete, true, "a finished pre-marker run whose draw was blocked must not read as incomplete");
      const again = await runPopulatedSeed(h.app, { log: () => {} });
      assert.equal(again.complete, true, JSON.stringify(again));
      assert.ok(!again.incomplete);
      assert.ok(h.domain.getSetting(SEED_MARKER_KEY, null)?.completedAt, "the inferred completion is written back once");
    } finally { await h.close(); }
  });

  it("ops-9 (bootstrap): the deploy entrypoint refuses a directory only preflight/migrate touched, and still adopts a live one", async () => {
    // The bootstrap block is the half of ops-9 that decides whether every
    // existing deployment keeps booting, and it had no test. Adoption used to
    // key on "promotions.db exists" — which `npm run preflight` and
    // `npm run migrate`, the two commands docs/TEST_READINESS.md tells the
    // operator to run first, create themselves on a host with no volume.
    const dir = tmp("boot");
    const dbFile = path.join(dir, "promotions.db");
    const marker = path.join(dir, ".volume-id");
    const env = baseEnv({ ENVIRONMENT: "staging", VOLUME_PATH: dir, DATABASE: dbFile, MEDIA_DIR: path.join(dir, "media"), ADMIN_PASSWORD: "StagingPassword12345", IDENTITY_KEY: "identity-key-0123456789", AUDIT_CHECKPOINT_KEY: "checkpoint-key", PORT: "5987", ENV_FILE: path.join(dir, "absent.env") });

    const empty = run("src/bootstrap.mjs", [], env);
    assert.equal(empty.code, 1, `an unmarked directory must refuse to boot:\n${empty.out}`);
    assert.match(empty.out, /\.volume-id/);
    assert.match(empty.out, /VOLUME_INIT/, "the refusal must name the remedy");
    assert.equal(fs.existsSync(dbFile), false, "the refused boot must not create the database in ephemeral storage");

    const pre = run("scripts/preflight.mjs", [], env);
    assert.equal(pre.code, 1, `preflight must fail on an unmounted volume:\n${pre.out}`);
    assert.equal(fs.existsSync(dbFile), false, "preflight must not create the database inside the directory whose absence it is reporting");
    assert.equal(fs.existsSync(path.join(dir, "media")), false, "preflight must not create the media dir there either");

    assert.equal(run("src/db.js", ["migrate"], env).code, 0);
    assert.ok(fs.existsSync(dbFile), "migrate does create the file (that is its job)");
    const afterMigrate = run("src/bootstrap.mjs", [], env);
    assert.equal(afterMigrate.code, 1, `a migrate-only database is not evidence of a mounted volume:\n${afterMigrate.out}`);
    assert.equal(fs.existsSync(marker), false, "nothing may be adopted on the strength of a file migrate created");

    // A database a service has actually run against IS the volume: existing
    // deployments must keep booting.
    const db = openDb(dbFile);
    db.prepare(`insert or ignore into schema_meta (key, value) values ('environment', 'staging')`).run();
    db.close();
    const live = await runUntilFile("src/bootstrap.mjs", env, marker);
    assert.equal(live.appeared, true, `an existing deployment must still be adopted:\n${live.out}`);
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).provisionedBy, "adopted-live-database");
  });

  describe("with a running app", () => {
    let h, dir, closed = false;
    before(async () => { dir = tmp("app"); h = await buildApp({ extractor: "simulator", env: { DATABASE: path.join(dir, "t.db"), MEDIA_DIR: path.join(dir, "media") } }); });
    after(async () => { if (!closed) await h.close(); });

    it("durability-2 (unit): the seed's selectors return only seed-owned rows", async () => {
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
