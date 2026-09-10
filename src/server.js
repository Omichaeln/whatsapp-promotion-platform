// Entrypoint: config + HTTP server + embedded worker loop (single node process).
import { loadConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
const cfg = loadConfig();
const app = await createServer({ config: cfg });
await app.listen();
app.worker.start();
const shutdown = async (sig) => { console.log(`[server] ${sig} - shutting down`); await app.close(); process.exit(0); };
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
