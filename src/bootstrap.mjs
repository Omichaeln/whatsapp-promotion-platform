// Deploy entrypoint (Procfile `web`): migrate -> (non-production) sample seed -> HTTP server + embedded worker.
import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { ensureDemoSeed, ensureSampleStaff, recordedEnvironment } from "./demo-seed.mjs";
import { createServer } from "./server.mjs";
import { runPopulatedSeed } from "./demo-journeys.mjs";

const cfg = loadConfig();
// The DATABASE decides, not the variable: ENVIRONMENT can be missing or
// mistyped, and on Railway it then falls back to "staging".
{
  const db = openDb(cfg.database);
  const recorded = recordedEnvironment(db);
  if (recorded === "production" || cfg.environment === "production") {
    if (recorded && recorded !== cfg.environment) console.log(`[bootstrap] database is recorded as ${recorded}; sample data refused`);
  } else {
    const seed = ensureDemoSeed(db);
    if (seed.seeded) console.log(`[bootstrap] seeded TEST ONLY campaign ${seed.campaign.code}`);
  }
  db.close();
}
const app = await createServer({ config: cfg });
if (app.environment !== "production" && cfg.environment !== "production") {
  const created = ensureSampleStaff(app.auth, { db: app.db });
  for (const s of created) console.log(`[bootstrap] sample staff ${s.email} temporary password: ${s.temporaryPassword}`);
}
await app.listen();
app.worker.start();
console.log("[bootstrap] worker started");
if (cfg.seedPopulated && cfg.environment !== "production" && app.environment !== "production") {
  // after the server is up (health passes): fixture receipts through the real pipeline + sample draw, ~1-2 min
  console.log("[bootstrap] SEED_POPULATED: running sample journeys in the background");
  runPopulatedSeed(app).then((r) => console.log(`[bootstrap] sample journeys ${r?.already ? "already present" : "complete"}`)).catch((e) => console.error("[bootstrap] sample journeys failed", e));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { console.log(`[bootstrap] ${sig} - shutting down`); await app.close(); process.exit(0); });
