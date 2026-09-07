// Entrypoint: boots config + HTTP server + embedded worker loop (single node).
import { loadConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { createWorker } from "./worker.mjs";

const cfg = loadConfig();
const app = await createServer({ config: cfg });
await app.listen();
const worker = createWorker({ db: app.db, outbox: app.outbox, crm: app.crm, transport: app.transport, intervalMs: 1500 });
worker.start();

const shutdown = async (sig) => {
  console.log(`[server] ${sig} - shutting down`);
  worker.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));