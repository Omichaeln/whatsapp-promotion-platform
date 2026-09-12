// HTTP surface fixes: credential throttling that cannot be spoofed, an
// authenticated provider webhook outside developer environments, honest status
// codes for operator mistakes, and response headers/contract accuracy.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { SimulatorTransport } from "../src/transport/simulator.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const silent = { log() {}, error() {}, warn() {} };
// A production-shaped configuration (validateConfig enforces cloud-api + keys);
// the transport is overridden with the simulator, which is exactly the case the
// production gate must refuse.
const PROD_ENV = { HOST: "127.0.0.1", ADMIN_EMAIL: "admin@x.test", ADMIN_PASSWORD: "TestAdminPassword123", IDENTITY_KEY: "test-identity-key-0123456789", AUDIT_CHECKPOINT_KEY: "test-checkpoint-key", WHATSAPP_TRANSPORT: "cloud-api", RECEIPT_EXTRACTOR: "tesseract", PUBLIC_BASE_URL: "https://example.test", META_ACCESS_TOKEN: "tok", META_APP_SECRET: "sec", WHATSAPP_WEBHOOK_TOKEN: "verify-me" };
const stubExtractor = { name: "stub", async health() { return { ok: true, mode: "real", provider: "stub" }; }, async extract() { throw new Error("not used"); }, async close() {} };

