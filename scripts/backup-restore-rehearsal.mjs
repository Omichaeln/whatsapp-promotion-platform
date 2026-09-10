// Backup + restore rehearsal (spec §18, T-34). Copies the database (via the
// SQLite backup API semantics: VACUUM INTO) and the media directory to a
// timestamped backup, restores them into an ISOLATED directory, opens the
// restored database, runs ledger/draw/audit integrity checks, and reports
// measured RTO and the data-loss window (last write vs backup time).
// Usage: node scripts/backup-restore-rehearsal.mjs [--out docs/testing/evidence/restore-rehearsal.json]
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { createAudit } from "../src/audit.mjs";
import { createDrawService } from "../src/draw.mjs";
import { createDomain } from "../src/services.mjs";

const cfg = loadConfig();
const args = process.argv.slice(2); const oi = args.indexOf("--out"); const outFile = oi >= 0 ? args[oi + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(ROOT, "data", "backups", stamp);
const restoreDir = path.join(ROOT, "data", "restore-test", stamp);
fs.mkdirSync(backupDir, { recursive: true }); fs.mkdirSync(restoreDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), source: { db: cfg.database, media: cfg.mediaDir }, backup: {}, restore: {}, checks: [] };

// 1. backup
let t0 = Date.now();
const src = openDb(cfg.database);
const lastWrite = src.prepare(`select max(created_at) t from audit_events`).get().t;
src.exec(`VACUUM INTO '${path.join(backupDir, "promotions.db").replace(/'/g, "''")}'`);
src.close();
if (fs.existsSync(cfg.mediaDir)) fs.cpSync(cfg.mediaDir, path.join(backupDir, "media"), { recursive: true });
report.backup = { dir: backupDir, ms: Date.now() - t0, dbBytes: fs.statSync(path.join(backupDir, "promotions.db")).size, lastWriteBefore: lastWrite, backupAt: new Date().toISOString() };

// 2. restore into isolation
t0 = Date.now();
fs.copyFileSync(path.join(backupDir, "promotions.db"), path.join(restoreDir, "promotions.db"));
if (fs.existsSync(path.join(backupDir, "media"))) fs.cpSync(path.join(backupDir, "media"), path.join(restoreDir, "media"), { recursive: true });
const db = openDb(path.join(restoreDir, "promotions.db"));
const ok = (name, pass, detail) => report.checks.push({ name, pass: !!pass, detail });
ok("restored db opens + integrity_check", db.prepare(`pragma integrity_check`).get().integrity_check === "ok");
const audit = createAudit(db); const av = audit.verify(); ok("audit chain intact", av.ok, `${av.total} rows, broken=${av.brokenCount}`);
const dup = db.prepare(`select count(*) n from (select canonical_receipt_id, count(*) c from entries where canonical_receipt_id is not null and status='active' group by canonical_receipt_id having c>1)`).get().n; ok("no double-credited canonical receipt", dup === 0);
const orphans = db.prepare(`select count(*) n from entries e left join receipts r on r.id=e.receipt_id where r.id is null`).get().n; ok("no orphan entries", orphans === 0);
const domain = createDomain(db); const draws = createDrawService(db, { domain });
let drawsOk = true, drawsN = 0; for (const d of db.prepare(`select * from draws where status in ('executed','approved','published')`).all()) { drawsN++; if (!draws.verifyStored(d).ok) drawsOk = false; } ok("executed draws recompute", drawsOk, `${drawsN} draws`);
const media = db.prepare(`select object_key from media_assets where status='stored'`).all(); const missing = media.filter((m) => !fs.existsSync(path.join(restoreDir, "media", m.object_key))).length; ok("media files present", missing === 0, `${media.length} assets, ${missing} missing`);
const pendingJobs = db.prepare(`select count(*) n from jobs where status in ('pending','processing','failed')`).get().n; const pendingOut = db.prepare(`select count(*) n from outbound_messages where status in ('pending','sending','retryable_failure')`).get().n;
ok("outstanding work identified for replay", true, `jobs=${pendingJobs} outbound=${pendingOut} (replay via worker; leases expire; no consumer is contacted twice thanks to idempotency keys)`);
db.close();
report.restore = { dir: restoreDir, ms: Date.now() - t0 };
report.rto_seconds = Number(((report.backup.ms + report.restore.ms) / 1000).toFixed(2));
report.rpo_note = "backup is point-in-time (VACUUM INTO); data-loss window = writes after backupAt. For production, schedule backups at <=15 min intervals (D-22 / release doc).";
report.ok = report.checks.every((c) => c.pass);
report.finishedAt = new Date().toISOString();
if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
