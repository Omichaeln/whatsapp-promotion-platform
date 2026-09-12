import http from "node:http";
import crypto from "node:crypto";
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
 * Bounded sliding-window attempt counter for the credential endpoints.
 *
 * Exported (and clock-injectable) so the bound itself is testable: the previous
 * inline version only deleted keys whose window had already drained, and ran
 * that O(n) scan on EVERY hit once over the cap. Inside one 60s window nothing
 * is expirable and the email is part of the key, so a rotating-email flood both
 * grew the map far past the cap (30k logins -> 60k entries) and re-scanned the
 * whole map twice per request (1.7bn entry visits, 33s of CPU) — a new cost
 * under exactly the attack the bound exists to absorb.
 *
 * `hit` reports one attempt against two thresholds so a caller can keep a tight
 * soft brake while still bounding expensive work with a higher hard ceiling.
 */
export function createAttemptThrottle({ windowMs = 60_000, maxKeys = 10_000, now = Date.now } = {}) {
  const attempts = new Map();
  const lowWater = Math.max(1, Math.floor(maxKeys * 0.8));
  const sweep = (t) => {
    if (attempts.size <= maxKeys) return;
    for (const [k, v] of attempts) if (t - (v[v.length - 1] || 0) >= windowMs) attempts.delete(k);
    // Expiry alone cannot bound a flood of fresh keys (inside one window nothing
    // is expirable), so evict the least-recently-touched ones: a key under
    // active attack has the newest touch and survives, which is the one that
    // must keep counting. Always down to the low-water mark, never merely to the
    // cap — trimming one key per insertion would put this scan on every request,
    // which is the quadratic path the previous bound had.
    if (attempts.size > lowWater) {
      const byAge = [...attempts].sort((a, b) => (a[1][a[1].length - 1] || 0) - (b[1][b[1].length - 1] || 0));
      for (let i = 0, drop = byAge.length - lowWater; i < drop; i++) attempts.delete(byAge[i][0]);
    }
  };
  return {
    /** Record one attempt on `key`; returns retry-after seconds for each threshold (0 = under it). */
    hit(key, soft, hard = soft) {
      const t = now();
      sweep(t);
      const arr = (attempts.get(key) || []).filter((x) => t - x < windowMs);
      const n = arr.length;                       // attempts already inside the window
      if (n < hard) arr.push(t);                  // stop accumulating at the ceiling: one key's array is bounded too
      attempts.set(key, arr);
      const after = (limit) => (n >= limit ? Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000)) : 0);
      return { soft: after(soft), hard: after(hard) };
    },
    forget(...keys) { for (const k of keys) attempts.delete(k); },
    size: () => attempts.size,
  };
}

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
  if (environment !== cfg.environment) {
    // Every production gate reads the recorded value. Booting a production
    // database while the process believes it is staging enables the simulator,
    // sample seeding and dev keys against live data, so refuse rather than warn.
    if (environment === "production") {
      throw new Error(`this database is recorded as production but ENVIRONMENT=${cfg.environment}; refusing to start. Set ENVIRONMENT=production, or point at a different database.`);
    }
    log.warn?.(`[server] database environment is "${environment}" but ENVIRONMENT=${cfg.environment}; the database value governs`);
  }
  // Production gates fail closed. A process configured for production running on
  // a volume first initialised as staging kept `environment='staging'` for ever,
  // which left the simulator webhook and the transcript dump open against live
  // data with only a log line.
  const isProduction = environment === "production" || cfg.environment === "production";
  // The unsigned (simulator / linked-device) webhook used to be open to the
  // internet in every environment below production: anyone who knew the URL
  // could inject inbound events as any phone number and forge delivery
  // statuses. Developer environments stay open so the local harnesses keep
  // working; anywhere else the caller must present the shared secret.
  const unsignedWebhookOpen = ["local", "test"].includes(environment) && ["local", "test"].includes(cfg.environment);
  const webhookTokenOk = (headers) => {
    const got = Buffer.from(String(headers["x-webhook-token"] || ""), "utf8");
    const want = Buffer.from(String(cfg.webhookToken || ""), "utf8");
    return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
  };

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
  const WORKER_STALE_MS = 5 * 60_000;   // a tick can legitimately run long (OCR); beyond this the worker is wedged
  const mediaSecret = sha256hex("media:" + (cfg.webhookToken || cfg.identityKey || "dev"));

  // ---- credential rate limiting (sliding window) --------------------------------
  // The limiter used to key on the first element of X-Forwarded-For, which the
  // caller writes: `X-Forwarded-For: 10.0.0.<n>` minted a fresh bucket on every
  // request, so the 5-per-minute brake never fired and each forged value left a
  // permanent Map entry. The connection's own address cannot be forged; a
  // forwarded hop is trusted only as far as the operator declares
  // (TRUSTED_PROXY_HOPS, counted from the right — the element the closest
  // trusted proxy appended — and none by default).
  const TRUSTED_PROXY_HOPS = Math.max(0, Math.trunc(Number(process.env.TRUSTED_PROXY_HOPS) || 0));
  const clientIp = (req) => {
    const socket = req.socket?.remoteAddress || "unknown";
    if (!TRUSTED_PROXY_HOPS) return socket;
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    return hops.length >= TRUSTED_PROXY_HOPS ? hops[hops.length - TRUSTED_PROXY_HOPS] : socket;
  };
  const RATE_WINDOW_MS = 60_000, RATE_MAX = 5, ATTEMPT_KEYS_MAX = 10_000;
  const throttle = createAttemptThrottle({ windowMs: RATE_WINDOW_MS, maxKeys: ATTEMPT_KEYS_MAX });
  const hit = (key, max) => throttle.hit(key, max).soft;
  const forget = (...keys) => throttle.forget(...keys);
  const acct = (v) => String(v || "").toLowerCase().trim().slice(0, 120);
  // Two brakes: source+account (the source can no longer be spoofed) and account
  // alone, so credential stuffing against one login from many addresses is
  // throttled as well. Each is read at two thresholds:
  //   soft — a WRONG password answers 429 instead of 401;
  //   hard — a ceiling on how much scrypt (~40ms of blocked event loop per
  //          verification) one key can buy; beyond it nothing is verified.
  // Only the soft brake used to exist, and it was checked *before* auth.login:
  // behind a proxy every caller shares one source address, so five wrong
  // passwords a minute against a known staff email held the real account holder
  // out of the console for as long as the attacker cared to keep it up. A
  // correct credential is now still verified between the two thresholds and
  // clears both brakes; the account ceiling stays well above the per-source one
  // so a single flooding source cannot spend the account's whole budget.
  const LOGIN_LIMITS = { source: { soft: RATE_MAX, hard: 20 }, account: { soft: RATE_MAX * 2, hard: 60 } };
  const loginKeys = (req, email) => [`login:${clientIp(req)}|${acct(email)}`, `login:acct:${acct(email)}`];
  const loginGate = (req, email) => {
    const keys = loginKeys(req, email);
    const src = throttle.hit(keys[0], LOGIN_LIMITS.source.soft, LOGIN_LIMITS.source.hard);
    const ac = throttle.hit(keys[1], LOGIN_LIMITS.account.soft, LOGIN_LIMITS.account.hard);
    return { keys, hard: src.hard || ac.hard, soft: src.soft || ac.soft };
  };

  async function metricsPayload() {
    const receipts = db.prepare(`select status, count(*) n from receipts group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    const draws = db.prepare(`select status, count(*) n from draws group by status`).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    const th = transport.health?.() || {};
    return { campaigns: { active: db.prepare(`select count(*) n from campaigns where status='active'`).get().n }, receipts, entries: db.prepare(`select count(*) n from entries where status='active'`).get().n, draws, participants: db.prepare(`select count(*) n from participants`).get().n, review_open: db.prepare(`select count(*) n from review_tasks where state!='decided'`).get().n, threads: desk.threadStats(), messages: desk.countMessages(), usage: await usage.snapshot(), transport: { provider: th.provider || cfg.whatsappTransport, mode: th.mode, ready: !!th.ok, me: th.me, qr: th.qr, lastError: th.lastError }, outbound: outbox.stats(), crm: crm.reconcileView(), queues: intake.stats(), alerts_open: db.prepare(`select count(*) n from alerts where acknowledged_at is null`).get().n, activity: desk.recentActivity(12), db: { ok: true }, environment };
  }

  // ---- router -------------------------------------------------------------------------
  const router = createRouter({ auth, log: { error: log.error?.bind(log), info: cfg.logLevel === "debug" ? log.log?.bind(log) : null } });
  const S = { db, domain, auth, pipeline, drawService, winners, crm, outbox, intake, mediaStore, extractor, transport, conversation, cfg, worker, mediaSecret, desk, ai, usage, activity, metricsPayload };
  // The document must not advertise a check the server does not make: a missing
  // email or password answers 401 INVALID_CREDENTIALS deliberately (telling an
  // unauthenticated caller which half of the credential was malformed is a free
  // hint), so the fields are described but `required` — which dispatch never
  // enforces — is no longer published as if it were.
  router.add("POST", "/api/login", { roles: "public", tag: "auth", rateLimited: true, body: { type: "object", description: "email and password are expected; a missing, unknown or wrong value answers 401 INVALID_CREDENTIALS, never 400", properties: { email: { type: "string" }, password: { type: "string" }, remember: { type: "boolean" } } } }, async ({ req, body }) => {
    const b = await body();
    const gate = loginGate(req, b.email);
    // The hard ceiling stays ahead of auth.login: scrypt verification blocks the
    // event loop for ~40ms, so a guessing flood must not buy unbounded CPU.
    if (gate.hard) throw E.tooMany(gate.hard);
    // Between the two thresholds the credential is still checked, so the brake
    // throttles guessing without becoming a lockout an outsider can hold on a
    // named account for 5 requests a minute. A correct password clears it.
    const s = auth.login({ email: b.email, password: b.password, remember: !!b.remember });
    if (s?.pendingMfa) { forget(...gate.keys); return { pendingMfa: true, userId: s.userId, message: s.message }; }
    if (s) { forget(...gate.keys); domain.audit({ actorType: "admin", actorId: s.user.id, action: "staff.login", targetType: "admin_user", targetId: s.user.id }); return { token: s.token, user: { id: s.user.id, name: s.user.name, email: s.user.email, roles: JSON.parse(s.user.roles), mustChangePassword: !!s.user.must_change_password } }; }
    if (gate.soft) throw E.tooMany(gate.soft);
    throw new HttpError(401, "INVALID_CREDENTIALS", "invalid credentials");
  });
  router.add("POST", "/api/login/mfa", { roles: "public", tag: "auth", rateLimited: true }, async ({ req, body }) => {
    const b = await body(); const uid = acct(b.userId);
    // The second factor was brute-forceable once a password was known: nothing
    // throttled this route, and a wrong code neither consumed nor invalidated
    // the 5-minute challenge, so the ~3-in-10^6 chance per guess could be taken
    // as fast as the network allowed.
    const retry = hit(`mfa:${clientIp(req)}|${uid}`, RATE_MAX) || hit(`mfa:acct:${uid}`, RATE_MAX); if (retry) throw E.tooMany(retry);
    const r = auth.verifyMfa({ userId: b.userId, code: b.code, remember: !!b.remember });
    if (r?.token) { forget(`mfa:${clientIp(req)}|${uid}`, `mfa:acct:${uid}`); return { token: r.token, user: { id: r.user.id, name: r.user.name, email: r.user.email, roles: JSON.parse(r.user.roles), mustChangePassword: !!r.user.must_change_password } }; }
    throw new HttpError(401, "MFA_FAILED", r?.error || "MFA verification failed");
  });
  router.add("POST", "/api/logout", { roles: "any", allowPasswordChange: true, tag: "auth" }, ({ req }) => { auth.revoke((req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return { ok: true }; });
  router.add("GET", "/api/winners/public", { roles: "public", tag: "public", query: { campaign: "campaign id (default: current)", period: "period code" } }, ({ url }) => { const cid = url.searchParams.get("campaign") || db.prepare(`select id from campaigns where status in ('active','paused','closed') order by created_at desc limit 1`).get()?.id; return { campaign: cid, periods: cid ? winners.publishedPeriods(cid) : [], winners: cid ? winners.listPublic(cid, url.searchParams.get("period") || null) : [] }; });
  // Handled before the router (durable-then-ack intake and the deployment
  // probes), so the route table cannot describe them — yet docs/api.md names all
  // four as part of the live contract and a generated client could not call them.
  const OPENAPI_EXTRA = {
    "/webhooks/whatsapp": {
      get: { summary: "Provider verification handshake", tags: ["webhooks"], security: [], parameters: ["hub.mode", "hub.verify_token", "hub.challenge"].map((name) => ({ name, in: "query", schema: { type: "string" } })), responses: { 200: { description: "challenge echoed", content: { "text/plain": { schema: { type: "string" } } } }, 403: { $ref: "#/components/responses/Error" } } },
      post: { summary: "Inbound provider events (Cloud API signature; x-webhook-token for the simulator outside local/test)", tags: ["webhooks"], security: [], responses: { 200: { description: "accepted" }, 400: { $ref: "#/components/responses/Error" }, 403: { $ref: "#/components/responses/Error" }, 413: { $ref: "#/components/responses/Error" }, 503: { $ref: "#/components/responses/Error" } } },
    },
    "/health/live": { get: { summary: "Liveness probe", tags: ["health"], security: [], responses: { 200: { description: "alive" } } } },
    "/health/ready": { get: { summary: "Readiness: database, extractor and worker", tags: ["health"], security: [], responses: { 200: { description: "ready" }, 503: { description: "not ready" } } } },
  };
  router.add("GET", "/api/openapi.json", { roles: "public", tag: "public" }, () => openapi(router.routes, { extraPaths: OPENAPI_EXTRA }));
  // Conversation simulator (non-production only): staff-authenticated inbound; same intake, conversation, pipeline and outbox as WhatsApp.
  router.add("POST", "/api/simulator/inbound", { roles: ["support", "campaign_manager", "reviewer", "platform_admin"], tag: "simulator", bodyLimit: 12 * 1024 * 1024 }, async ({ body, user }) => {
    if (isProduction) throw E.forbidden("simulator is disabled in production");
    const b = await body(); if (!b.phone) throw E.badRequest("phone required");
    const ev = { provider: "simulator", providerMessageId: b.provider_message_id || `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, phoneUid: b.phone, type: b.image_b64 ? "message.image" : b.type || "message.text", text: b.text || "", inlineMediaB64: b.image_b64 || null, mime: b.mime || null, timestamp: new Date().toISOString() };
    const r = intake.receive(ev);
    if (b.wait !== false) { await intake.drain({ max: 50 }); await worker.tick(); }
    const replies = r.id ? db.prepare(`select payload_json, status from outbound_messages where idempotency_key like ? order by created_at`).all(`conv:${r.id}:%`).map((m) => ({ text: JSON.parse(m.payload_json).body, status: m.status })) : [];
    const outcome = r.id ? db.prepare(`select result_json from channel_events where id=?`).get(r.id) : null;
    domain.metric("simulator.inbound", 1, { user: user.id });
    return { ...r, replies, result: outcome?.result_json ? JSON.parse(outcome.result_json) : null };
  });
  router.add("GET", "/api/simulator/transcript/:phone", { roles: ["support", "campaign_manager", "reviewer", "platform_admin"], tag: "simulator" }, ({ params }) => {
    // The simulator is documented as non-production only and its inbound twin
    // refuses in production, but this route did not: on a production database
    // it dumped any phone number's registration turn, national ID included.
    if (isProduction) throw E.forbidden("simulator is disabled in production");
    const ph = domain.getParticipantByPhone(params.phone)?.wa_phone_uid || (params.phone.replace(/[^\d]/g, "")); const inbound = db.prepare(`select id, event_kind, payload_json, received_at from channel_events where wa_phone_uid=? order by received_at desc limit 60`).all(ph).map((e) => ({ dir: "in", kind: e.event_kind, text: JSON.parse(e.payload_json).text, at: e.received_at })); const outbound = db.prepare(`select purpose, status, payload_json, created_at from outbound_messages where wa_phone_uid=? order by created_at desc limit 60`).all(ph).map((o) => ({ dir: "out", purpose: o.purpose, status: o.status, text: JSON.parse(o.payload_json).body || "[template]", at: o.created_at })); return { phone: domain.maskPhone(ph), transcript: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)) }; });
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
        if (!(transport instanceof CloudApiTransport) && isProduction) return send(res, 403, { error: { code: "FORBIDDEN", message: "simulated webhooks are disabled in production" } });
        if (!(transport instanceof CloudApiTransport) && !unsignedWebhookOpen && !webhookTokenOk(req.headers)) { domain.metric("webhook.unauthenticated"); return send(res, 403, { error: { code: "FORBIDDEN", message: "x-webhook-token required" } }); }
        let payload; try { payload = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: { code: "VALIDATION", message: "bad payload" } }); }
        const events = transport.parseInbound ? transport.parseInbound(payload) : (payload.events || []).map((e) => ({ ...e, provider: "simulator", inlineMediaB64: payload.media?.[e.providerMessageId] || null }));
        let accepted = 0, deduped = 0;
        try { for (const ev of events) { const r = intake.receive(ev); if (r.accepted) accepted++; else deduped++; } }
        catch (e) { log.error?.("[webhook] persist failed", e.message); return send(res, 503, { error: { code: "INTAKE_UNAVAILABLE", message: "could not persist event; retry" } }); }
        return send(res, 200, { received: events.length, accepted, deduped });
      }
      if (p === "/health/live") return send(res, 200, { ok: true });
      if (p === "/health/ready") {
        try {
          db.prepare(`select 1`).get(); const xh = await extractor.health(); const w = worker.health();
          // Readiness used to be decided by the extractor alone, so a stopped or
          // wedged worker — no inbound processing, no OCR, no outbound, no CRM
          // drain — still answered 200 and nothing ever surfaced it.
          const tickAgeMs = w.lastTick ? Date.now() - Date.parse(w.lastTick) : null;
          const workerOk = !!w.running && !(tickAgeMs !== null && tickAgeMs > WORKER_STALE_MS);
          const ok = !!xh.ok && workerOk;
          return send(res, ok ? 200 : 503, { ok, db: true, extractor: xh, transport: transport.health?.(), worker: { ...w, ok: workerOk, tick_age_ms: tickAgeMs } });
        } catch { return send(res, 503, { ok: false }); }
      }
      // ---- console static ------------------------------------------------------------
      if (fs.existsSync(path.join(CONSOLE_DIST, "index.html"))) {
        if (p === "/" || p === "/admin") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" }); return res.end(fs.readFileSync(path.join(CONSOLE_DIST, "index.html"))); }
        const rel = p.replace(/^\//, ""); const file = path.join(CONSOLE_DIST, rel);
        if (rel && !rel.includes("..") && file.startsWith(CONSOLE_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "public, max-age=3600" }); return res.end(fs.readFileSync(file)); }
      }
      if (await router.dispatch(req, res)) return;
      return send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
    } catch (e) {
      // Errors escaping before/outside the router answered with Node's own error
      // code (e.g. ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH from the verify-token
      // comparison) and no correlationId, so the envelope did not match the
      // documented shape and support could not tie a report to a log line.
      const status = e.status || 500;
      const correlationId = String(res.getHeader?.("x-correlation-id") || "") || `req_${crypto.randomBytes(8).toString("hex")}`;
      if (!res.headersSent) res.setHeader("x-correlation-id", correlationId);
      log.error?.("[http]", req.method, p, correlationId, e.stack || e.message);
      if (!res.writableEnded) send(res, status, { error: { code: status >= 500 ? "INTERNAL" : (e.code || "ERROR"), message: status >= 500 ? "internal error" : e.message, correlationId } });
    }
  });
  void readJson;

  return {
    server, transport, db, domain, outbox, pipeline, conversation, drawService, crm, auth, intake, worker, winners, extractor, mediaStore, cfg, environment, router,
    listen() { return new Promise((r) => server.listen(cfg.port, cfg.host, () => { (log?.log || console.log)(`[server] listening on ${cfg.host}:${cfg.port} env=${environment} transport=${cfg.whatsappTransport} extractor=${extractor.name}`); r(server); })); },
    async close() { worker.stop(); await extractor.close?.(); return new Promise((r) => server.close(r)); },
  };
}
