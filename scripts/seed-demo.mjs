// Populated TEST ONLY seed (spec §19): sample campaign, 80 outlets, periods,
// decisions, sample staff, synthetic participants, and real fixture images
// pushed through the REAL pipeline (OCR) so every screen has data:
// qualified entries, duplicates, rejected, pending review, delayed, two
// historical draws (one published with winners in several states).
// Usage: node scripts/seed-demo.mjs [--light]   (idempotent per campaign)
import { loadConfig } from "../src/config.mjs";
import { runPopulatedSeed } from "../src/demo-journeys.mjs";
import { createServer } from "../src/server.mjs";
import { ensureDemoSeed, ensureSampleStaff, SAMPLE_CODE } from "../src/demo-seed.mjs";
import { openDb } from "../src/db.mjs";

const cfg = loadConfig();
if (cfg.environment === "production") { console.error("refusing to seed sample data in production"); process.exit(2); }
{ const db = openDb(cfg.database); const r = ensureDemoSeed(db); db.close(); console.log(r.seeded ? `[seed] created ${SAMPLE_CODE}` : `[seed] ${SAMPLE_CODE} already present`); }
const app = await createServer({ config: cfg, log: { log: () => {}, error: (...a) => console.error(...a) } });
const { auth } = app;
const staff = ensureSampleStaff(auth);
for (const s of staff) console.log(`[seed] staff ${s.email} (${s.roles.join(",")}) temporary password: ${s.temporaryPassword}`);
const light = process.argv.includes("--light");
if (light) { console.log("[seed] light seed; done"); await app.close(); process.exit(0); }
await runPopulatedSeed(app);
await app.close();
process.exit(0);
