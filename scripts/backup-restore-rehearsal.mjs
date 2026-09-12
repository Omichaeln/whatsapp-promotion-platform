// Backup + restore rehearsal (spec §18, T-34). Copies the database (via the
// SQLite backup API semantics: VACUUM INTO) and the media directory to a
// timestamped backup, restores them into an ISOLATED directory, opens the
// restored database, runs ledger/draw/audit integrity checks, and reports
// measured RTO and the data-loss window (last write vs backup time).
// The restore copy is ALWAYS deleted again: it is a second unencrypted copy of
// every name, phone, conversation log and receipt image, invisible to media
// purge, anonymisation and retention. Backups are pruned to --keep runs for the
// same reason, and --backup-dir can place them off the data volume (whose loss
// is the event the rehearsal exists to survive).
// Usage: node scripts/backup-restore-rehearsal.mjs [--out docs/testing/evidence/restore-rehearsal.json]
//                                                  [--backup-dir DIR] [--keep N]
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import { createAudit } from "../src/audit.mjs";
import { createDrawService } from "../src/draw.mjs";
import { createDomain } from "../src/services.mjs";

const cfg = loadConfig();
const args = process.argv.slice(2); const arg = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const outFile = arg("--out");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const baseDir = path.resolve(arg("--backup-dir", process.env.BACKUP_DIR || path.join(ROOT, "data")));
const keep = Math.max(1, Number(arg("--keep", process.env.BACKUP_KEEP || "7")) || 7);
const backupsRoot = path.join(baseDir, "backups");
const backupDir = path.join(backupsRoot, stamp);
const restoreDir = path.join(baseDir, "restore-test", stamp);
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

// 2. restore into isolation. The copy holds full personal data, so it is
// removed again in the finally below whatever the checks do.
t0 = Date.now();
try {
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
} finally {
  // rm the whole directory: openDb runs in WAL mode, so promotions.db-wal and
  // -shm sit beside the copy and were left behind with it.
  fs.rmSync(restoreDir, { recursive: true, force: true });
  try { fs.rmdirSync(path.join(baseDir, "restore-test")); } catch { /* other runs still there */ }
  report.restore = { ...(report.restore || {}), dir: restoreDir, removed: true };
}
// Prune old backups: rehearsal copies carry the same erasure obligations as
// the live database, and nothing else ever deletes them.
report.backup.kept = keep;
report.backup.pruned = [];
try {
  const stamps = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - keep))) { fs.rmSync(path.join(backupsRoot, old), { recursive: true, force: true }); report.backup.pruned.push(old); }
} catch (e) { report.backup.pruneError = e.message; }
report.rto_seconds = Number(((report.backup.ms + report.restore.ms) / 1000).toFixed(2));
report.rpo_note = "backup is point-in-time (VACUUM INTO); data-loss window = writes after backupAt. For production, schedule backups at <=15 min intervals (D-22 / release doc).";
report.ok = report.checks.every((c) => c.pass);
report.finishedAt = new Date().toISOString();
if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