describe("http surface: throttling, webhook authentication, status codes, headers", () => {
  let h, admin, reviewer;
  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    admin = await h.login("admin@x.test", "TestAdminPassword123");
    reviewer = await h.staffToken("reviewer@example.test");
  });
  after(async () => { await h.close(); });

  it("the login throttle cannot be shaken off by rotating X-Forwarded-For", async () => {
    // The limiter keyed on the first element of a header the caller writes, so
    // `X-Forwarded-For: 10.0.0.<n>` minted a fresh bucket per request: twelve
    // consecutive bad passwords produced twelve 401s and never a 429.
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const r = await h.api("/api/login", { method: "POST", headers: { "x-forwarded-for": `10.0.0.${i}` }, body: { email: "brute@x.test", password: "wrong-wrong-wrong" } });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `a rotating X-Forwarded-For must not evade the throttle (got ${codes.join(",")})`);
    const last = await h.api("/api/login", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" }, body: { email: "brute@x.test", password: "wrong-wrong-wrong" } });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get("retry-after"), "a throttled caller is told when to come back");
    // and the brake is per account: another staff login from the same source is unaffected
    assert.ok(await h.login("admin@x.test", "TestAdminPassword123"), "throttling one account must not lock out the rest");
  });

  it("MFA verification is throttled, so the second factor cannot be brute-forced", async () => {
    // 60 wrong codes used to return 60 x 401 with the challenge still open;
    // 3 of 10^6 codes are live at any instant, so unlimited guessing wins.
    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await h.api("/api/login/mfa", { method: "POST", body: { userId: "adm_no_such_user", code: String(100000 + i) } });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `repeated MFA guesses must be throttled (got ${codes.join(",")})`);
  });

  it("paged endpoints answer 400 for a non-integer limit/offset instead of 500", async () => {
    // Number("abc") reached node:sqlite as NaN ("datatype mismatch"), so a bad
    // bookmark looked like a platform outage and logged a stack trace.
    for (const p of ["/api/entries?limit=abc", "/api/participants?offset=x", "/api/receipts?limit=all", "/api/entries?limit=-5"]) {
      const r = await h.api(p, { token: admin });
      assert.equal(r.status, 400, `${p} must be a client error`);
      assert.equal(r.data.error.code, "VALIDATION");
    }
    assert.equal((await h.api("/api/entries?limit=5&offset=0", { token: admin })).status, 200, "well-formed pagination still works");
  });

  it("a malformed path parameter is a 400 in the documented envelope, not a bare 500", async () => {
    // decodeURIComponent ran outside the try that builds the error envelope, so
    // an unauthenticated GET /api/receipts/% produced 500 INTERNAL with no
    // correlationId in the body and no access-log line.
    for (const p of ["/api/receipts/%", "/api/entries/%E0%A4%A"]) {
      const r = await h.api(p);
      assert.equal(r.status, 400, `${p} must be a client error`);
      assert.equal(r.data.error.code, "VALIDATION");
      assert.ok(r.data.error.correlationId, "the envelope carries the correlation id");
    }
  });

  it("an error escaping before the router still answers in the documented envelope", async () => {
    // The pre-router fallback echoed whatever `e.code` the failure carried (e.g.
    // Node's ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH) and dropped the correlation
    // id, so a reported 500 could not be tied to a log line.
    const r = await h.api("/webhooks/whatsapp", { method: "POST", body: { events: "not-an-array" }, raw: true });
    const body = await r.json();
    assert.equal(r.status, 500);
    assert.equal(body.error.code, "INTERNAL");
    assert.equal(body.error.message, "internal error");
    assert.ok(body.error.correlationId, "the envelope carries the correlation id");
    assert.equal(body.error.correlationId, r.headers.get("x-correlation-id"));
  });

  it("ordinary operator mistakes are 400/404, not 500 INTERNAL with the reason suppressed", async () => {
    const cid = h.campaign.id;
    const cases = [
      ["POST", `/api/campaigns/${cid}/status`, { status: "nonsense" }, 400],
      ["POST", `/api/campaigns/${cid}/periods`, {}, 400],
      ["POST", `/api/campaigns/${cid}/periods`, { code: "WX", starts_at: "2025-03-10T00:00:00Z", ends_at: "2025-03-01T00:00:00Z" }, 400],
      ["POST", `/api/campaigns/${cid}/versions/nope/activate`, {}, 404],
      ["PATCH", `/api/campaigns/${cid}/versions/nope`, { content: {} }, 404],
      ["POST", "/api/products", {}, 400],
      ["POST", "/api/entries/ent_nope/disqualify", { reason: "x" }, 404],
    ];
    for (const [method, p, body, want] of cases) {
      const r = await h.api(p, { method, token: admin, body });
      assert.equal(r.status, want, `${method} ${p} -> ${r.status} ${JSON.stringify(r.data)}`);
      assert.notEqual(r.data.error.message, "internal error", `${method} ${p} must say what was wrong`);
    }
  });

  it("CSV exports carry the same no-store/nosniff baseline as every other response", async () => {
    // These two routes write the response themselves and so bypassed send();
    // the participant export is the last response that should be cacheable.
    for (const p of ["/api/reports/export?scope=participants&format=csv", "/api/outlets/export.csv"]) {
      const r = await h.api(p, { token: await h.staffToken("auditor@example.test"), raw: true });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type") || "", /text\/csv/);
      assert.equal(r.headers.get("cache-control"), "no-store", `${p} must not be cached`);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", `${p} must not be sniffed`);
    }
  });

  it("GET /api/readiness no longer hands the staff roster to every signed-in role", async () => {
    // GET /api/users refuses this to everyone but platform_admin, yet readiness
    // named every account with its roles, MFA state and temporary-password flag.
    const rv = await h.api("/api/readiness", { token: reviewer });
    assert.equal(rv.status, 200);
    assert.deepEqual(rv.data.staff, [], "a reviewer sees no named accounts");
    assert.ok(rv.data.staff_counts.total > 0, "the aggregate the console needs is still there");
    assert.equal(rv.data.activation, null, "activation detail follows the campaign activation gate");
    const pa = await h.api("/api/readiness", { token: admin });
    assert.ok(pa.data.staff.length > 0, "platform_admin still gets the roster");
    if (pa.data.campaign) assert.ok(pa.data.activation, "and the activation detail");
  });

  it("a platform_admin cannot grant itself draw authority, and one account cannot hold both draw roles", async () => {
    // The only four-eyes control on a draw is operator_id !== approver_id, so a
    // self-grant of draw_officer + draw_approver defeats it outright.
    const me = (await h.api("/api/whoami", { token: admin })).data;
    const self = await h.api(`/api/users/${me.id}`, { method: "PATCH", token: admin, body: { roles: ["platform_admin", "draw_officer", "draw_approver"] } });
    assert.equal(self.status, 400, "self role changes are refused");
    assert.deepEqual((await h.api("/api/whoami", { token: admin })).data.roles, me.roles, "roles are unchanged");
    const both = await h.api("/api/users", { method: "POST", token: admin, body: { email: "phantom@example.test", roles: ["draw_officer", "draw_approver"] } });
    assert.equal(both.status, 400, "one account may not hold both sides of the draw control");
    const u = h.app.auth.listUsers().find((x) => x.email === "reviewer@example.test");
    assert.equal((await h.api(`/api/users/${u.id}`, { method: "PATCH", token: admin, body: { roles: ["draw_officer", "draw_approver"] } })).status, 400);
    assert.equal((await h.api(`/api/users/${u.id}`, { method: "PATCH", token: admin, body: { roles: ["reviewer"] } })).status, 200, "an ordinary role change by someone else still works");
  });

  it("readiness reports a stopped worker as not ready", async () => {
    // /health/ready was decided by the extractor alone, so a stopped or wedged
    // worker — no intake, no OCR, no outbound, no CRM drain — still said 200.
    const stopped = await h.api("/health/ready", { raw: true });
    assert.equal(stopped.status, 503, "a stopped worker is not ready");
    assert.equal((await stopped.json()).worker.ok, false);
    h.app.worker.start();
    try {
      const running = await h.api("/health/ready", { raw: true });
      assert.equal(running.status, 200, "a running worker is ready");
    } finally { h.app.worker.stop(); }
  });

  it("the generated contract describes the webhook, the health probes and the non-JSON routes", async () => {
    const doc = (await h.api("/api/openapi.json")).data;
    for (const p of ["/webhooks/whatsapp", "/health/live", "/health/ready"]) assert.ok(doc.paths[p], `${p} is part of the documented contract`);
    assert.ok(doc.paths["/webhooks/whatsapp"].post, "the inbound webhook is described");
    assert.ok(doc.paths["/api/outlets/export.csv"].get.responses[200].content["text/csv"], "a CSV route is not described as JSON");
    assert.ok(doc.paths["/api/media/{id}"].get.responses[200].content["image/png"], "the media route returns image bytes");
    assert.ok(doc.paths["/api/login"].post.responses[429], "the throttled route models 429");
    assert.ok(doc.paths["/api/login"].post.responses[413] && doc.paths["/api/login"].post.responses[500], "body caps and faults are modelled");
  });
});

