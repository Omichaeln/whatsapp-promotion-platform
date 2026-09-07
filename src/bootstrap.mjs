// Railway deploy entrypoint (Procfile `web`).
// migrate -> seed demo campaign on empty DB -> HTTP server -> worker loop.
import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { ensureDemoSeed } from "./demo-seed.mjs";
import { createServer } from "./server.mjs";
import { createWorker } from "./worker.mjs";

const cfg = loadConfig();
const db = openDb(cfg.database);
const seed = ensureDemoSeed(db);
if (seed.seeded) console.log(`[bootstrap] seeded demo campaign ${seed.campaign.code}`);
db.close();

const app = await createServer({ config: cfg });
await app.listen();
const worker = createWorker({ db: app.db, outbox: app.outbox, crm: app.crm, transport: app.transport, intervalMs: 1500 });
worker.start();
console.log("[bootstrap] worker started");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`[bootstrap] ${sig} - shutting down`);
    worker.stop();
    await app.close();
    process.exit(0);
  });
}