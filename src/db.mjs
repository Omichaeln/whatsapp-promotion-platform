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
  const applied = new Set();
  try {
    const row = db.prepare(`select value from schema_meta where key='migrations'`).get();
    if (row) for (const m of row.value.split(",")) applied.add(m);
  } catch { db.exec("create table if not exists schema_meta (key text primary key, value text not null)"); }
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  const fresh = applied.size === 0;
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.exec("begin");
    try {
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
export function tx(db, fn) {
  db.exec("savepoint tx");
  try {
    const r = fn();
    db.exec("release tx");
    return r;
  } catch (e) {
    db.exec("rollback to tx");
    throw e;
  }
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