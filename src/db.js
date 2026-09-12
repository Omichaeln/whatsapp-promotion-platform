// CLI entrypoint for database operations (DEF-01).
// Usage:
//   node src/db.js migrate          apply pending migrations
//   node src/db.js migrate --dry    show pending without applying
//   node src/db.js seed             alias: npm run seed
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadEnvFile, ROOT } from "./config.mjs";
import { DatabaseSync } from "node:sqlite";
import { openDb, migrate } from "./db.mjs";
import { ensureDemoSeed } from "./demo-seed.mjs";

// npm's `migrate` script does not pass --env-file, so without this the CLI
// would migrate the default database while the service runs another one.
loadEnvFile();
const cfg = loadConfig();
const command = process.argv[2] || "migrate";
const dry = process.argv.includes("--dry");

if (command === "migrate" && dry) {
  // --dry used to call migrate() and only suppress its log, so the command
  // documented as "show pending without applying" applied every pending
  // migration — against production, outside the change window, before any
  // backup. Compute the pending set from the files and write nothing at all
  // (not even the database file, if the path does not exist yet).
  const files = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  let applied = [];
  if (cfg.database !== ":memory:" && fs.existsSync(cfg.database)) {
    // Read-only on purpose: openDb runs `PRAGMA journal_mode=WAL`, which
    // rewrites the header of a non-WAL database and leaves -wal/-shm siblings.
    // A command whose whole defect was "it writes when it says it does not"
    // must not open the production file read-write.
    const db = new DatabaseSync(cfg.database, { readOnly: true });
    const hasMeta = !!db.prepare(`select name from sqlite_master where type='table' and name='schema_meta'`).get();
    applied = hasMeta ? (db.prepare(`select value from schema_meta where key='migrations'`).get()?.value?.split(",").filter(Boolean) || []) : [];
    db.close();
  }
  const pending = files.filter((f) => !applied.includes(f));
  console.log(`dry run: ${pending.length} migration(s) would apply`, pending.length ? "" : "(schema up to date)");
  if (pending.length) console.log(pending.map((p) => "  - " + p).join("\n"));
  console.log(`dry run: nothing was applied to ${cfg.database}; re-run without --dry to apply`);
} else if (command === "migrate") {
  const db = openDb(cfg.database);
  const count = migrate(db, undefined, (msg) => console.log(msg));
  console.log(`migrate: ${count} applied, schema up to date`);
  db.close();
} else if (command === "seed") {
  const db = openDb(cfg.database);
  const r = ensureDemoSeed(db, { force: process.argv.includes("--force") });
  console.log(r.seeded ? `seeded ${r.campaign.code}` : `${r.campaign.code} already present (use --force to re-version)`);
  db.close();
} else {
  console.error(`unknown command "${command}" (expected: migrate | seed)`);
  process.exit(1);
}