describe("provider webhook authentication", () => {
  let staging;
  const TOKEN = "webhook-shared-secret-123";
  before(async () => { staging = await buildApp({ extractor: "simulator", env: { ENVIRONMENT: "staging", WHATSAPP_WEBHOOK_TOKEN: TOKEN } }); });
  after(async () => { await staging.close(); });

  const event = (id) => ({ events: [{ providerMessageId: id, phoneUid: "263779999001", type: "message.text", text: "hi" }] });
  const post = (app, body, headers = {}) => fetch(`${app.base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("the unsigned webhook demands the shared secret outside developer environments", async () => {
    // On the documented Railway deployment (staging + simulator transport)
    // anyone who knew the URL could inject inbound events as any phone number:
    // register participants, submit receipts, forge delivery statuses.
    const before = staging.db.prepare(`select count(*) n from channel_events`).get().n;
    assert.equal((await post(staging, event("atk_1"))).status, 403, "no token: refused");
    assert.equal((await post(staging, event("atk_2"), { "x-webhook-token": "wrong" })).status, 403, "wrong token: refused");
    assert.equal((await post(staging, event("atk_3"), { "x-webhook-token": TOKEN + "x" })).status, 403, "a longer token is refused, not truncated");
    assert.equal(staging.db.prepare(`select count(*) n from channel_events`).get().n, before, "nothing was persisted");
    const ok = await post(staging, event("legit_1"), { "x-webhook-token": TOKEN });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: 1, accepted: 1, deduped: 0 });
  });

  it("local/test harnesses keep their open webhook", async () => {
    const local = await buildApp({ extractor: "simulator" });
    try {
      const r = await post(local, event("bench_1"));
      assert.equal(r.status, 200, "the load harness posts unauthenticated simulator events in a test environment");
    } finally { await local.close(); }
  });

  it("a process configured for production refuses the simulator webhook even when the database says staging", async () => {
    // The gate read only the value recorded in the database on first boot, so a
    // service promoted onto a volume initialised as staging kept the simulator
    // webhook and transcript dump open against live data with a log line.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-envdrift-"));
    const base = { ...PROD_ENV, DATABASE: path.join(dir, "t.db"), MEDIA_DIR: path.join(dir, "media"), PORT: "6213" };
    const first = await createServer({ config: loadConfig({ ...base, ENVIRONMENT: "staging" }), log: silent, transport: new SimulatorTransport(), extractor: stubExtractor });
    await first.close();
    const app = await createServer({ config: loadConfig({ ...base, ENVIRONMENT: "production" }), log: silent, transport: new SimulatorTransport(), extractor: stubExtractor });
    await app.listen();
    try {
      assert.equal(app.environment, "staging", "the database still records staging");
      const r = await fetch(`http://127.0.0.1:6213/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event("prod_1")) });
      assert.equal(r.status, 403, "the production gate fails closed");
      assert.equal((await r.json()).error.message, "simulated webhooks are disabled in production");
      assert.equal(app.db.prepare(`select count(*) n from channel_events`).get().n, 0);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("simulator transcript", () => {
  it("the transcript dump is refused in production like its inbound twin", async () => {
    // The route is documented as non-production only and returns the raw
    // registration turn (national ID included) for any phone number.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-prodsim-"));
    const cfg = loadConfig({ ...PROD_ENV, DATABASE: path.join(dir, "t.db"), MEDIA_DIR: path.join(dir, "media"), PORT: "6214", ENVIRONMENT: "production" });
    const app = await createServer({ config: cfg, log: silent, transport: new SimulatorTransport(), extractor: stubExtractor });
    await app.listen();
    try {
      const login = await fetch("http://127.0.0.1:6214/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@x.test", password: "TestAdminPassword123" }) }).then((r) => r.json());
      const r = await fetch("http://127.0.0.1:6214/api/simulator/transcript/263771000999", { headers: { authorization: `Bearer ${login.token}` } });
      assert.equal(r.status, 403);
      assert.equal((await r.json()).error.message, "simulator is disabled in production");
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
