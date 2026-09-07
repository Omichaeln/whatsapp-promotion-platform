// Seed a demo campaign with frozen rules, outlets and products (local dev).
// Usage: npm run seed   (DATABASE defaults to ./data/promotions.db)
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { ensureDemoSeed } from "../src/demo-seed.mjs";

const cfg = loadConfig();
const db = openDb(cfg.database);
const { campaign, seeded, versionId, outletCount } = ensureDemoSeed(db, { force: process.argv.includes("--force") });
console.log("seed complete");
console.log(JSON.stringify({ campaign: campaign.code, status: "active", seeded: !!seeded, version: versionId, outlets: outletCount }, null, 2));
db.close();