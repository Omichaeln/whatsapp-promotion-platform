import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "./config.mjs";

const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");

export function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest().toString("hex");
}

export function randBytes(n) {
  return crypto.randomBytes(n);
}

export function scryptHash(password, salt) {
  const s = salt || crypto.randomBytes(16);
  const key = crypto.scryptSync(password, s, 32, { N: 16384, r: 8, p: 1 });
  return { salt: s.toString("hex"), hash: key.toString("hex") };
}

export function scryptVerify(password, saltHex, hashHex) {
  const s = Buffer.from(saltHex, "hex");
  const key = crypto.scryptSync(password, s, 32, { N: 16384, r: 8, p: 1 });
  return key.toString("hex") === hashHex;
}

/** Mask a value for display/logs: keep first 2 and last 2 chars of the tail. */
export function mask(v) {
  const s = String(v ?? "");
  if (s.length <= 6) return "******";
  return s.slice(0, 2) + "******" + s.slice(-2);
}

/**
 * Channel identity normalisation: full international digits (E.164 without
 * "+"). A local number with a leading 0 gets the configured default country
 * code; country codes are NEVER stripped, so two numbers from different
 * countries can never merge (§7.3). Default country is a test assumption
 * (D-04) and is read from DEFAULT_COUNTRY_CODE.
 */
export function normalizePhone(raw, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || "263") {
  let s = String(raw || "").replace(/[^\d]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) s = `${defaultCountryCode}${s.slice(1)}`;
  if (s.length < 8 || s.length > 15) return null;
  return s;
}

