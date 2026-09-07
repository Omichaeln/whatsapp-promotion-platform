// Standalone durable worker process (optional; server.js embeds one too).
import { loadConfig } from "./config.mjs";
import { openDb, migrate } from "./db.mjs";
import { createOutbox } from "./outbox.mjs";
import { createCrm } from "./crm.mjs";
import { createWorker } from "./worker.mjs";
import { SimulatorTransport } from "./transport/simulator.mjs";
import { CloudApiTransport } from "./transport/cloud-api.mjs";

const cfg = loadConfig();
const db = openDb(cfg.database);
migrate(db);
const transport = cfg.whatsappTransport === "cloud-api"
  ? new CloudApiTransport({ meta: cfg.meta, publicBaseUrl: cfg.publicBaseUrl, webhookToken: cfg.webhookToken })
  : new SimulatorTransport();
const outbox = createOutbox(db);
const crm = createCrm({ db, cfg: cfg.crm });
const worker = createWorker({ transport, outbox, crm, intervalMs: 1500 });
worker.start();
console.log("[worker] started");
await new Promise(() => {});