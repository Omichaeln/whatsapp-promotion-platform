import crypto from "node:crypto";
import { WhatsAppTransport, verifyInboundSignature } from "./whatsapp-transport.mjs";
import { normalizePhone } from "../db.mjs";

/**
 * Official Meta WhatsApp Cloud API adapter (G-01, P0-02).
 * - Webhook verification: GET with hub.mode/challenge/verify_token.
 * - Inbound: POST /webhooks/whatsapp with X-Hub-Signature-256.
 * - Outbound: Graph API /PHONE_NUMBER_ID/messages with Bearer token.
 * - Media: two-step per Meta spec — GET /media/{id} returns a download URL,
 *   then GET that URL with Bearer auth returns the binary.
 *
 * Phone handling (P0-02): WhatsApp Cloud API expects full international
 * E.164 with country code. `normalizePhone` keeps the full national number so
 * outbound `to` is always `+2637...`, never the last-9 stripping used by the
 * simulator/linked-device paths.
 */
export class CloudApiTransport extends WhatsAppTransport {
  constructor({ meta, publicBaseUrl, webhookToken }) {
    super();
    this.meta = meta;
    this.publicBaseUrl = publicBaseUrl;
    this.webhookToken = webhookToken;
    this.base = `https://graph.facebook.com/${meta.apiVersion || "v21.0"}`;
    if (!meta.accessToken) throw new Error("META_ACCESS_TOKEN required for Cloud API transport");
  }

  /** Full international E.164 (drop leading +/spaces; keep country code). */
  static normalizePhone(raw) {
    let s = String(raw || "").replace(/[^\d]/g, "");
    if (s.startsWith("00")) s = s.slice(2);
    if (s.startsWith("0")) s = s.slice(1); // local leading 0
    return s;
  }

  /** Handle the GET webhook verification handshake. Returns {status, body}. */
  verifyHandshake(searchParams) {
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === this.webhookToken) {
      return { status: 200, body: challenge };
    }
    return { status: 403, body: "verification failed" };
  }

  /** Check X-Hub-Signature-256 against app secret + raw body. */
  validateSignature(headers, rawBody) {
    const sig = (headers["x-hub-signature-256"] || "").replace("sha256=", "");
    if (!this.meta.appSecret || !sig) return false;
    const calc = crypto.createHmac("sha256", this.meta.appSecret).update(rawBody).digest().toString("hex");
    const a = Buffer.from(sig, "hex"), b = Buffer.from(calc, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Extract normalized events from a Cloud API webhook payload. */
  parseInbound(payload) {
    const out = [];
    const entries = payload?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          const waUid = CloudApiTransport.normalizePhone(msg.from || value.contacts?.[0]?.wa_id || "");
          const type = msg.type || "unknown";
          let evType = "message.unsupported";
          let text = "", mediaId = null;
          if (type === "text") { evType = "message.text"; text = msg.text?.body || ""; }
          else if (type === "image") { evType = "message.image"; mediaId = msg.image?.id; text = msg.image?.caption || ""; }
          else if (type === "document") { evType = "message.document"; mediaId = msg.document?.id; text = msg.document?.caption || ""; }
          const providerId = msg.id;
          out.push({
            providerMessageId: providerId,
            provider: "whatsapp-cloud-api",
            raw: msg,
            phoneUid: waUid,
            type: evType,
            mediaId,
            text,
            timestamp: new Date(Number(msg.timestamp || 0) * 1000 || Date.now()).toISOString(),
          });
        }
        const statuses = value.statuses || [];
        for (const st of statuses) {
          out.push({
            providerMessageId: st.id,
            provider: "whatsapp-cloud-api",
            raw: st,
            phoneUid: CloudApiTransport.normalizePhone(st.recipient_id || ""),
            type: "delivery.status",
            mediaId: null,
            text: `status=${st.status}`,
            timestamp: new Date(Number(st.timestamp || 0) * 1000 || Date.now()).toISOString(),
          });
        }
      }
    }
    return out;
  }

  async send(message) {
    const wa = CloudApiTransport.normalizePhone(message.waPhoneUid);
    // Always full international: to = +<country><number>
    const to = wa.startsWith("263") || wa.startsWith("260") ? `+${wa}` : `+263${wa}`;
    const body = { messaging_product: "whatsapp", recipient_type: "individual", to };
    if (message.kind === "text") body.type = "text", body.text = { body: String(message.payload).slice(0, 4096) };
    else if (message.kind === "template") body.type = "template", body.template = message.payload;
    else if (message.kind === "interactive") body.type = "interactive", body.interactive = message.payload;
    const res = await fetch(`${this.base}/${this.meta.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.meta.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`cloud api send failed ${res.status}: ${JSON.stringify(json.errors || json)}`);
    return json.messages?.[0]?.id || null;
  }

  /** Meta-spec two-step media: resolve media ID -> download URL, then fetch. */
  async downloadMedia(mediaId) {
    const resolve = await fetch(`${this.base}/${this.meta.phoneNumberId}/media/${mediaId}`, {
      headers: { "Authorization": `Bearer ${this.meta.accessToken}` },
    });
    if (!resolve.ok) throw new Error(`media resolve failed ${resolve.status}`);
    const urlJson = await resolve.json().catch(() => ({}));
    const downloadUrl = urlJson?.url;

    if (!downloadUrl) {
      // Some Graph versions return the binary directly; accept either.
      return Buffer.from(await resolve.arrayBuffer());
    }
    const dl = await fetch(downloadUrl, {
      headers: { "Authorization": `Bearer ${this.meta.accessToken}` },
    });
    if (!dl.ok) throw new Error(`media download failed ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }

  health() { return { ok: true, provider: "cloud-api", phoneNumberId: this.meta.phoneNumberId }; }
}