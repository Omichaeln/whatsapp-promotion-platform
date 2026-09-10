// Deploy entrypoint (Procfile `web`): migrate -> (non-production) sample seed -> HTTP server + embedded worker.
import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { ensureDemoSeed, ensureSampleStaff } from "./demo-seed.mjs";
import { createServer } from "./server.mjs";

const cfg = loadConfig();
if (cfg.environment !== "production") { const db = openDb(cfg.database); const seed = ensureDemoSeed(db); if (seed.seeded) console.log(`[bootstrap] seeded TEST ONLY campaign ${seed.campaign.code}`); db.close(); }
const app = await createServer({ config: cfg });
if (cfg.environment !== "production") { const created = ensureSampleStaff(app.auth); for (const s of created) console.log(`[bootstrap] sample staff ${s.email} temporary password: ${s.temporaryPassword}`); }
await app.listen();
app.worker.start();
console.log("[bootstrap] worker started");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { console.log(`[bootstrap] ${sig} - shutting down`); await app.close(); process.exit(0); });
