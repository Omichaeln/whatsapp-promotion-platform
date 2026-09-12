import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { openDb, migrate, nowIso, sha256hex } from "./db.mjs";
import { loadConfig, validateConfig, ROOT, ensureDir } from "./config.mjs";
import { createMediaStore } from "./media.mjs";
import { createDomain } from "./services.mjs";
import { createReceiptPipeline } from "./receipt-pipeline.mjs";
import { createOutbox } from "./outbox.mjs";
import { createDuplicateDetector } from "./duplicates.mjs";
import { createConversationService } from "./conversation.mjs";
import { createDrawService } from "./draw.mjs";
import { createCrm } from "./crm.mjs";
import { createAuth } from "./auth.mjs";
import { createExtractor } from "./extract/vision.mjs";
import { SimulatorTransport } from "./transport/simulator.mjs";
import { CloudApiTransport } from "./transport/cloud-api.mjs";
import { LinkedDeviceTransport } from "./transport/linked-device.mjs";
import { createDeskStore } from "./desk.mjs";
import { createAi, createUsage } from "./ai.mjs";
import { createWinnerService } from "./winner-service.mjs";
import { createIntake } from "./intake.mjs";
import { createWorker } from "./worker.mjs";
import { createRouter, readBody, readJson, send, E, HttpError, openapi } from "./http.mjs";
import { registerAdminRoutes } from "./routes/admin.mjs";
import { registerDeskRoutes } from "./routes/desk.mjs";

/**
 * HTTP surface + wiring (spec §6 modules). Webhook intake is durable-then-ack;
 * processing runs in the worker. All /api routes go through the router with
 * server-side role checks; the console build is served statically.
 */
