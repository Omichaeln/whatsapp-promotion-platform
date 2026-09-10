// Shared test harness: in-memory SQLite, full server wiring, simulator
// transport, and a choice of extractor: the REAL tesseract OCR (used by the
// pipeline tests with fixture images) or the labelled simulator (rules/ledger/
// draw tests that need speed). The simulator never reads pixels and is marked
// as such; fixture images are always processed by real OCR.
import { test, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/server.mjs";
import { loadConfig, ROOT } from "../src/config.mjs";
import { SimulatorTransport } from "../src/transport/simulator.mjs";
import { SimulatorExtractor, encodeReceiptText } from "../src/extract/simulator.mjs";
import { TesseractExtractor } from "../src/extract/tesseract.mjs";
import { ensureDemoSeed, ensureSampleStaff, SAMPLE_CODE, fixtureBytes } from "../src/demo-seed.mjs";
import sharp from "sharp";

let sharedOcr = null;
export function realExtractor() { if (!sharedOcr) sharedOcr = new TesseractExtractor(); return sharedOcr; }

let port = 5600 + Math.floor(Math.random() * 300);
export async function buildApp({ extractor = "simulator", seed = true, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-test-"));
  const cfg = loadConfig({ ENVIRONMENT: "test", DATABASE: path.join(dir, "t.db"), MEDIA_DIR: path.join(dir, "media"), PORT: String(port++), HOST: "127.0.0.1", ADMIN_EMAIL: "admin@x.test", ADMIN_PASSWORD: "TestAdminPassword123", IDENTITY_KEY: "test-identity-key-0123456789", AUDIT_CHECKPOINT_KEY: "test-checkpoint-key", WHATSAPP_TRANSPORT: "simulator", RECEIPT_EXTRACTOR: extractor, ...env });
  const app = await createServer({ config: cfg, log: { log: () => {}, error: () => {}, warn: () => {} }, transport: new SimulatorTransport(), extractor: extractor === "tesseract" ? realExtractor() : new SimulatorExtractor() });
  if (seed) { ensureDemoSeed(app.db, { log: null }); ensureSampleStaff(app.auth, { log: null }); }
  await app.listen();
  const base = `http://127.0.0.1:${cfg.port}`;
  const campaign = seed ? app.domain.getCampaignByCode(SAMPLE_CODE) : null;
  let n = 0;
  const helpers = {
    app, db: app.db, domain: app.domain, cfg, base, campaign, dir,
    async api(p, { method = "GET", body, token, raw, headers = {} } = {}) { const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); if (raw) return r; let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, data: j, headers: r.headers }; },
    async login(email, password) { const r = await helpers.api("/api/login", { method: "POST", body: { email, password } }); return r.data?.token; },
    async staffToken(email) { const u = app.auth.listUsers().find((x) => x.email === email); app.auth.resetPassword(u.id, "test"); const pw = "StaffTestPassword123"; const s = app.db.prepare(`select id from admin_users where email=?`).get(email); const { scryptHash } = await import("../src/db.mjs"); const h = scryptHash(pw); app.db.prepare(`update admin_users set password_hash=?, must_change_password=0 where id=?`).run(`${h.salt}:${h.hash}`, s.id); return helpers.login(email, pw); },
    /** Send an inbound message through the durable intake and drain the worker. */
    async say(phone, text, { image = null, providerMessageId = null, drain = true } = {}) {
      const id = providerMessageId || `t_${++n}_${Date.now()}`;
      const r = app.intake.receive({ provider: "simulator", providerMessageId: id, phoneUid: phone, type: image ? "message.image" : "message.text", text: text || "", inlineMediaB64: image ? image.toString("base64") : null, timestamp: new Date().toISOString() });
      if (drain) { await app.intake.drain(); await app.worker.tick(); }
      const replies = r.id ? app.db.prepare(`select payload_json from outbound_messages where idempotency_key like ? order by created_at`).all(`conv:${r.id}:%`).map((m) => JSON.parse(m.payload_json).body) : [];
      const ev = r.id ? app.db.prepare(`select result_json, status from channel_events where id=?`).get(r.id) : null;
      return { ...r, replies, result: ev?.result_json ? JSON.parse(ev.result_json) : null, eventStatus: ev?.status };
    },
    async register(phone, { first = "Tendai", last = "Ncube", identity = "TEST1234X", town = "Harare" } = {}) { await helpers.say(phone, "hi"); await helpers.say(phone, "1"); await helpers.say(phone, first); await helpers.say(phone, last); await helpers.say(phone, identity); await helpers.say(phone, town); await helpers.say(phone, "yes"); return helpers.say(phone, "yes"); },
    async selectOutlet(phone, query = "sunrise westgate harare") { await helpers.say(phone, "2"); await helpers.say(phone, query); return helpers.say(phone, "1"); },
    /** Submit an image and wait for the pipeline decision. Returns the receipt row + participant-facing messages. */
    async submit(phone, image, { outlet = "sunrise westgate harare", providerMessageId = null } = {}) {
      await helpers.selectOutlet(phone, outlet);
      const r = await helpers.say(phone, "", { image, providerMessageId });
      await app.intake.drain(); await app.worker.tick();
      const receiptId = r.result?.receiptId;
      const receipt = receiptId ? app.db.prepare(`select * from receipts where id=?`).get(receiptId) : null;
      const outcomes = receiptId ? app.db.prepare(`select payload_json from outbound_messages where idempotency_key like ? order by created_at`).all(`receipt:${receiptId}:%`).map((m) => JSON.parse(m.payload_json).body) : [];
      return { receiptId, receipt, ack: r.replies, outcomes };
    },
    /** Receipt text for the SIMULATED extractor (labelled; does not read pixels). */
    simReceipt({ no = "004512", date = null, packs = 2, product = "GOLDCANE BROWN SUGAR 2KG", merchant = "SUNRISE SUPERMARKET\nWestgate Branch, Harare", extra = "" } = {}) {
      const d = date || new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
      return `${merchant}\nTel 0242 000000\nReceipt No: ${no}  Till 03\nDate: ${d} 14:22\n${product}\n${packs} x 3.10  ${(packs * 3.1).toFixed(2)}\n${extra}TOTAL ${(packs * 3.1).toFixed(2)}\nCASH 10.00\nThank you`;
    },
    /** Wrap text as an image so the media store accepts it (simulated extractor reads the embedded text). */
    async simImage(text) {
      // deterministic per-text noise so two different simulated receipts are not visually identical (same text -> same bytes)
      const w = 160, h = 120, raw = Buffer.alloc(w * h * 3); let x = 0; for (const c of text) x = (x * 31 + c.charCodeAt(0)) >>> 0;
      for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) >>> 0; raw[i] = (x >>> 16) & 0xff; }
      const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(); return Buffer.concat([png, encodeReceiptText(text)]);
    },
    fixture: fixtureBytes,
    async close() { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return helpers;
}
export { test, before, after, describe, it, assert, encodeReceiptText, SAMPLE_CODE, ROOT, sharp };
