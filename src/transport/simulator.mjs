import { WhatsAppTransport } from "./whatsapp-transport.mjs";
import { normalizePhone } from "../db.mjs";

/**
 * SIMULATED transport — TEST ONLY. Records outbound messages in memory and in
 * the outbox ledger; inbound events arrive via POST /webhooks/whatsapp or the
 * console's conversation simulator. Never proof of WhatsApp integration; the
 * activation validator rejects it and the readiness page labels it.
 */
export class SimulatorTransport extends WhatsAppTransport {
  constructor() { super(); this.outbox = []; this.sentCount = 0; this.failNext = null; }
  get requiresTemplateOutsideWindow() { return false; }
  async start() {} async stop() {}
  async send(message) {
    if (this.failNext) { const f = this.failNext; this.failNext = null; const e = new Error(f.message || "simulated transport failure"); if (f.unknownOutcome) e.unknownOutcome = true; if (f.permanent) e.permanent = true; throw e; }
    this.sentCount += 1;
    const rec = { id: `sim_${this.sentCount}`, waPhoneUid: normalizePhone(message.waPhoneUid) || message.waPhoneUid, kind: message.kind || "text", payload: message.payload, idempotencyKey: message.idempotencyKey, sentAt: new Date().toISOString() };
    this.outbox.push(rec);
    return { providerMessageId: rec.id };
  }
  async downloadMedia() { const e = new Error("simulator has no media store; pass bytes inline"); e.permanent = true; throw e; }
  health() { return { ok: true, provider: "simulator", mode: "simulated", sent: this.sentCount, note: "TEST ONLY — not a WhatsApp connection" }; }
}
