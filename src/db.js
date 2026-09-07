// CLI entrypoint for database operations (DEF-01).
// Usage:
//   node src/db.js migrate          apply pending migrations
//   node src/db.js migrate --dry    show pending without applying
//   node src/db.js seed             alias: npm run seed
import { loadConfig } from "./config.mjs";
import { openDb, migrate } from "./db.mjs";
import { ensureDemoSeed } from "./demo-seed.mjs";

const cfg = loadConfig();
const command = process.argv[2] || "migrate";
const dry = process.argv.includes("--dry");

if (command === "migrate") {
  const db = openDb(cfg.database);
  // ensure schema_meta exists before reading it (migrate() also creates it)
  try { db.exec(`create table if not exists schema_meta (key text primary key, value text not null)`); } catch { /* ignore */ }
  const before = db.prepare(`select value from schema_meta where key='migrations'`).get()?.value?.split(",").filter(Boolean) || [];
  const applied = migrate(db, undefined, (msg) => {
    if (!dry) console.log(msg);
  });
  if (dry) {
    const after = db.prepare(`select value from schema_meta where key='migrations'`).get()?.value?.split(",").filter(Boolean) || [];
    const pending = after.filter((m) => !before.includes(m));
    console.log(`dry run: ${pending.length} migration(s) would apply`, pending.length ? "" : "(schema up to date)");
    if (pending.length) console.log(pending.map((p) => "  - " + p).join("\n"));
  } else {
    console.log(`migrate: ${applied} applied, schema up to date`);
  }
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