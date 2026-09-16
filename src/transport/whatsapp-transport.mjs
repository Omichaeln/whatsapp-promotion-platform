// Normalized transport contract (spec §8). Production adapter: official Cloud
// API (cloud-api). linked-device (Baileys) is dev/demo only and forbidden in
// production; simulator is TEST ONLY.
export const EVENT_TYPES = ["message.text", "message.image", "message.document", "message.unsupported", "delivery.status", "error"];
export const OUTBOUND_KINDS = ["text", "interactive", "template"];

export class WhatsAppTransport {
  get requiresTemplateOutsideWindow() { return false; }
  /**
   * True when sending reaches real handsets through a provider account. The
   * dispatch policy denies by default in non-production on such a transport:
   * an empty allowlist used to mean "message everyone", so a staging service
   * pointed at the live WhatsApp number answered every member of the public.
   */
  get isLiveProvider() { return false; }
  async start() {}
  async stop() {}
  /** send({ waPhoneUid, kind, payload, idempotencyKey, templateName }) -> { providerMessageId } */
  async send() { throw new Error("not implemented"); }
  async downloadMedia() { throw new Error("not implemented"); }
  health() { return { ok: true, provider: this.constructor.name, mode: "unknown" }; }
}

import crypto from "node:crypto";
export function verifyInboundSignature(sig, expected, rawBody) {
  if (!expected || !sig) return false;
  const calc = crypto.createHmac("sha256", expected).update(rawBody).digest("hex");
  const a = Buffer.from(String(sig).replace(/^sha256=/, ""), "hex"), b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
