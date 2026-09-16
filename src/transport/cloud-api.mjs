import crypto from "node:crypto";
import { WhatsAppTransport } from "./whatsapp-transport.mjs";
import { normalizePhone } from "../db.mjs";

/**
 * Official Meta WhatsApp Cloud API adapter (spec §8). Implemented against the
 * Graph API contract (webhook verify handshake, X-Hub-Signature-256, messages
 * endpoint, two-step media download). NOT verified against a live account in
 * this build: no Meta assets/credentials were available (see
 * docs/integrations/whatsapp.md for the verification steps).
 */
export class CloudApiTransport extends WhatsAppTransport {
  constructor({ meta, publicBaseUrl, webhookToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    super();
    this.meta = meta; this.publicBaseUrl = publicBaseUrl; this.webhookToken = webhookToken; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.base = `https://graph.facebook.com/${meta.apiVersion || "v21.0"}`;
    if (!meta.accessToken) throw new Error("META_ACCESS_TOKEN required for Cloud API transport");
    this.lastSuccess = null; this.lastError = null;
  }
  get requiresTemplateOutsideWindow() { return true; }
  get isLiveProvider() { return true; }
  static normalizePhone(raw) { return normalizePhone(raw); }

  verifyHandshake(searchParams) {
    // Compare fixed-length digests. Padding the secret to the token's CHARACTER
    // length threw `RangeError: Input buffers must have the same byte length`
    // on any multi-byte token, so an unauthenticated GET could make this
    // endpoint answer 500 instead of 403; and the `token === this.webhookToken`
    // that followed reintroduced the very timing signal timingSafeEqual removes.
    // Nothing may throw out of here: a malformed query must be a plain 403.
    try {
      const mode = searchParams.get("hub.mode"), token = searchParams.get("hub.verify_token"), challenge = searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && this.webhookToken
        && crypto.timingSafeEqual(crypto.createHash("sha256").update(token, "utf8").digest(), crypto.createHash("sha256").update(this.webhookToken, "utf8").digest())) return { status: 200, body: challenge };
    } catch { /* fall through to 403 */ }
    return { status: 403, body: "verification failed" };
  }
  validateSignature(headers, rawBody) {
    const sig = (headers["x-hub-signature-256"] || "").replace("sha256=", "");
    if (!this.meta.appSecret || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const calc = crypto.createHmac("sha256", this.meta.appSecret).update(rawBody).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(calc, "hex"));
  }
  /** Normalised events; delivery statuses are distinct events keyed by (message id, status). */
  parseInbound(payload) {
    const out = [];
    for (const entry of payload?.entry || []) for (const change of entry.changes || []) {
      const value = change.value || {};
      const account = value.metadata?.phone_number_id || this.meta.phoneNumberId || "default";
      for (const msg of value.messages || []) {
        const from = normalizePhone(msg.from || value.contacts?.[0]?.wa_id || "");
        const t = msg.type || "unknown";
        let type = "message.unsupported", text = "", mediaId = null, mime = null;
        if (t === "text") { type = "message.text"; text = msg.text?.body || ""; }
        else if (t === "image") { type = "message.image"; mediaId = msg.image?.id; text = msg.image?.caption || ""; mime = msg.image?.mime_type || null; }
        else if (t === "document") { type = "message.document"; mediaId = msg.document?.id; text = msg.document?.caption || ""; mime = msg.document?.mime_type || null; }
        else if (t === "interactive") { type = "message.text"; text = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.title || ""; }
        else if (t === "button") { type = "message.text"; text = msg.button?.payload || msg.button?.text || ""; }
        out.push({ provider: "whatsapp-cloud-api", providerAccount: account, providerMessageId: msg.id, phoneUid: from, type, text, mediaId, mime, raw: msg, timestamp: new Date(Number(msg.timestamp || 0) * 1000 || Date.now()).toISOString() });
      }
      for (const st of value.statuses || []) out.push({ provider: "whatsapp-cloud-api", providerAccount: account, providerMessageId: st.id, phoneUid: normalizePhone(st.recipient_id || ""), type: "delivery.status", status: st.status, raw: st, timestamp: new Date(Number(st.timestamp || 0) * 1000 || Date.now()).toISOString() });
    }
    return out;
  }
  /**
   * `read(res)` consumes the body INSIDE the deadline. The timer used to be
   * cleared as soon as the response headers arrived, leaving `res.json()` /
   * `arrayBuffer()` — which stream on the same socket — with no bound at all.
   * The worker runs one tick at a time behind `if (running) return`, so a single
   * body that never finishes arriving wedges inbound, jobs, outbox and CRM
   * together while the process still looks healthy. `read` must not throw:
   * errors from here are rewritten and lose their `.permanent` flag.
   */
  async call(url, init, read = null) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { ...init, signal: ctrl.signal, headers: { Authorization: `Bearer ${this.meta.accessToken}`, ...(init?.headers || {}) } });
      return read ? { res, body: await read(res) } : res;
    }
    catch (e) { const err = new Error(e.name === "AbortError" ? "cloud api timeout" : e.message); if (e.name === "AbortError" && init?.method === "POST") err.unknownOutcome = true; throw err; }
    finally { clearTimeout(t); }
  }
  async send(message) {
    const to = normalizePhone(message.waPhoneUid);
    if (!to) { const e = new Error("invalid recipient"); e.permanent = true; throw e; }
    const body = { messaging_product: "whatsapp", recipient_type: "individual", to };
    if (message.kind === "text") { body.type = "text"; body.text = { body: String(message.payload).slice(0, 4096), preview_url: false }; }
    else if (message.kind === "template") { body.type = "template"; body.template = message.payload; }
    else if (message.kind === "interactive") { body.type = "interactive"; body.interactive = message.payload; }
    const { res, body: json } = await this.call(`${this.base}/${this.meta.phoneNumberId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, (r) => r.json().catch(() => ({})));
    if (!res.ok) {
      const code = json?.error?.code; const e = new Error(`cloud api ${res.status}: ${json?.error?.message || "send failed"}`);
      e.code = code ? `META_${code}` : `HTTP_${res.status}`; e.permanent = res.status >= 400 && res.status < 500 && ![429, 408].includes(res.status);
      this.lastError = { at: new Date().toISOString(), message: e.message }; throw e;
    }
    this.lastSuccess = new Date().toISOString();
    return { providerMessageId: json.messages?.[0]?.id || null };
  }
  async downloadMedia(mediaId) {
    const { res: r, body: j } = await this.call(`${this.base}/${mediaId}`, { method: "GET" }, (x) => (x.ok ? x.json().catch(() => ({})) : null));
    if (!r.ok) { const e = new Error(`media resolve failed ${r.status}`); e.permanent = r.status === 404 || r.status === 400; throw e; }
    if (!isMetaMediaHost(j?.url)) { const e = new Error("media url missing or not a Meta host"); e.permanent = true; throw e; }
    const TOO_BIG = 10 * 1024 * 1024;
    // The body is read under call()'s deadline; a size refusal is signalled by
    // value rather than thrown, because call() rewrites errors raised in here.
    const { res: dl, body: media } = await this.call(j.url, { method: "GET" }, async (x) => {
      if (!x.ok) return null;
      if (Number(x.headers.get("content-length") || 0) > TOO_BIG) return "too_large";
      const buf = Buffer.from(await x.arrayBuffer());
      return buf.length > TOO_BIG ? "too_large" : buf;
    });
    if (!dl.ok) { const e = new Error(`media download failed ${dl.status}`); e.permanent = dl.status === 404 || dl.status === 410; throw e; }
    if (!Buffer.isBuffer(media)) { const e = new Error("media too large"); e.permanent = true; throw e; }
    return media;
  }
  health() { return { ok: !!(this.meta.accessToken && this.meta.phoneNumberId), provider: "cloud-api", mode: "configured", phoneNumberId: this.meta.phoneNumberId, lastSuccess: this.lastSuccess, lastError: this.lastError, note: "configured only; live delivery unverified until a send/receive round-trip is recorded" }; }
}

/**
 * Match the HOST, not the string. The old regex alternative `.*\.whatsapp\.net`
 * was unanchored on the left, so `.*` swallowed a whole different authority:
 * `https://169.254.169.254/latest/meta-data/?a=.whatsapp.net/` passed the
 * "Meta hosts only" check and was then fetched with the production
 * `Authorization: Bearer <META_ACCESS_TOKEN>` header attached.
 */
export function isMetaMediaHost(raw) {
  if (!raw) return false;
  let u; try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return h === "lookaside.fbsbx.com" || /(^|\.)fbcdn\.net$/.test(h) || /(^|\.)whatsapp\.net$/.test(h);
}
