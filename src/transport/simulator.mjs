import crypto from "node:crypto";
import { WhatsAppTransport } from "./whatsapp-transport.mjs";

/**
 * Simulator transport: in-process, deterministic, RECORDED outbound messages.
 * Used by tests, the local demo, and as the default when no Meta credentials
 * are configured. Never used for production messaging.
 */
export class SimulatorTransport extends WhatsAppTransport {
  constructor() {
    super();
    this.outbox = [];       // recorded sends
    this.sentCount = 0;
    this.failNext = false;  // test hook
  }

  async start() {}
  async stop() {}

  static normalizePhone(raw) {
    let s = String(raw || "").replace(/[^\d]/g, "");
    if (s.startsWith("263")) s = s.slice(3);
    if (s.startsWith("0")) s = s.slice(1);
    return s.slice(-9);
  }

  async send(message) {
    if (this.failNext) { this.failNext = false; throw new Error("simulated transport failure"); }
    this.sentCount += 1;
    const rec = {
      id: `sim_${this.sentCount}`,
      waPhoneUid: SimulatorTransport.normalizePhone(message.waPhoneUid),
      kind: message.kind || "text",
      payload: message.payload,
      idempotencyKey: message.idempotencyKey,
      sentAt: new Date().toISOString(),
    };
    this.outbox.push(rec);
    return rec.id;
  }

  async downloadMedia(mediaId) {
    return Buffer.alloc(0); // simulator never stores media; tests pass bytes directly
  }

  health() { return { ok: true, provider: "simulator" }; }
}

/** Verification helper shared by Cloud API adapter and tests. */
export function hmacSha256Hex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest().toString("hex");
}