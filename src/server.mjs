import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { openDb, migrate, nowIso, sha256hex } from "./db.mjs";
import { loadConfig, ROOT, ensureDir } from "./config.mjs";
import { createMediaStore, signMediaUrl, verifyMediaSig } from "./media.mjs";
import { createDomain } from "./services.mjs";
import { createReceiptPipeline } from "./receipt-pipeline.mjs";
import { createOutbox } from "./outbox.mjs";
import { createDuplicateDetector } from "./duplicates.mjs";
import { createConversationService } from "./conversation.mjs";
import { createDrawService } from "./draw.mjs";
import { createCrm } from "./crm.mjs";
import { createAuth } from "./auth.mjs";
import { SimulatorExtractor } from "./extract/simulator.mjs";
import { SimulatorTransport } from "./transport/simulator.mjs";
import { CloudApiTransport } from "./transport/cloud-api.mjs";
import { verifyInboundSignature } from "./transport/whatsapp-transport.mjs";

/**
 * HTTP surface (spec 13): provider webhook endpoints + admin/operations API.
 * Authorization is enforced server-side on every non-provider route.
 */
export async function createServer({ config, log = console }) {
  const cfg = config || loadConfig();
  if (cfg.onRailway && !cfg.adminPassword) {
    throw new Error("ADMIN_PASSWORD is required on a public deployment (Railway env)");
  }
  ensureDir(cfg.mediaDir);
  const db = openDb(cfg.database);
  migrate(db, undefined, log?.log || log || console.log);

  // ---- domain wiring ----------------------------------------------------
  const mediaStore = createMediaStore({ dir: cfg.mediaDir, db });
  const domain = createDomain(db, cfg.identityKey || "dev-only-key");
  const outbox = createOutbox(db);
  const duplicates = createDuplicateDetector({ db });
  const extractor = new SimulatorExtractor({ minConfidence: cfg.receipt.autoQualifyMinConfidence });
  const auth = createAuth(db, {
    secret: cfg.webhookToken || sha256hex(String(Date.now())),
    bootstrap: cfg.adminEmail && cfg.adminPassword ? { email: cfg.adminEmail, password: cfg.adminPassword } : null,
  });
  const pipeline = createReceiptPipeline({ db, mediaStore, extractor, duplicates, outbox, domain });
  const conversation = createConversationService({ db, domain, receiptPipeline: pipeline, outbox });
  const drawService = createDrawService(db);
  const crm = createCrm({ db, cfg: cfg.crm });

  // ---- transport --------------------------------------------------------
  let transport;
  if (cfg.whatsappTransport === "cloud-api") {
    transport = new CloudApiTransport({ meta: cfg.meta, publicBaseUrl: cfg.publicBaseUrl, webhookToken: cfg.webhookToken });
  } else if (cfg.whatsappTransport === "linked-device") {
    throw new Error("linked-device transport requires the optional Baileys dependency; use simulator or cloud-api in this build");
  } else {
    transport = new SimulatorTransport();
  }

  const mediaSecret = sha256hex("media:" + (cfg.webhookToken || "dev"));
  const activeCampaign = () => db.prepare(`select * from campaigns where status='active' order by created_at limit 1`).get() || null;

  // ---- helpers ----------------------------------------------------------
  function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  async function json(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString("utf8")) : {}; }
  function send(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
  function authOr403(req, res, ...roles) {
    const authHeader = req.headers.authorization || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const session = auth.authenticate(bearer);
    if (!session) { send(res, 401, { error: "unauthorized" }); return null; }
    if (!auth.hasRole(session.user, ...roles)) { send(res, 403, { error: "forbidden" }); return null; }
    return session.user;
  }
  const persistInbound = db.prepare(
    `insert or ignore into inbound_events (id, provider_message_id, campaign_id, wa_phone_uid, provider, payload_json, media_id, status, received_at)
     values (?,?,?,?,?,?,?,?,?)`);

  // ---- routes -------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    try {
      // ---- provider: webhook -------------------------------------------------
      if (p === "/webhooks/whatsapp" && req.method === "GET") {
        const hs = transport.verifyHandshake ? transport.verifyHandshake(url.searchParams) : null;
        if (hs) { res.writeHead(hs.status, { "content-type": "text/plain" }); res.end(hs.body); return; }
        return send(res, 403, { error: "verification failed" });
      }
      if (p === "/webhooks/whatsapp" && req.method === "POST") {
        const raw = await readBody(req);
        if (transport instanceof CloudApiTransport) {
          const okSig = transport.validateSignature(req.headers, raw);
          if (!okSig) return send(res, 403, { error: "invalid signature" });
        }
        let payload;
        try { payload = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "bad payload" }); }
        const events = transport.parseInbound ? transport.parseInbound(payload) : (payload.events || []);
        // Durable intake lives in conversation.handle (unique provider_message_id);
        // the webhook only routes. seen=1 when a replay returns no processing.
        // Dev/test: payload.media = { [providerMessageId]: base64bytes } supplies
        // receipt bytes directly (simulator transport has no real uploads).
        const mediaMap = payload.media || {};
        let seen = 0;
        for (const ev of events) {
          // download media for image/document events
          let mediaBytes = null, mime = null;
          if (ev.type === "message.image" || ev.type === "message.document") {
            try {
              mediaBytes = mediaMap[ev.providerMessageId]
                ? Buffer.from(mediaMap[ev.providerMessageId], "base64")
                : (ev.mediaId ? await transport.downloadMedia(ev.mediaId) : null);
              mime = ev.type === "message.image" ? "image/jpeg" : "application/pdf";
            }
            catch { mediaBytes = null; }
          }
          const res = await conversation.handle({ providerMessageId: ev.providerMessageId, phoneUid: ev.phoneUid, type: ev.type, text: ev.text, mediaBytes, mime });
          if (res.alreadySeen) seen += 1;
        }
        return send(res, 200, { received: events.length, deduped: seen });
      }

      // ---- health ------------------------------------------------------------
      if (p === "/health/live") return send(res, 200, { ok: true });
      if (p === "/health/ready") {
        try { db.prepare(`select 1`).get(); return send(res, 200, { ok: true }); }
        catch { return send(res, 503, { ok: false }); }
      }

      // ---- public console / landing (no auth required) -------------------------
      if (p === "/" || p === "/admin") {
        const staticPath = path.join(ROOT, "src", "web", "index.html");
        if (fs.existsSync(staticPath)) { res.writeHead(200, { "content-type": "text/html" }); return res.end(fs.readFileSync(staticPath)); }
        return send(res, 200, {
          name: "WhatsApp Promotion Platform",
          status: "ok",
          endpoints: ["/health/live", "/health/ready", "/webhooks/whatsapp", "/api/login", "/api/campaigns", "/api/receipts", "/api/entries", "/api/draws", "/api/crm-sync", "/api/audit-events"],
          auth: "POST /api/login with ADMIN_EMAIL / ADMIN_PASSWORD, then Authorization: Bearer <token>",
        });
      }
      // static assets for the admin console (public; no secrets inside)
      if (p.startsWith("/web/")) {
        const rel = p.slice("/web/".length).replace(/\.\./g, "");
        const file = path.join(ROOT, "src", "web", rel);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
          res.writeHead(200, { "content-type": mime });
          return res.end(fs.readFileSync(file));
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- auth --------------------------------------------------------------
      if (p === "/api/login" && req.method === "POST") {
        const body = await json(req);
        const s = auth.login({ email: body.email, password: body.password, remember: !!body.remember });
        return s ? send(res, 200, { token: s.token, user: { id: s.user.id, name: s.user.name, email: s.user.email, roles: JSON.parse(s.user.roles) } })
                 : send(res, 401, { error: "invalid credentials" });
      }
      if (p === "/api/logout" && req.method === "POST") {
        const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        auth.revoke(bearer); return send(res, 200, { ok: true });
      }

      // ---- protected admin API ------------------------------------------------
      const user = authOr403(req, res, "platform_admin", "campaign_manager", "reviewer", "draw_officer", "draw_approver", "winner_ops", "support", "auditor");
      if (!user) return;

      if (p === "/api/whoami") return send(res, 200, { id: user.id, name: user.name, roles: JSON.parse(user.roles || "[]") });

      // campaigns
      if (p === "/api/campaigns" && req.method === "GET") {
        const campaigns = domain.listCampaigns().map((c) => ({ ...c, draw_config: JSON.parse(c.draw_config_json || "{}") }));
        return send(res, 200, { campaigns });
      }
      if (p === "/api/campaigns" && req.method === "POST" && auth.hasRole(user, "campaign_manager")) {
        const b = await json(req);
        if (!b.code || !b.start_at || !b.end_at) return send(res, 400, { error: "code, start_at, end_at required" });
        const c = domain.createCampaign({ code: b.code, name: b.name || b.code, startAt: b.start_at, endAt: b.end_at, drawConfig: b.draw_config || {} });
        return send(res, 201, c);
      }
      const mkVersion = p.match(/^\/api\/campaigns\/([^/]+)\/versions$/);
      if (mkVersion && req.method === "POST" && auth.hasRole(user, "campaign_manager")) {
        const b = await json(req);
        const vid = domain.createVersion(mkVersion[1], { content: b.content || {}, rules: b.rules || {}, flags: b.flags || {} });
        return send(res, 201, { versionId: vid });
      }
      if (mkVersion && req.method === "GET") {
        const versions = domain.listVersions(mkVersion[1]).map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, frozen_at: v.frozen_at, config_hash: v.config_hash }));
        return send(res, 200, { versions });
      }
      const act = p.match(/^\/api\/campaigns\/([^/]+)\/versions\/([^/]+)\/activate$/);
      if (act && req.method === "POST" && auth.hasRole(user, "campaign_manager")) {
        const v = domain.activateVersion(act[1], act[2], user.id);
        return send(res, 200, { versionId: v.id, status: v.status });
      }

      // outlets + products (admin)
      if (p === "/api/outlets" && req.method === "GET") return send(res, 200, { outlets: domain.listOutlets() });
      if (p === "/api/outlets" && req.method === "POST" && auth.hasRole(user, "campaign_manager")) {
        const o = await json(req);
        if (!o.outlet_code || !o.retailer || !o.town || !o.province) return send(res, 400, { error: "outlet_code, retailer, town, province required" });
        return send(res, 201, domain.upsertOutlet(o));
      }
      if (p === "/api/products" && req.method === "GET") return send(res, 200, { products: domain.listProducts() });
      if (p === "/api/products" && req.method === "POST" && auth.hasRole(user, "campaign_manager")) {
        const pr = await json(req);
        if (!pr.sku || !pr.name || !pr.pack_weight_kg) return send(res, 400, { error: "sku, name, pack_weight_kg required" });
        return send(res, 201, { id: domain.upsertProduct(pr) });
      }

      // receipts + review
      if (p === "/api/receipts" && req.method === "GET") {
        const rows = db.prepare(`select id, status, reason_code, participant_id, campaign_id, created_at from receipts order by created_at desc limit 200`).all();
        return send(res, 200, { receipts: rows });
      }
      const rm = p.match(/^\/api\/receipts\/([^/]+)$/);
      if (rm && req.method === "GET") {
        const r = db.prepare(`select * from receipts where id=?`).get(rm[1]);
        if (!r) return send(res, 404, { error: "not found" });
        const media = r.media_asset_id ? mediaStore.get(r.media_asset_id) : null;
        const signed = media ? signMediaUrl(r.media_asset_id, mediaSecret) : null;
        const validation = db.prepare(`select * from validation_results where receipt_id=?`).all(r.id) || [];
        return send(res, 200, { receipt: r, media: signed, validation });
      }
      const rv = p.match(/^\/api\/receipts\/([^/]+)\/reviews$/);
      if (rv && req.method === "POST" && auth.hasRole(user, "reviewer")) {
        const b = await json(req);
        try {
          const r = pipeline.reviewDecision(rv[1], user.id, b.decision, b.reason_code, b.note);
          return send(res, 200, { receiptId: r.receipt.id, decision: r.receipt.status, entryId: r.entryId });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // signed media viewer (reviewer only)
      const mm = p.match(/^\/api\/media\/([^/]+)$/);
      if (mm && req.method === "GET" && auth.hasRole(user, "reviewer")) {
        const assetId = mm[1], exp = url.searchParams.get("exp"), sig = url.searchParams.get("sig");
        if (!verifyMediaSig(assetId, exp, sig, mediaSecret)) return send(res, 403, { error: "invalid or expired media link" });
        const a = mediaStore.get(assetId);
        const bytes = a ? mediaStore.readBytes(a) : null;
        if (!bytes) return send(res, 404, { error: "media not found" });
        res.writeHead(200, { "content-type": a.mime, "content-length": a.size_bytes });
        return res.end(bytes);
      }

      // entries
      if (p === "/api/entries" && req.method === "GET") {
        const rows = db.prepare(`select * from entries order by created_at desc limit 200`).all();
        return send(res, 200, { entries: rows });
      }

      // draws
      if (p === "/api/draws" && req.method === "GET") {
        const rows = db.prepare(`select id, draw_period, status, snapshot_hash, output_hash, created_at from draws order by created_at desc limit 20`).all();
        return send(res, 200, { draws: rows });
      }
      if (p === "/api/draws" && req.method === "POST" && auth.hasRole(user, "draw_officer")) {
        const b = await json(req);
        const camp = activeCampaign() || domain.getCampaign(b.campaign_id);
        if (!camp) return send(res, 400, { error: "no campaign" });
        const period = b.draw_period;
        const entries = db.prepare(`select id from entries where campaign_id=? and draw_period=? and status='active'`).all(camp.id, period).map((r) => r.id);
        try {
          const d = drawService.freeze({ campaignId: camp.id, drawPeriod: period, configHash: sha256hex(period), entryIds: entries, operatorId: user.id });
          return send(res, 201, { drawId: d.id, count: entries.length, snapshotHash: d.snapshot_hash });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      let dm = p.match(/^\/api\/draws\/([^/]+)\/(execute|approve|publish)$/);
      if (dm && req.method === "POST") {
        const action = dm[2], did = dm[1];
        const role = action === "approve" ? "draw_approver" : "draw_officer";
        if (!auth.hasRole(user, role)) return send(res, 403, { error: "forbidden" });
        try {
          const d = action === "execute" ? drawService.execute(did, user.id)
            : action === "approve" ? drawService.approve(did, user.id)
            : drawService.publish(did);
          return send(res, 200, { draw: d });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // CRM reconciliation
      if (p === "/api/crm-sync" && req.method === "GET" && auth.hasRole(user, "support", "platform_admin")) {
        const jobs = db.prepare(`select id, entity_type, entity_id, event_type, status, attempts, last_error, external_id from crm_sync_jobs order by created_at desc limit 100`).all();
        return send(res, 200, { jobs, reconcile: crm.reconcileView() });
      }

      // audit
      if (p === "/api/audit-events" && req.method === "GET" && auth.hasRole(user, "auditor")) {
        const rows = db.prepare(`select id, actor_type, actor_id, action, target_type, target_id, entry_hash, created_at from audit_events order by id desc limit 200`).all();
        return send(res, 200, { events: rows });
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      log.error("[http]", e.message);
      return send(res, 500, { error: "internal error" });
    }
  });

  return {
    server, transport, db, domain, outbox, pipeline, conversation, drawService, crm, auth,
    listen() { return new Promise((r) => server.listen(cfg.port, cfg.host, () => { (log?.log || log || console.log)(`[server] listening on ${cfg.host}:${cfg.port}`); r(server); })); },
    close() { return new Promise((r) => server.close(r)); },
  };
}