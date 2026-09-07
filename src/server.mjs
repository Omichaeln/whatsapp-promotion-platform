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
import { LinkedDeviceTransport } from "./transport/linked-device.mjs";
import { verifyInboundSignature } from "./transport/whatsapp-transport.mjs";
import { createDeskStore } from "./desk.mjs";
import { createAi, createUsage } from "./ai.mjs";
import { parseCommand, HELP_TEXT } from "./nlp.mjs";
import { createWinnerService } from "./winner-service.mjs";

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
  // desk workflow (restored from the original WhatsApp Desk)
  const desk = createDeskStore(db);
  const usage = createUsage(desk, cfg.ai?.monthlyBudgetUsd ?? 0);
  const ai = createAi({ cfg, store: desk, usage });
  // late-bound: linked-device callbacks run at message time, after `conversation`
  // is created below.
  let conversation;
  const drawService = createDrawService(db);
  const crm = createCrm({ db, cfg: cfg.crm });
  const winners = createWinnerService(db, { outbox });

  // ---- transport --------------------------------------------------------
  const activity = (kind, summary, detail) => { try { desk.activity(kind, summary, detail); } catch { /* non-fatal */ } };
  const phoneInbound = async (ev) => {
    if (!conversation) return;
    const res = await conversation.handle({ providerMessageId: ev.providerMessageId, phoneUid: ev.phoneUid, type: ev.type, text: ev.text || "", mediaBytes: ev.mediaBytes, mime: ev.mime });
    if (res?.replies) {
      for (const reply of res.replies) {
        outbox.enqueueWhatsApp({ waPhoneUid: ev.phoneUid, kind: "text", payload: reply, idempotencyKey: `conv:${ev.providerMessageId}:${reply.slice(0, 16)}` });
      }
    }
    return res;
  };
  let transport;
  if (cfg.whatsappTransport === "cloud-api") {
    transport = new CloudApiTransport({ meta: cfg.meta, publicBaseUrl: cfg.publicBaseUrl, webhookToken: cfg.webhookToken });
  } else if (cfg.whatsappTransport === "linked-device") {
    transport = new LinkedDeviceTransport({ authDir: cfg.baileysAuthDir, deskStore: desk, onActivity: activity, log });
  } else {
    transport = new SimulatorTransport();
  }

  conversation = createConversationService({ db, domain, receiptPipeline: pipeline, outbox });
  if (transport instanceof LinkedDeviceTransport) {
    transport.onTextMessage = (ev) => phoneInbound({ ...ev, type: "message.text" });
    transport.onImageMessage = (ev) => phoneInbound({ ...ev, type: "message.image" });
    transport.start().catch((e) => log?.log?.(`[linked] start failed: ${e.message}`));
  }

  const mediaSecret = sha256hex("media:" + (cfg.webhookToken || "dev"));
  const activeCampaign = () => db.prepare(`select * from campaigns where status='active' order by created_at limit 1`).get() || null;

  // ---- DEF-05: login rate limiting (per-IP sliding window) ---------------------
  const loginAttempts = new Map(); // ip -> number[]
  const RATE_WINDOW_MS = 60_000, RATE_MAX = 5;
  const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const rateLimited = (req) => {
    const ip = clientIp(req);
    const now = Date.now();
    const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) { loginAttempts.set(ip, arr); return { limited: true, retryAfter: Math.ceil((arr[0] + RATE_WINDOW_MS - now) / 1000) }; }
    arr.push(now); loginAttempts.set(ip, arr);
    return { limited: false, ip };
  };
  const resetRateLimit = (req) => loginAttempts.delete(clientIp(req));

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
  function serveStatic(res, file, mime) {
    res.writeHead(200, { "content-type": mime, "cache-control": "public, max-age=3600" });
    return res.end(fs.readFileSync(file));
  }
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

      // ---- public console (no auth) ------------------------------------------
      // React console build (src/web-console -> npm run web:build -> this dir).
      // IMPORTANT: only handle root + /admin + real asset files here; any other
      // path must fall through to the API/auth/404 chain below (API routes 404
      // on an unauthenticated /api call, console serves its own assets). A
      // blanket 404 in this block would swallow /api/login and all APIs.
      const CONSOLE_DIST = path.join(ROOT, "src", "web-console-dist");
      if (fs.existsSync(path.join(CONSOLE_DIST, "index.html"))) {
        if (p === "/" || p === "/admin") return serveStatic(res, path.join(CONSOLE_DIST, "index.html"), "text/html");
        const assetRel = p.split("?")[0].replace(/^\//, "");
        const assetFile = path.join(CONSOLE_DIST, assetRel);
        if (assetRel && !assetRel.includes("..") && fs.existsSync(assetFile) && fs.statSync(assetFile).isFile()) {
          const ext = path.extname(assetFile);
          const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[ext] || "application/octet-stream";
          return serveStatic(res, assetFile, mime);
        }
        // not a console path -> fall through to the rest of the router
      }

      // ---- canonical public desk routes (original API surface) -------------------
      if (p === "/api/config") {
        const brand = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "brand.json"), "utf8"));
        return send(res, 200, {
          ...brand,
          name: brand.name || "WhatsApp Promotion Platform",
          locked: !cfg.adminPassword, // server-side login is the real gate
          features: { ai: ai.hasKey, promotion: true },
          transport: cfg.whatsappTransport,
        });
      }
      if (p === "/api/qr") {
        const svg = typeof transport.qrSvg === "function" ? transport.qrSvg() : null;
        if (svg) { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }); return res.end(svg); }
        return send(res, 200, { ready: transport.health?.().ready !== false });
      }
      // Public winners view (REQ-20): disclosure fields only; no auth required.
      if (p === "/api/winners/public" && req.method === "GET") {
        return send(res, 200, { winners: winners.listPublic() });
      }

      // ---- auth --------------------------------------------------------------
      if (p === "/api/login" && req.method === "POST") {
        const rl = rateLimited(req);
        if (rl.limited) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) });
          return res.end(JSON.stringify({ error: "too many login attempts, slow down", retryAfter: rl.retryAfter }));
        }
        const body = await json(req);
        const s = auth.login({ email: body.email, password: body.password, remember: !!body.remember });
        if (s?.pendingMfa) { resetRateLimit(req); return send(res, 200, { pendingMfa: true, userId: s.userId, message: s.message }); }
        if (s) { resetRateLimit(req); return send(res, 200, { token: s.token, user: { id: s.user.id, name: s.user.name, email: s.user.email, roles: JSON.parse(s.user.roles) } }); }
        return send(res, 401, { error: "invalid credentials" });
      }
      if (p === "/api/login/mfa" && req.method === "POST") {
        const body = await json(req);
        const r = auth.verifyMfa({ userId: body.userId, code: body.code, remember: !!body.remember });
        if (r?.token) return send(res, 200, { token: r.token, user: { id: r.user.id, name: r.user.name, email: r.user.email, roles: JSON.parse(r.user.roles) } });
        return send(res, 401, { error: r?.error || "MFA verification failed" });
      }
      if (p === "/api/logout" && req.method === "POST") {
        const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        auth.revoke(bearer); return send(res, 200, { ok: true });
      }

      // ---- MFA management (platform_admin, authenticated) ----------------------
      if (p === "/api/mfa/enroll" && req.method === "POST") {
        const mu = authOr403(req, res, "platform_admin"); if (!mu) return;
        return send(res, 200, auth.enrollMfa(mu.id));
      }
      if (p === "/api/mfa/enable" && req.method === "POST") {
        const mu = authOr403(req, res, "platform_admin"); if (!mu) return;
        const b = await json(req);
        return send(res, 200, auth.enableMfa(mu.id, b.code) || { error: "no code" });
      }
      if (p === "/api/mfa/disable" && req.method === "POST") {
        const mu = authOr403(req, res, "platform_admin"); if (!mu) return;
        const b = await json(req);
        return send(res, 200, auth.disableMfa(mu.id, b.code) || { error: "no code" });
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
      let dm = p.match(/^\/api\/draws\/([^/]+)\/(execute|approve|publish|rerun)$/);
      if (dm && req.method === "POST") {
        const action = dm[2], did = dm[1];
        const role = action === "approve" ? "draw_approver" : "draw_officer";
        if (!auth.hasRole(user, role)) return send(res, 403, { error: "forbidden" });
        try {
          if (action === "rerun") {
            const old = drawService.get(did);
            const camp = old?.campaign_id || activeCampaign()?.id;
            const b = await json(req);
            const period = b?.draw_period || old?.draw_period;
            const entries = db.prepare(`select id from entries where campaign_id=? and draw_period=? and status='active'`).all(camp, period).map((r) => r.id);
            const d = drawService.freeze({ campaignId: camp, drawPeriod: `${period}#${Date.now().toString(36)}`, configHash: sha256hex(period + b?.reason || ""), entryIds: entries, operatorId: user.id });
            return send(res, 200, { draw: d, supersedes: did, reason: b?.reason || null });
          }
          let d;
          if (action === "execute") d = drawService.execute(did, user.id);
          else if (action === "approve") d = drawService.approve(did, user.id);
          else { d = drawService.publish(did); winners.materialise(did); activity("draw", `Winners published for ${d?.draw_period || did}`, { draw: did }); }
          return send(res, 200, { draw: d });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // ---- winners + claims (DEF-03, REQ-20/22) --------------------------------
      const wmatch = p.match(/^\/api\/winners(?:\/([^/]+))?$/);
      if (wmatch && req.method === "GET") {
        const id = wmatch[1];
        if (id) {
          const w = winners.get(id);
          if (!w) return send(res, 404, { error: "winner not found" });
          return send(res, 200, { winner: w, claims: winners.claims(id) });
        }
        return send(res, 200, { winners: winners.list() });
      }
      if (wmatch && req.method === "PATCH") {
        if (!auth.hasRole(user, "winner_ops")) return send(res, 403, { error: "forbidden" });
        const id = wmatch[1];
        if (!id) return send(res, 400, { error: "winner id required" });
        const b = await json(req);
        try {
          const r = winners.transition(id, { status: b.status, note: b.note, reason: b.reason, actorId: user.id });
          return send(res, 200, { winner: r.winner, replacement: r.replacement });
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

      // ---- DEF-06: controlled export (auditor/admin) ----------------------------------
      if (p === "/api/reports/export" && req.method === "GET") {
        if (!auth.hasRole(user, "auditor")) return send(res, 403, { error: "forbidden" });
        const scope = url.searchParams.get("scope") || "receipts";
        const since = url.searchParams.get("since") || new Date(Date.now() - 90 * 86400_000).toISOString();
        const cap = 50_000;
        let rows;
        switch (scope) {
          case "receipts": rows = db.prepare(`select id, participant_id, campaign_id, status, reason_code, decided_at, created_at from receipts where created_at >= ? order by created_at desc limit ${cap}`).all(since); break;
          case "entries": rows = db.prepare(`select * from entries where created_at >= ? order by created_at desc limit ${cap}`).all(since); break;
          case "winners": rows = db.prepare(`select w.id, w.draw_id, w.rank, w.prize_code, w.status, d.draw_period from winners w left join draws d on d.id=w.draw_id order by d.draw_period desc limit ${cap}`).all(); break;
          case "audit": rows = db.prepare(`select id, actor_type, actor_id, action, target_type, target_id, created_at from audit_events order by id desc limit ${cap}`).all(); break;
          case "members": rows = db.prepare(`select id, first_name, surname, location, status, created_at from participants order by created_at desc limit ${cap}`).all(); break;
          default: return send(res, 400, { error: `unknown scope "${scope}"` });
        }
        // watermark: never silently serve identity values in bulk
        const payload = {
          scope, generated_at: new Date().toISOString(), exported_by: user.email, watermark: true, count: rows.length, rows,
        };
        activity("export", `Exported ${rows.length} ${scope} by ${user.email}`, { scope, count: rows.length });
        db.prepare(`insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id, prev_hash, entry_hash, payload_json, created_at)
          values (?,?,?,?,?,?,?,?,?,?,?)`)
          .run("admin", user.id, "export", "report", scope, `${rows.length} ${scope}`, null, "", "", JSON.stringify({ scope, count: rows.length }), nowIso());
        return send(res, 200, payload);
      }

      // ---- restored desk workflows: dashboard, activity, AI, NLP ------------
      const metricsPayload = async () => {
        const campCount = db.prepare(`select count(*) n from campaigns where status='active'`).get().n;
        const receipts = db.prepare(`select status, count(*) n from receipts group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
        const entriesCount = db.prepare(`select count(*) n from entries where status='active'`).get().n;
        const draws = db.prepare(`select status, count(*) n from draws group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
        const participants = db.prepare(`select count(*) n from participants`).get().n;
        const usageSnap = await usage.snapshot();
        const transportHealth = (() => { try { return transport.health?.(); } catch { return {}; } })();
        return {
          campaigns: { active: campCount },
          receipts,
          entries: entriesCount,
          draws,
          participants,
          threads: desk.threadStats(),
          messages: desk.countMessages(),
          usage: usageSnap,
          transport: { provider: transportHealth.provider || cfg.whatsappTransport, ready: !!transportHealth.ready, me: transportHealth.me, qr: transportHealth.qr, lastError: transportHealth.lastError },
          activity: desk.recentActivity(12),
          db: { ok: true },
        };
      };

      // Dashboard: activity + reports + system status + performance metrics
      if (p === "/api/metrics" && req.method === "GET") return send(res, 200, await metricsPayload());
      if (p === "/api/activity" && req.method === "GET") {
        return send(res, 200, { events: desk.recentActivity(Number(url.searchParams.get("limit") || 30)) });
      }

      // ---- canonical desk routes (the original console calls these) ------------
      if (p === "/api/data" && req.method === "GET") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 14)));
        const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
        const raw = desk.messages({ where: "where timestamp >= ?", params: [sinceIso], limit: 3000 });
        const threads = desk.threads().map((t) => ({ ...t, needs_reply: t.needs_reply === 1, processed: undefined }));
        const messages = raw.map((m) => ({ ...m, processed: m.processed === 1 }));
        return send(res, 200, { messages, threads, briefs: desk.briefs(12) });
      }
      if (p === "/api/status" && req.method === "GET") {
        const h = transport.health?.() || {};
        return send(res, 200, { ...h, provider: h.provider || cfg.whatsappTransport });
      }
      if (p === "/api/usage" && req.method === "GET") return send(res, 200, await usage.snapshot());
      if (p === "/api/refresh" && req.method === "POST") {
        const body = await json(req);
        const hours = Math.min(24 * 14, Math.max(1, Number(body.hours || 48)));
        const cutoffIso = new Date(Date.now() - hours * 3600_000).toISOString();
        const rows = await desk.unprocessed({ cutoffIso, limit: 800 });
        if (!rows.length) return send(res, 200, { brief: null, message: "Nothing new since the last brief." });
        const result = await ai.summarise(rows);
        const brief = desk.insertBrief({ brief_md: result.brief_md, pulse: result.pulse, message_count: rows.length, direct_count: rows.filter((r) => r.chat_type === "direct").length, group_count: rows.filter((r) => r.chat_type === "group").length, model: result.model, made_by: result.made_by });
        for (const c of result.chats) {
          const last = rows.filter((r) => r.chat_id === c.chat_id).sort((a, b) => String(b.timestamp) < String(a.timestamp) ? -1 : 1)[0];
          if (last) desk.upsertThread({ chat_id: c.chat_id, chat_type: c.chat_type, chat_name: c.chat_name, category: c.category, priority: c.priority, needs_reply: c.needs_reply, confidence: c.confidence, summary: c.summary, draft: c.draft, status: c.routine_report && !c.needs_reply ? "filed" : "open", last_message_at: last.timestamp, updated_at: nowIso() });
        }
        desk.markProcessed(rows.map((r) => r.id));
        activity("brief", `Brief: ${rows.length} messages across ${result.chats.length} chats`, { hours });
        return send(res, 200, { brief, pulse: result.pulse, made_by: result.made_by });
      }
      if (p === "/api/draft" && req.method === "POST") {
        const body = await json(req);
        const out = await ai.draft({ context: body.context, instruction: body.instruction, current: body.current });
        if (out.status) return send(res, out.status, out);
        return send(res, 200, out);
      }
      const thCanon = p.match(/^\/api\/threads\/(.+)$/);
      if (thCanon && req.method === "PATCH") {
        const b = await json(req);
        const chatId = decodeURIComponent(thCanon[1]);
        const t = desk.thread(chatId);
        if (!t) return send(res, 404, { error: "thread not found" });
        desk.upsertThread({ chat_id: chatId, chat_type: t.chat_type || "direct", chat_name: t.chat_name, category: b.category || t.category || "Other", priority: b.priority || t.priority, needs_reply: b.needs_reply ?? t.needs_reply, confidence: b.confidence ?? t.confidence, summary: b.summary ?? t.summary, draft: b.draft !== undefined ? b.draft : t.draft, status: b.status || t.status, last_message_at: t.last_message_at, updated_at: nowIso() });
        return send(res, 200, { ...desk.thread(chatId), needs_reply: desk.thread(chatId).needs_reply === 1 });
      }
      if (p === "/api/send" && req.method === "POST") {
        const b = await json(req);
        const target = String(b.chat_id || b.target || "");
        if (!b.text) return send(res, 400, { error: "text is required" });
        if (target.endsWith("@g.us")) return send(res, 400, { error: "cannot send to a group from the desk; use direct chats or phones" });
        const phone = target.split("@")[0].replace(/[^\d]/g, "");
        outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", payload: String(b.text).slice(0, 4000), idempotencyKey: `send:${nowIso()}:${phone}:${String(b.text).slice(0, 16)}` });
        activity("send", `Queued message to ${phone.slice(-9)}`, { len: String(b.text).length });
        return send(res, 200, { ok: true, queued: true });
      }
      if (p === "/api/unlink" && req.method === "POST") {
        if (typeof transport.unlink === "function") await transport.unlink();
        return send(res, 200, { ok: true });
      }

      // WhatsApp link via QR (linked device)
      if (p === "/api/desk/qr" && req.method === "GET") {
        const svg = typeof transport.qrSvg === "function" ? transport.qrSvg() : null;
        const health = transport.health?.() || {};
        return send(res, 200, { svg, ready: health.ready || false, me: health.me, qr: health.qr, lastError: health.lastError });
      }
      if (p === "/api/desk/link" && req.method === "POST") {
        if (typeof transport.start !== "function" || transport.constructor?.name !== "LinkedDeviceTransport") return send(res, 400, { error: "linked-device transport is not active" });
        await transport.start();
        return send(res, 200, { ok: true, message: "Scan the QR code with WhatsApp > Linked devices > Link a device" });
      }
      if (p === "/api/desk/unlink" && req.method === "POST") {
        if (typeof transport.unlink === "function") await transport.unlink();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/desk/status" && req.method === "GET") {
        const health = transport.health?.() || {};
        const deskStats = desk.threadStats();
        return send(res, 200, {
          transport: health,
          desk: { threads: deskStats, messages: desk.countMessages() },
          usage: await usage.snapshot(),
          ai: { provider: ai.hasKey ? (cfg.ai?.openaiModel || "gpt-4o-mini") : "deterministic-fallback" },
        });
      }

      // desk messages + threads + briefs (data restored from the original desk)
      if (p === "/api/desk/messages" && req.method === "GET") {
        return send(res, 200, { messages: desk.messages({ limit: Number(url.searchParams.get("limit") || 100) }) });
      }
      if (p === "/api/desk/threads" && req.method === "GET") {
        const q = url.searchParams;
        return send(res, 200, { threads: desk.threads({ status: q.get("status") || undefined, priority: q.get("priority") || undefined, category: q.get("category") || undefined, limit: Number(q.get("limit") || 300) }) });
      }
      const thMatch = p.match(/^\/api\/desk\/threads\/(.+)$/);
      if (thMatch && req.method === "PATCH") {
        const b = await json(req);
        const chatId = decodeURIComponent(thMatch[1]);
        const t = desk.thread(chatId);
        if (!t) return send(res, 404, { error: "thread not found" });
        desk.upsertThread({ chat_id: chatId, chat_type: t.chat_type || "direct", chat_name: t.chat_name, category: b.category || t.category || "Other", priority: b.priority || t.priority, needs_reply: b.needs_reply ?? t.needs_reply, confidence: b.confidence ?? t.confidence, summary: b.summary ?? t.summary, draft: b.draft !== undefined ? b.draft : t.draft, status: b.status || t.status, last_message_at: t.last_message_at, updated_at: nowIso() });
        return send(res, 200, { thread: desk.thread(chatId) });
      }
      if (p === "/api/desk/briefs" && req.method === "GET") return send(res, 200, { briefs: desk.briefs(Number(url.searchParams.get("limit") || 12)) });

      // AI: brief/triage, draft, transcribe, classify
      if (p === "/api/desk/brief" && req.method === "POST") {
        const body = await json(req);
        const hours = Math.min(24 * 14, Math.max(1, Number(body.hours || 48)));
        const cutoffIso = new Date(Date.now() - hours * 3600_000).toISOString();
        const rows = await desk.unprocessed({ cutoffIso, limit: 800 });
        if (!rows.length) return send(res, 200, { brief: null, message: "Nothing new since the last brief." });
        const result = await ai.summarise(rows);
        const brief = desk.insertBrief({ brief_md: result.brief_md, pulse: result.pulse, message_count: rows.length, direct_count: rows.filter((r) => r.chat_type === "direct").length, group_count: rows.filter((r) => r.chat_type === "group").length, model: result.model, made_by: result.made_by });
        for (const c of result.chats) {
          const last = rows.filter((r) => r.chat_id === c.chat_id).sort((a, b) => String(b.timestamp) < String(a.timestamp) ? -1 : 1)[0];
          if (last) desk.upsertThread({ chat_id: c.chat_id, chat_type: c.chat_type, chat_name: c.chat_name, category: c.category, priority: c.priority, needs_reply: c.needs_reply, confidence: c.confidence, summary: c.summary, draft: c.draft, status: c.routine_report && !c.needs_reply ? "filed" : "open", last_message_at: last.timestamp, updated_at: nowIso() });
        }
        desk.markProcessed(rows.map((r) => r.id));
        activity("brief", `Brief: ${rows.length} messages across ${result.chats.length} chats`, { hours });
        return send(res, 200, { brief, pulse: result.pulse, chats: result.chats, made_by: result.made_by });
      }
      if (p === "/api/desk/draft" && req.method === "POST") {
        const body = await json(req);
        const out = await ai.draft({ context: body.context, instruction: body.instruction, current: body.current });
        if (out.status) return send(res, out.status, out);
        return send(res, 200, out);
      }
      if (p === "/api/desk/transcribe" && req.method === "POST") {
        // multipart/form-data with an "audio" part -> ai.transcribe
        const m = (req.headers["content-type"] || "").match(/multipart\/form-data;\s*boundary=([^;]+)/);
        if (!m) return send(res, 400, { error: "multipart audio required" });
        const bodyBuf = await readBody(req, 25 * 1024 * 1024);
        const boundary = `--${m[1]}`;
        const find = (hay, needle, from = 0) => {
          const h = Buffer.from(hay), n = Buffer.from(needle);
          for (let i = from; i <= h.length - n.length; i++) {
            let ok = true;
            for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) { ok = false; break; }
            if (ok) return i;
          }
          return -1;
        };
        const first = find(bodyBuf, Buffer.from(boundary));
        const partStart = first + Buffer.from(boundary).length + 2; // past \r\n
        const headerEnd = find(bodyBuf, Buffer.from("\r\n\r\n"), partStart);
        if (headerEnd < 0) return send(res, 400, { error: "malformed multipart" });
        const payloadStart = headerEnd + 4;
        const next = find(bodyBuf, Buffer.from(boundary), payloadStart);
        const audioBytes = next > 0 ? bodyBuf.subarray(payloadStart, next - 2) : bodyBuf.subarray(payloadStart);
        const headersText = bodyBuf.subarray(partStart, headerEnd).toString("latin1");
        const mimeMatch = headersText.match(/content-type:\s*([^\r\n;]+)/i);
        const mime = mimeMatch ? mimeMatch[1].trim() : "audio/webm";
        const out = await ai.transcribe(audioBytes, mime);
        if (out.status) return send(res, out.status, out);
        activity("voice", `Transcribed a voice note`, { seconds: out.usage?.month_usd ?? 0 });
        return send(res, 200, { text: out.text, usage: out.usage });
      }

      // Natural-language commands
      if (p === "/api/nl" && req.method === "POST") {
        const body = await json(req);
        const parsed = parseCommand(body.text || "");
        if (parsed.action === "help" || !parsed.action) {
          return send(res, 200, { action: "help", reply: HELP_TEXT, available: true });
        }
        let data = null, reply = parsed.reply;
        try {
          switch (parsed.action) {
            case "dashboard": data = await metricsPayload(); break;
            case "status": {
              const health = transport.health?.() || {};
              data = { transport: health, usage: await usage.snapshot(), threads: desk.threadStats() };
              reply = `System ${health.ready !== undefined ? (health.ready ? "ready" : "waiting") : "online"}. ${health.me ? `Linked as ${health.me}.` : ""} ${desk.countMessages()} messages filed, ${desk.threadStats().needsReply} open threads.`;
              break;
            }
            case "review": data = await (async () => { const recs = db.prepare(`select id, status, reason_code, created_at from receipts where status=? order by created_at desc limit ?`).all(parsed.params.status || "NEEDS_REVIEW", parsed.params.limit || 20); return { receipts: recs }; })(); reply = `${data.receipts.length} receipt(s) in review.`; break;
            case "entries": data = { entries: db.prepare(`select * from entries order by created_at desc limit 50`).all() }; reply = `${data.entries.length} entry(ies).`; break;
            case "participants": data = { participants: db.prepare(`select id, first_name, surname, location, status, created_at from participants order by created_at desc limit 100`).all() }; reply = `${data.participants.length} participant(s).`; break;
            case "campaigns": data = { campaigns: domain.listCampaigns() }; break;
            case "winners": data = { winners: db.prepare(`select * from winners order by rank limit 50`).all() }; reply = `${data.winners.length} winner(s) recorded.`; break;
            case "draw": {
              const camp = activeCampaign();
              const period = parsed.params.period || db.prepare(`select draw_period from entries where status='active' order by created_at desc limit 1`).get()?.draw_period;
              if (!camp || !period) { reply = "No active campaign or entries to draw from yet."; break; }
              const ids = db.prepare(`select id from entries where campaign_id=? and draw_period=? and status='active'`).all(camp.id, period).map((r) => r.id);
              if (!ids.length) { reply = `No active entries for ${period}.`; break; }
              const d = drawService.freeze({ campaignId: camp.id, drawPeriod: period, configHash: sha256hex(period), entryIds: ids, operatorId: user.id });
              const ex = drawService.execute(d.id, user.id);
              data = { draw: ex, count: ids.length };
              reply = `Frozen and executed draw for ${period} (${ids.length} candidates). Open Draws to approve + publish.`;
              break;
            }
            case "send": {
              if (!parsed.params?.phone) reply = "Who should I message? e.g. \"send: thanks to 263771234567\""; else {
                const msgId = await outbox.enqueueWhatsApp({ waPhoneUid: parsed.params.phone, kind: "text", payload: parsed.params.text, idempotencyKey: `nl:${Date.now()}:${parsed.params.phone}` });
                data = { queued: msgId }; reply = `Queued: "${parsed.params.text.slice(0, 60)}" to ${parsed.params.phone.slice(-9)}.`;
              }
              break;
            }
            case "draft": {
              const out = await ai.draft({ context: parsed.params.text || "", instruction: body.text, current: null });
              data = out; reply = out.text || "Draft ready (set OPENAI_API_KEY for model drafts).";
              break;
            }
            case "classify": {
              const out = await ai.summarise([{ chat_id: "nl", chat_type: "direct", chat_name: "Natural language", sender_name: "operator", message_text: parsed.params.text || "", timestamp: nowIso() }]);
              data = { classification: out.chats[0] }; reply = `Category: ${out.chats[0].category} · priority ${out.chats[0].priority}${out.chats[0].needs_reply ? " · needs reply" : ""}.`;
              break;
            }
            case "brief": {
              const hours = 48;
              const cutoffIso = new Date(Date.now() - hours * 3600_000).toISOString();
              const rows = await desk.unprocessed({ cutoffIso, limit: 800 });
              if (!rows.length) { reply = "Nothing new since the last brief."; break; }
              const result = await ai.summarise(rows);
              data = result; reply = result.pulse;
              break;
            }
            case "link": {
              const svg = typeof transport.qrSvg === "function" ? transport.qrSvg() : null;
              data = { svg, ready: transport.health?.().ready }; reply = svg ? "Scan the QR code to link your phone." : "WhatsApp is already linked.";
              break;
            }
            case "unlink": { if (typeof transport.unlink === "function") await transport.unlink(); reply = "Device unlinked."; break; }
            default: reply = "I didn't catch that. Type \"help\".";
          }
        } catch (e) { reply = `That didn't work: ${e.message}`; }
        return send(res, 200, { action: parsed.action, confidence: parsed.confidence, reply, data });
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