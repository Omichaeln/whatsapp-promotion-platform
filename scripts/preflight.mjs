// Environment preflight (spec §19): dependencies, configuration, migration
// state, storage, provider modes, connectivity. Never prints secret values.
// Usage: node scripts/preflight.mjs   (exit 0 ok, 1 blocking problems)
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig, loadEnvFile, dataVolumeStatus, CONFIG_SCHEMA, ROOT } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";

// npm runs preflight without --env-file while start/worker/seed/reset all load
// .env, so the one pre-deploy gate used to validate the *default*
// configuration and exit 0 while the service ran a different one (green on a
// production .env it had never read). Load the same file node would.
const envFile = loadEnvFile();
const cfg = loadConfig();
const out = { checkedAt: new Date().toISOString(), node: process.version, environment: cfg.environment, envFile: envFile.loaded ? envFile.file : (envFile.reason || null), checks: [] };
const ok = (name, pass, detail = "", blocking = true) => out.checks.push({ name, pass: !!pass, detail, blocking });

ok("node >= 22.13", Number(process.versions.node.split(".")[0]) >= 22, process.version);
for (const dep of ["sharp", "tesseract.js", "@tesseract.js-data/eng"]) { try { fs.accessSync(path.join(ROOT, "node_modules", dep, "package.json")); ok(`dependency ${dep}`, true); } catch { ok(`dependency ${dep}`, false, "run npm ci"); } }
try { const sharp = (await import("sharp")).default; const m = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>`)).png().toBuffer(); ok("sharp renders", m.length > 0); } catch (e) { ok("sharp renders", false, e.message); }
const problems = validateConfig(cfg); ok("configuration valid for environment", problems.length === 0, problems.join("; "));
for (const [name, def, desc, secret] of CONFIG_SCHEMA) { const v = process.env[name]; if (secret) ok(`secret ${name}`, cfg.environment === "local" || !!v, v ? "set" : `not set (${desc})`, ["IDENTITY_KEY", "ADMIN_PASSWORD", "AUDIT_CHECKPOINT_KEY"].includes(name) && cfg.environment !== "local"); }
// A missing volume looks exactly like a healthy first boot until the next
// deploy discards the container layer with every row in it. This check runs
// BEFORE the media and database checks because those two used to CREATE what
// this one is gating: on an unmounted host preflight reported
// "data volume mounted: pass=false" and, in the same run, created
// <VOLUME_PATH>/promotions.db and /media - after which the next boot adopted
// that ephemeral directory as the volume and the gate could never fire again.
const vol = dataVolumeStatus(cfg);
const volBlocked = vol.checked && !vol.ok;
ok("data volume mounted", !volBlocked, vol.checked ? `${vol.dir} ${vol.ok ? "marked" : `has no marker (VOLUME_INIT=true once to provision${vol.dbExists ? "; the database already exists there" : ""})`}` : "VOLUME_PATH not set (check disabled)", vol.checked);
if (volBlocked) {
  const skipped = `not checked: ${vol.dir} is not the mounted volume; creating files here would make the volume check pass on the next boot`;
  ok("media dir writable", false, skipped, false);
  ok("database opens", false, skipped, false);
} else {
try { fs.mkdirSync(cfg.mediaDir, { recursive: true }); fs.writeFileSync(path.join(cfg.mediaDir, ".preflight"), "ok"); fs.rmSync(path.join(cfg.mediaDir, ".preflight")); ok("media dir writable", true, cfg.mediaDir); } catch (e) { ok("media dir writable", false, e.message); }
try { const db = openDb(cfg.database); const hasMeta = !!db.prepare(`select name from sqlite_master where type='table' and name='schema_meta'`).get(); const applied = hasMeta ? (db.prepare(`select value from schema_meta where key='migrations'`).get()?.value?.split(",").filter(Boolean) || []) : []; const files = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")); ok("migrations applied", applied.length === files.length, `${applied.length}/${files.length} (run npm run migrate)`, false); const env = hasMeta ? db.prepare(`select value from schema_meta where key='environment'`).get()?.value : null; ok("db environment matches", !env || env === cfg.environment, `db=${env || "unset"} cfg=${cfg.environment}`, false); ok("sample data indicator", true, hasMeta && db.prepare(`select name from sqlite_master where name='settings'`).get() && db.prepare(`select value_json from settings where key='sample_data'`).get() ? "TEST ONLY sample data present" : "no sample data", false); db.close(); } catch (e) { ok("database opens", false, e.message); }
}
ok("transport mode", true, `${cfg.whatsappTransport}${cfg.whatsappTransport === "simulator" ? " (SIMULATED — not WhatsApp)" : ""}`, false);
ok("extractor mode", cfg.receiptExtractor !== "simulator" || cfg.environment === "local", `${cfg.receiptExtractor}${cfg.receiptExtractor === "simulator" ? " (SIMULATED — does not read pixels)" : cfg.receiptExtractor === "vision" && !cfg.receipt.openaiApiKey ? " (unconfigured: no key)" : ""}`);
ok("crm mode", true, cfg.crm.provider === "none" ? "not_configured (events queue visibly)" : `${cfg.crm.provider} -> ${cfg.crm.webhookUrl}`, false);
if (cfg.whatsappTransport === "cloud-api") { try { const r = await fetch("https://graph.facebook.com/", { signal: AbortSignal.timeout(6000), redirect: "manual" }); ok("graph.facebook.com reachable", r.status < 500, `HTTP ${r.status}`); } catch (e) { ok("graph.facebook.com reachable", false, e.message); } }
if (cfg.crm.provider === "webhook") { try { const r = await fetch(`${cfg.crm.webhookUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(6000), headers: cfg.crm.webhookToken ? { authorization: `Bearer ${cfg.crm.webhookToken}` } : {} }); ok("crm endpoint reachable", r.ok, `HTTP ${r.status}`); } catch (e) { ok("crm endpoint reachable", false, e.message); } }
ok("fixtures present", fs.existsSync(path.join(ROOT, "fixtures", "receipts", "manifest.json")), "run node scripts/gen-fixtures.mjs", false);
ok("console built", fs.existsSync(path.join(ROOT, "src", "web-console-dist", "index.html")), "run npm run web:build", false);
const failed = out.checks.filter((c) => !c.pass && c.blocking);
out.ok = failed.length === 0;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
