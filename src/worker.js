// Standalone worker process (optional: the server embeds one). Runs intake,
// jobs, outbox and CRM drains against the same database.
import { loadConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
const cfg = loadConfig();
const app = await createServer({ config: { ...cfg, port: 0 } });   // wiring without listening
app.worker.start();
console.log("[worker] started");
await new Promise(() => {});
