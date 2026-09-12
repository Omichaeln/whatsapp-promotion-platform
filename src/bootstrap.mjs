// Deploy entrypoint (Procfile `web`): migrate -> (non-production) sample seed -> HTTP server + embedded worker.
import { loadConfig, dataVolumeStatus, markDataVolume, VOLUME_MARKER } from "./config.mjs";
import { openDb } from "./db.mjs";
import { ensureDemoSeed, ensureSampleStaff, recordedEnvironment } from "./demo-seed.mjs";
import { createServer } from "./server.mjs";
import { runPopulatedSeed } from "./demo-journeys.mjs";

const cfg = loadConfig();
// The persistent volume must be proven BEFORE anything opens the database:
// openDb would otherwise create a brand-new database inside the container's
// ephemeral layer when the volume is missing or mounted elsewhere, boot green,
// take registrations and receipts, and lose all of it on the next deploy.
{
  const vol = dataVolumeStatus(cfg);
  if (vol.checked && !vol.ok) {
    // A directory that already holds the database is the volume (adopting it
    // keeps existing deployments booting); a new one must be provisioned once.
    if (vol.dbExists || /^(1|true|yes)$/i.test(process.env.VOLUME_INIT || "")) {
      markDataVolume(cfg);
      console.log(`[bootstrap] marked data volume ${vol.dir} (${vol.dbExists ? "adopted existing database" : "VOLUME_INIT"})`);
    } else {
      console.error(`[bootstrap] ${vol.dir} carries no ${VOLUME_MARKER} marker: the persistent volume is not mounted there. Refusing to create a database in ephemeral storage. Provision once with VOLUME_INIT=true, or set VOLUME_PATH= to disable this check.`);
      process.exit(1);
    }
  }
}
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
  // "already present" used to be logged for a half-populated database too (the
  // guard was "does this campaign have any receipts"), so an interrupted seed
  // looked finished for ever. runPopulatedSeed now reports incompleteness.
  runPopulatedSeed(app).then((r) => console.log(r?.incomplete ? `[bootstrap] sample journeys INCOMPLETE (last stage: ${r.stage || "unknown"}) - reset and re-seed: npm run reset:sample && npm run seed` : `[bootstrap] sample journeys ${r?.already ? "already present" : "complete"}`)).catch((e) => console.error("[bootstrap] sample journeys failed", e));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { console.log(`[bootstrap] ${sig} - shutting down`); await app.close(); process.exit(0); });
