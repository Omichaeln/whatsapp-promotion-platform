// Normalized transport contract. Production adapter is the official WhatsApp
// Cloud API (cloud-api). The linked-device (Baileys) path is dev/demo only and
// isolated behind the same interface (G-01). `simulator` drives local tests.

export const EVENT_TYPES = [
  "message.text",
  "message.image",
  "message.document",
  "message.unsupported",
  "delivery.status",
  "error",
];

export const OUTBOUND_KINDS = ["text", "interactive", "template"];

/** Webhook identity fields the transport layer must preserve for intake. */
export function normalizeInboundEvent({ provider, raw, phoneUid, type, mediaId, text, timestamp }) {
  return {
    provider,            // "whatsapp-cloud-api" | "linked-device" | "simulator"
    raw,                 // original provider payload (evidence, redacted in logs)
    phoneUid,            // normalized 9-digit national number
    type,                // EVENT_TYPES value
    mediaId: mediaId || null,
    text: text?.slice(0, 4000) || "",
    timestamp: timestamp || new Date().toISOString(),
  };
}

/** Interface for any transport. Implementations must be idempotent-safe at
 *  the caller level (outbound messages carry a business idempotency key). */
export class WhatsAppTransport {
  async start() { throw new Error("not implemented"); }
  async stop() { throw new Error("not implemented"); }
  async send(outboundMessage) { throw new Error("not implemented"); }
  // A provider may expose media retrieval with its own auth; otherwise the
  // platform downloads via the inbound event's stored media URL.
  async downloadMedia(mediaId) { throw new Error("not implemented"); }
  health() { return { ok: true, provider: this.constructor.name }; }
}

import crypto from "node:crypto";

export function verifyInboundSignature(sig, expected, rawBody) {
  if (!expected || !sig) return false;
  const calc = crypto.createHmac("sha256", expected).update(rawBody).digest().toString("hex");
  const a = Buffer.from(String(sig).replace(/^sha256=/, ""), "hex");
  const b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}