export function nowIso() {
  return new Date().toISOString();
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function addMinutes(isoStr, minutes) {
  return new Date(new Date(isoStr).getTime() + minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
}

/** Apply pending ordered migrations; records applied hashes in schema_meta. */
export function migrate(db, dir = MIGRATIONS_DIR, log = console.log) {
  const readApplied = () => {
    const set = new Set();
    try {
      const row = db.prepare(`select value from schema_meta where key='migrations'`).get();
      if (row) for (const m of row.value.split(",")) set.add(m);
    } catch (e) {
      // ONLY "the ledger table does not exist yet" may be swallowed. This is now
      // re-read inside each migration's BEGIN IMMEDIATE and its result is
      // written straight back with `insert or replace`, so treating any other
      // failure (I/O error, locked database, corruption) as "nothing applied"
      // would truncate schema_meta.migrations to the single file being applied
      // and COMMIT that: the next boot would replay 007/009/011's ADD COLUMNs
      // and die on "duplicate column name" with no way back.
      if (!/no such table/i.test(e.message || "")) throw e;
      db.exec("create table if not exists schema_meta (key text primary key, value text not null)");
    }
    return set;
  };
  let applied = readApplied();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  const fresh = applied.size === 0;
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    // The ledger was read once, before anything was applied, outside any
    // transaction. Two migrators starting together (a deploy restart while an
    // operator runs `npm run migrate`, or the server and the standalone worker)
    // therefore both saw the same pending file and both applied it — and
    // replaying a migration is not idempotent (007 and 009 ADD COLUMN), so the
    // loser died with "duplicate column name" and burned a restart attempt.
    // BEGIN IMMEDIATE takes the write lock BEFORE the ledger is re-read, so the
    // second migrator waits on busy_timeout and then sees the file as applied.
    db.exec("begin immediate");
    try {
      applied = readApplied();
      if (applied.has(f)) { db.exec("rollback"); continue; }   // the other migrator won the race
      db.exec(sql);
      const list = [...applied, f].sort().join(",");
      db.prepare(`insert or replace into schema_meta (key, value) values ('migrations', ?)`).run(list);
      applied.add(f);
      db.exec("commit");
      count += 1;
    } catch (e) {
      db.exec("rollback");
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
  // schema_version was hand-maintained: 005 wrote '5' with `insert or replace`
  // and 007's `insert or ignore` was then a no-op, so the post-deploy check
  // documented in docs/release/migrations.md reported 5 on a fully migrated
  // database and an operator could not tell it from one stuck at 005. Derive it
  // from the ledger instead, so no future migration has to remember to bump it.
  const version = String(Math.max(0, ...[...applied].map((f) => Number(String(f).slice(0, 3))).filter(Number.isFinite)));
  try {
    if (db.prepare(`select value from schema_meta where key='schema_version'`).get()?.value !== version) {
      db.prepare(`insert or replace into schema_meta (key, value) values ('schema_version', ?)`).run(version);
    }
  } catch { /* schema_meta absent: nothing was applied */ }
  // Refresh the planner statistics on every boot.
  //
  // Migration 011 added idx_receipts_media so duplicates.exactImageMatches could
  // be driven from the image hash instead of walking every receipt in the
  // campaign — but SQLite only picks that plan once sqlite_stat1 exists, and
  // nothing ran ANALYZE, so on every deployed database the query still planned
  // as `SEARCH r USING idx_receipts_period (campaign_id=?)` (measured: 73 ms per
  // 50 lookups at 5k receipts, 1 ms with statistics present).
  // `PRAGMA optimize` (not plain ANALYZE) is what makes this safe to run
  // unconditionally: on a freshly migrated, empty database it writes one
  // sqlite_stat1 row rather than freezing "empty table" estimates for all nine
  // indexed tables, and it re-analyses a table only once its size has moved.
  // analysis_limit bounds the work so a large table cannot stall a boot.
  try { db.exec("PRAGMA analysis_limit=400; PRAGMA optimize;"); }
  catch (e) { log?.(`[db] statistics refresh skipped: ${e.message}`); }   // never let maintenance fail a boot
  if (count > 0 || fresh) log?.(`[db] applied ${count} migration(s)`);
  else log?.(`[db] schema up to date`);
  return count;
}

/** Deterministic hash input for campaign version freeze etc. */
export function jsonHash(obj) {
  return sha256hex(JSON.stringify(normalizeJson(obj)));
}

function normalizeJson(v) {
  if (Array.isArray(v)) return v.map(normalizeJson);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalizeJson(v[k]);
    return out;
  }
  return v;
}

/** Execute fn in an immediate transaction (nested-safe via savepoint). */
let txCounter = 0;

/**
 * Run fn() in a transaction, nesting safely.
 *
 * The previous implementation did `savepoint tx` / `rollback to tx` and, on the
 * error path, never RELEASEd. SQLite's ROLLBACK TO does not pop the savepoint,
 * so the implicit transaction opened by the outermost SAVEPOINT stayed open for
 * the life of the process. Every ordinary handled rejection — a second reviewer
 * opening the same task, a withdrawn participant re-registering, a
 * separation-of-duties refusal — left the single application connection inside
 * a transaction that was never committed. Later writes then looked successful,
 * were invisible to any other connection, locked that connection out entirely,
 * and were discarded on the next restart or redeploy: silent, unbounded data
 * loss with no symptom until the process stopped.
 *
 * At the outermost level this now uses BEGIN IMMEDIATE, which also takes the
 * write lock up front so two processes serialise instead of colliding on a
 * stale snapshot. Nested calls use uniquely named savepoints that are always
 * popped. Whoever opened the transaction (including the raw begin/commit in
 * migrate) is detected with db.isTransaction, so nesting is never guessed.
 */
export function tx(db, fn) {
  const nested = db.isTransaction;
  const name = `tx_${++txCounter}`;
  if (nested) db.exec(`savepoint ${name}`);
  else db.exec("begin immediate");
  let out;
  try {
    out = fn();
  } catch (e) {
    try {
      if (nested) { db.exec(`rollback to ${name}`); db.exec(`release ${name}`); }
      else db.exec("rollback");
    } catch (unwind) {
      // Never let the unwind hide why the work actually failed.
      e.unwindError = unwind.message;
    }
    throw e;
  }
  try {
    if (nested) db.exec(`release ${name}`);
    else db.exec("commit");
  } catch (e) {
    try { if (nested) { db.exec(`rollback to ${name}`); db.exec(`release ${name}`); } else db.exec("rollback"); } catch { /* already unwound */ }
    throw e;
  }
  return out;
}

export function rowsOf(stmt, ...params) {
  const out = [];
  const it = stmt[Symbol.iterator] ? stmt.iterate(...params) : null;
  if (it) { for (const r of it) out.push(r); return out; }
  return [];
}

export function all(db, sql, ...params) {
  return rowsOf(db.prepare(sql), ...params);
}

export function get(db, sql, ...params) {
  return rowsOf(db.prepare(sql), ...params)[0] ?? null;
}

export { DatabaseSync, migrate as runMigrations };