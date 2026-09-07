import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { WhatsAppTransport } from "./whatsapp-transport.mjs";
import { normalizePhone, nowIso } from "../db.mjs";

const requireCjs = createRequire(import.meta.url);
const pino = requireCjs("pino");
let QRCode = null;

/** Render a stable SVG QR from the qrcode BitMatrix (exported for tests). */
export function qrSvgOf(text) {
  if (!QRCode) QRCode = requireCjs("qrcode");
  const qr = QRCode.create(text, { errorCorrectionLevel: "L", margin: 4 });
  // qrcode's `modules` is a BitMatrix: { size, data: Uint8Array(size*size), get(x, y) }.
  // Iterate by its size, not the flat data length (the old code treated the
  // buffer length as the module count and produced a 30k-px unscannable QR).
  const mods = qr.modules;
  const n = mods.size;
  const cell = 8, margin = 4 * cell;
  const size = n * cell + 2 * margin;
  const rects = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (mods.get(y, x)) rects.push(`<rect x="${margin + x * cell}" y="${margin + y * cell}" width="${cell}" height="${cell}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

const textOf = (m) => m.conversation || m.caption || null;

/**
 * Linked-device WhatsApp transport (restored from the original desk's
 * server/whatsapp.mjs). The operator links a phone by scanning a QR code;
 * inbound text is filed to the desk store and inbound images are downloaded
 * and routed into the promotion receipt pipeline (so customers can enter via
 * the linked number too). Production path remains the Cloud API adapter; this
 * is the faithful "phone connection" workflow for local and small-scale use.
 */
export class LinkedDeviceTransport extends WhatsAppTransport {
  /** opts: { authDir, deskStore, onActivity, log } — callbacks onTextMessage /
   *  onImageMessage are set after construction (the server wires them once the
   *  conversation service exists). */
  constructor(opts) {
    super();
    this.opts = opts;
    this.authDir = opts.authDir;
    this.desk = opts.deskStore;
    this.onActivity = opts.onActivity;
    this.log = opts.log || console;
    this.state = { ready: false, me: null, qr: false, received: 0, dropped: 0, startedAt: nowIso(), lastError: null };
    this.lastQr = null;
    this.sock = null;
    this.stopping = false;
    this.groupNames = new Map();
  }

  async start() {
    const baileys = await import("baileys");
    this.baileys = baileys;
    fs.mkdirSync(this.authDir, { recursive: true });
    // If a session exists, connect silently; otherwise wait for a scan.
    this.connect(baileys);
    return this;
  }

  async stop() {
    this.stopping = true;
    try { this.sock?.end?.(); } catch { /* already closed */ }
  }

  qrSvg() { return this.state.ready ? null : (this.lastQr ? qrSvgOf(this.lastQr) : null); }
  currentQr() { return this.state.ready ? null : this.lastQr; }

  async connect(baileys) {
    if (this.stopping) return;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
    const version = await Promise.race([
      fetchLatestBaileysVersion().then((x) => x.version).catch(() => undefined),
      new Promise((r) => setTimeout(() => r(undefined), 4000)),
    ]);
    const sock = baileys.makeWASocket({
      auth: authState,
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: ["Chrome", "Windows", "1.0"],
    });
    this.sock = sock;

    const chatNameOf = async (jid, pushName) => {
      if (!jid.endsWith("@g.us")) return pushName || jid.split("@")[0];
      if (this.groupNames.has(jid)) return this.groupNames.get(jid);
      try { const md = await sock.groupMetadata(jid); this.groupNames.set(jid, md.subject || jid.split("@")[0]); }
      catch { this.groupNames.set(jid, jid.split("@")[0]); }
      return this.groupNames.get(jid);
    };

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) { this.state.qr = true; this.state.ready = false; this.lastQr = qr; this.opts.onActivity?.("link", "WhatsApp waiting for a QR scan", { }); }
      if (connection === "open") {
        this.state.ready = true; this.state.qr = false; this.state.lastError = null; this.lastQr = null;
        this.state.me = sock.user?.name || sock.user?.id?.split(":")[0] || null;
        this.opts.onActivity?.("link", `WhatsApp linked as ${this.state.me}`, { me: this.state.me });
        this.log(`[linked] linked as ${this.state.me}`);
      }
      if (connection === "close") {
        this.state.ready = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === baileys.DisconnectReason?.loggedOut) {
          this.state.lastError = "logged out";
          this.opts.onActivity?.("link", "WhatsApp logged out; session cleared — rescan QR", {});
          fs.rmSync(this.authDir, { recursive: true, force: true });
          setTimeout(() => this.connect(baileys).catch(() => {}), 1500);
          return;
        }
        if (this.stopping) return;
        this.state.lastError = `closed (${code || "unknown"})`;
        setTimeout(() => this.connect(baileys).catch(() => {}), 3000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const m of messages) {
        try { await this.fileMessage(m, sock); } catch (e) { this.log(`[linked] could not file message: ${e.message}`); }
      }
    });
  }

  async fileMessage(m, sock) {
    const jid = m.key?.remoteJid || "";
    const isGroup = jid.endsWith("@g.us");
    const text = textOf(m);
    const media = m.imageMessage || null;
    if ((!text && !media) || m.key?.fromMe || jid === "status@broadcast" || jid.endsWith("@newsletter")) {
      this.state.dropped += 1;
      return;
    }
    const senderJid = isGroup ? (m.key?.participant || jid) : jid;
    const sender = m.pushName || senderJid.split("@")[0].split(":")[0];
    const ts = new Date(Number(m.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const phoneDigits = jid.split("@")[0];
    const phoneUid = normalizePhone(phoneDigits) || phoneDigits;

    if (media) {
      // Receipt images from the linked phone go into the promotion pipeline.
      let mediaBytes = null;
      try { mediaBytes = await sock.downloadMedia(m); } catch { mediaBytes = null; }
      this.state.received += 1;
      await this.onImageMessage?.({ phoneUid, providerMessageId: `ld_${m.key?.id}`, mediaBytes, mime: media.mimetype || "image/jpeg", caption: text || "" });
      this.opts?.onActivity?.("message", `Receipt image from ${sender || phoneUid}`, { chat: jid });
      return;
    }

    const inserted = this.desk.upsertMessage({
      message_sid: `${jid}:${m.key?.id}`,
      chat_type: isGroup ? "group" : "direct",
      chat_id: jid,
      chat_name: await chatNameOf(jid, m.pushName),
      sender_name: sender,
      message_text: String(text || "").slice(0, 4000),
      timestamp: ts,
    });
    if (inserted) {
      this.state.received += 1;
      this.opts?.onActivity?.("message", `${sender || phoneUid} in ${isGroup ? "group" : "direct"} chat`, { chat: jid, text: String(text || "").slice(0, 120) });
    }
    // The server wires onTextMessage to the promotion conversation so a
    // scanned phone's "register / enter" flow works end to end.
    await this.onTextMessage?.({ providerMessageId: `ld_${m.key?.id}`, phoneUid, text: text || "", chatId: jid });
  }

  async send(message) {
    if (!this.state.ready) throw Object.assign(new Error("WhatsApp is not linked"), { status: 503 });
    const t = String(message.waPhoneUid || "").trim();
    const jid = t.includes("@") ? t : `${normalizePhone(t) || t}@s.whatsapp.net`;
    const body = String(message.payload || "").trim().slice(0, 4000);
    if (!body) throw new Error("text is required");
    const sent = await this.sock.sendMessage(jid, { text: body });
    this.opts.onActivity?.("send", `Sent reply to ${jid.split("@")[0]}`, { jid });
    return sent?.key?.id || null;
  }

  async unlink() {
    this.stopping = true;
    try { if (this.state.ready) await this.sock.logout(); } catch { /* already removed */ }
    try { this.sock?.end?.(); } catch { /* closed */ }
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.state.ready = false; this.state.me = null; this.state.qr = false; this.lastQr = null;
    this.stopping = false;
    const baileys = this.baileys || await import("baileys");
    this.connect(baileys);
    this.opts.onActivity?.("link", "WhatsApp unlinked — ready for a fresh QR scan", {});
    return true;
  }

  async downloadMedia() { return null; }

  health() {
    return { ok: true, provider: "linked-device", ready: this.state.ready, me: this.state.me, qr: this.state.qr, lastError: this.state.lastError, received: this.state.received, dropped: this.state.dropped };
  }
}