export async function createServer({ config, log = console, transport: transportOverride = null, extractor: extractorOverride = null, crmAdapter = null } = {}) {
  const cfg = config || loadConfig();
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error(`configuration invalid: ${problems.join("; ")}`);
  ensureDir(cfg.mediaDir);
  const db = openDb(cfg.database);
  migrate(db, undefined, log?.log || console.log);
  // The database records its environment on first boot; it never silently changes afterwards.
  db.prepare(`insert or ignore into schema_meta (key, value) values ('environment', ?)`).run(cfg.environment);
  const environment = db.prepare(`select value from schema_meta where key='environment'`).get().value;
  if (environment !== cfg.environment) log.warn?.(`[server] database environment is "${environment}" but ENVIRONMENT=${cfg.environment}; the database value governs`);

  // ---- domain wiring ----------------------------------------------------------
  const domain = createDomain(db, cfg.identityKey || "dev-only-key", nowIso, { checkpointKey: cfg.auditCheckpointKey, retention: cfg.retention });
  const mediaStore = createMediaStore({ dir: cfg.mediaDir, db, retentionDays: cfg.retention.rawReceiptsDays });
  const outbox = createOutbox(db);
  const duplicates = createDuplicateDetector({ db });
  const extractor = extractorOverride || createExtractor(cfg, { log });
  const auth = createAuth(db, { bootstrap: cfg.adminEmail && cfg.adminPassword ? { email: cfg.adminEmail, password: cfg.adminPassword } : null, audit: domain.audit });
  const crm = createCrm({ db, cfg: cfg.crm, domain, adapter: crmAdapter, environment });
  const pipeline = createReceiptPipeline({ db, mediaStore, extractor, duplicates, outbox, domain, crm, log });
  const drawService = createDrawService(db, { domain, randomBytes: cfg.drawRandomBytes });
  const winners = createWinnerService(db, { outbox, domain, crm });
  const desk = createDeskStore(db);
  const usage = createUsage(desk, cfg.ai?.monthlyBudgetUsd ?? 0);
  const ai = createAi({ cfg, store: desk, usage });
  const activity = (kind, summary, detail) => { try { desk.activity(kind, summary, detail); } catch { /* non-fatal */ } };

  let transport = transportOverride;
  if (!transport) {
    if (cfg.whatsappTransport === "cloud-api") transport = new CloudApiTransport({ meta: cfg.meta, publicBaseUrl: cfg.publicBaseUrl, webhookToken: cfg.webhookToken });
    else if (cfg.whatsappTransport === "linked-device") transport = new LinkedDeviceTransport({ authDir: cfg.baileysAuthDir, deskStore: desk, onActivity: activity, log });
    else transport = new SimulatorTransport();
  }
  const conversation = createConversationService({ db, domain, receiptPipeline: pipeline, winners, crm, log });
  conversation.services = { winners, mediaStore };
  const intake = createIntake({ db, conversation, outbox, pipeline, domain, transport, log });
  if (transport instanceof LinkedDeviceTransport) {
    transport.onTextMessage = (ev) => intake.receive({ ...ev, provider: "linked-device", type: "message.text" });
    transport.onImageMessage = (ev) => intake.receive({ ...ev, provider: "linked-device", type: "message.image" });
    transport.start().catch((e) => log?.log?.(`[linked] start failed: ${e.message}`));
  }
  const worker = createWorker({ db, transport, outbox, crm, intake, domain, cfg, intervalMs: 1500, log });
  const mediaSecret = sha256hex("media:" + (cfg.webhookToken || cfg.identityKey || "dev"));

  // ---- login rate limiting (per-IP sliding window) ------------------------------
  const loginAttempts = new Map(); const RATE_WINDOW_MS = 60_000, RATE_MAX = 5;
  const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  const rateLimited = (req) => { const ip = clientIp(req); const t = Date.now(); const arr = (loginAttempts.get(ip) || []).filter((x) => t - x < RATE_WINDOW_MS); if (arr.length >= RATE_MAX) { loginAttempts.set(ip, arr); return Math.ceil((arr[0] + RATE_WINDOW_MS - t) / 1000); } arr.push(t); loginAttempts.set(ip, arr); return 0; };

  async function metricsPayload() {
    const receipts = db.prepare(`select status, count(*) n from receipts group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    const draws = db.prepare(`select status, count(*) n from draws group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    const th = transport.health?.() || {};
    return { campaigns: { active: db.prepare(`select count(*) n from campaigns where status='active'`).get().n }, receipts, entries: db.prepare(`select count(*) n from entries where status='active'`).get().n, draws, participants: db.prepare(`select count(*) n from participants`).get().n, review_open: db.prepare(`select count(*) n from review_tasks where state!='decided'`).get().n, threads: desk.threadStats(), messages: desk.countMessages(), usage: await usage.snapshot(), transport: { provider: th.provider || cfg.whatsappTransport, mode: th.mode, ready: !!th.ok, me: th.me, qr: th.qr, lastError: th.lastError }, outbound: outbox.stats(), crm: crm.reconcileView(), queues: intake.stats(), alerts_open: db.prepare(`select count(*) n from alerts where acknowledged_at is null`).get().n, activity: desk.recentActivity(12), db: { ok: true }, environment };
  }

  // ---- router -------------------------------------------------------------------------
  const router = createRouter({ auth, log: { error: log.error?.bind(log), info: cfg.logLevel === "debug" ? log.log?.bind(log) : null } });
  const S = { db, domain, auth, pipeline, drawService, winners, crm, outbox, intake, mediaStore, extractor, transport, conversation, cfg, worker, mediaSecret, desk, ai, usage, activity, metricsPayload };
  router.add("POST", "/api/login", { roles: "public", tag: "auth", body: { type: "object", required: ["email", "password"] } }, async ({ req, body }) => {
    const retry = rateLimited(req); if (retry) throw E.tooMany(retry);
    const b = await body(); const s = auth.login({ email: b.email, password: b.password, remember: !!b.remember });
    if (s?.pendingMfa) return { pendingMfa: true, userId: s.userId, message: s.message };
    if (s) { loginAttempts.delete(clientIp(req)); domain.audit({ actorType: "admin", actorId: s.user.id, action: "staff.login", targetType: "admin_user", targetId: s.user.id }); return { token: s.token, user: { id: s.user.id, name: s.user.name, email: s.user.email, roles: JSON.parse(s.user.roles), mustChangePassword: !!s.user.must_change_password } }; }
    throw new HttpError(401, "INVALID_CREDENTIALS", "invalid credentials");
  });
  router.add("POST", "/api/login/mfa", { roles: "public", tag: "auth" }, async ({ body }) => { const b = await body(); const r = auth.verifyMfa({ userId: b.userId, code: b.code, remember: !!b.remember }); if (r?.token) return { token: r.token, user: { id: r.user.id, name: r.user.name, email: r.user.email, roles: JSON.parse(r.user.roles), mustChangePassword: !!r.user.must_change_password } }; throw new HttpError(401, "MFA_FAILED", r?.error || "MFA verification failed"); });
  router.add("POST", "/api/logout", { roles: "any", allowPasswordChange: true, tag: "auth" }, ({ req }) => { auth.revoke((req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return { ok: true }; });
  router.add("GET", "/api/winners/public", { roles: "public", tag: "public", query: { campaign: "campaign id (default: current)", period: "period code" } }, ({ url }) => { const cid = url.searchParams.get("campaign") || db.prepare(`select id from campaigns where status in ('active','paused','closed') order by created_at desc limit 1`).get()?.id; return { campaign: cid, periods: cid ? winners.publishedPeriods(cid) : [], winners: cid ? winners.listPublic(cid, url.searchParams.get("period") || null) : [] }; });
  router.add("GET", "/api/openapi.json", { roles: "public", tag: "public" }, () => openapi(router.routes));
  // Conversation simulator (non-production only): staff-authenticated inbound; same intake, conversation, pipeline and outbox as WhatsApp.
  router.add("POST", "/api/simulator/inbound", { roles: ["support", "campaign_manager", "reviewer", "platform_admin"], tag: "simulator", bodyLimit: 12 * 1024 * 1024 }, async ({ body, user }) => {
    if (environment === "production") throw E.forbidden("simulator is disabled in production");
    const b = await body(); if (!b.phone) throw E.badRequest("phone required");
    const ev = { provider: "simulator", providerMessageId: b.provider_message_id || `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, phoneUid: b.phone, type: b.image_b64 ? "message.image" : b.type || "message.text", text: b.text || "", inlineMediaB64: b.image_b64 || null, mime: b.mime || null, timestamp: new Date().toISOString() };
    const r = intake.receive(ev);
    if (b.wait !== false) { await intake.drain({ max: 50 }); await worker.tick(); }
    const replies = r.id ? db.prepare(`select payload_json, status from outbound_messages where idempotency_key like ? order by created_at`).all(`conv:${r.id}:%`).map((m) => ({ text: JSON.parse(m.payload_json).body, status: m.status })) : [];
    const outcome = r.id ? db.prepare(`select result_json from channel_events where id=?`).get(r.id) : null;
    domain.metric("simulator.inbound", 1, { user: user.id });
    return { ...r, replies, result: outcome?.result_json ? JSON.parse(outcome.result_json) : null };
  });
  router.add("GET", "/api/simulator/transcript/:phone", { roles: ["support", "campaign_manager", "reviewer", "platform_admin"], tag: "simulator" }, ({ params }) => { const ph = domain.getParticipantByPhone(params.phone)?.wa_phone_uid || (params.phone.replace(/[^\d]/g, "")); const inbound = db.prepare(`select id, event_kind, payload_json, received_at from channel_events where wa_phone_uid=? order by received_at desc limit 60`).all(ph).map((e) => ({ dir: "in", kind: e.event_kind, text: JSON.parse(e.payload_json).text, at: e.received_at })); const outbound = db.prepare(`select purpose, status, payload_json, created_at from outbound_messages where wa_phone_uid=? order by created_at desc limit 60`).all(ph).map((o) => ({ dir: "out", purpose: o.purpose, status: o.status, text: JSON.parse(o.payload_json).body || "[template]", at: o.created_at })); return { phone: domain.maskPhone(ph), transcript: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)) }; });
  registerAdminRoutes(router, S);
  registerDeskRoutes(router, S);

  const CONSOLE_DIST = path.join(ROOT, "src", "web-console-dist");
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    try {
      res.setHeader("x-frame-options", "DENY"); res.setHeader("referrer-policy", "no-referrer");
      // ---- provider webhook: durable intake THEN ack --------------------------------
      if (p === "/webhooks/whatsapp" && req.method === "GET") { const hs = transport.verifyHandshake ? transport.verifyHandshake(url.searchParams) : null; if (hs) { res.writeHead(hs.status, { "content-type": "text/plain" }); return res.end(hs.body); } return send(res, 403, { error: { code: "FORBIDDEN", message: "verification failed" } }); }
      if (p === "/webhooks/whatsapp" && req.method === "POST") {
        const raw = await readBody(req, 4 * 1024 * 1024);
        if (transport instanceof CloudApiTransport && !transport.validateSignature(req.headers, raw)) { domain.metric("webhook.bad_signature"); return send(res, 403, { error: { code: "BAD_SIGNATURE", message: "invalid signature" } }); }
        if (!(transport instanceof CloudApiTransport) && environment === "production") return send(res, 403, { error: { code: "FORBIDDEN", message: "simulated webhooks are disabled in production" } });
        let payload; try { payload = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: { code: "VALIDATION", message: "bad payload" } }); }
        const events = transport.parseInbound ? transport.parseInbound(payload) : (payload.events || []).map((e) => ({ ...e, provider: "simulator", inlineMediaB64: payload.media?.[e.providerMessageId] || null }));
        let accepted = 0, deduped = 0;
        try { for (const ev of events) { const r = intake.receive(ev); if (r.accepted) accepted++; else deduped++; } }
        catch (e) { log.error?.("[webhook] persist failed", e.message); return send(res, 503, { error: { code: "INTAKE_UNAVAILABLE", message: "could not persist event; retry" } }); }
        return send(res, 200, { received: events.length, accepted, deduped });
      }
      if (p === "/health/live") return send(res, 200, { ok: true });
      if (p === "/health/ready") { try { db.prepare(`select 1`).get(); const xh = await extractor.health(); return send(res, xh.ok ? 200 : 503, { ok: xh.ok, db: true, extractor: xh, transport: transport.health?.(), worker: worker.health() }); } catch { return send(res, 503, { ok: false }); } }
      // ---- console static ------------------------------------------------------------
      if (fs.existsSync(path.join(CONSOLE_DIST, "index.html"))) {
        if (p === "/" || p === "/admin") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" }); return res.end(fs.readFileSync(path.join(CONSOLE_DIST, "index.html"))); }
        const rel = p.replace(/^\//, ""); const file = path.join(CONSOLE_DIST, rel);
        if (rel && !rel.includes("..") && file.startsWith(CONSOLE_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "public, max-age=3600" }); return res.end(fs.readFileSync(file)); }
      }
      if (await router.dispatch(req, res)) return;
      return send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
    } catch (e) {
      log.error?.("[http]", e.message);
      if (!res.writableEnded) send(res, e.status || 500, { error: { code: e.code || "INTERNAL", message: e.status ? e.message : "internal error" } });
    }
  });
  void readJson;

  return {
    server, transport, db, domain, outbox, pipeline, conversation, drawService, crm, auth, intake, worker, winners, extractor, mediaStore, cfg, environment, router,
    listen() { return new Promise((r) => server.listen(cfg.port, cfg.host, () => { (log?.log || console.log)(`[server] listening on ${cfg.host}:${cfg.port} env=${environment} transport=${cfg.whatsappTransport} extractor=${extractor.name}`); r(server); })); },
    async close() { worker.stop(); await extractor.close?.(); return new Promise((r) => server.close(r)); },
  };
}
