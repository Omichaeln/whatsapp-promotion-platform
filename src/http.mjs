import crypto from "node:crypto";

/**
 * Minimal HTTP router (spec §17): path params, role guards, JSON bodies with
 * limits, stable error envelopes { error: { code, message, correlationId } },
 * cursor/offset pagination helpers, and a route table that feeds the OpenAPI
 * document. Unknown fields in request bodies are ignored unless a route
 * declares `strict`.
 */
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const E = {
  badRequest: (m, x) => new HttpError(400, "VALIDATION", m, x),
  unauthorized: () => new HttpError(401, "UNAUTHORIZED", "authentication required"),
  forbidden: (m = "forbidden") => new HttpError(403, "FORBIDDEN", m),
  notFound: (m = "not found") => new HttpError(404, "NOT_FOUND", m),
  conflict: (m, x) => new HttpError(409, "CONFLICT", m, x),
  tooMany: (retryAfter) => new HttpError(429, "RATE_LIMITED", "too many requests", { retryAfter }),
};
const DOMAIN_CODES = { CONFLICT: 409, NOT_FOUND: 404, VALIDATION: 400, SOD: 403, BLOCKED: 409, INTEGRITY: 409, APPROVAL_REQUIRED: 403, IDENTITY_INCOMPLETE: 409, BAD_DECISION: 400, ALREADY_CREDITED: 409 };

export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
export async function readJson(req, limit) { const b = await readBody(req, limit); if (!b.length) return {}; try { return JSON.parse(b.toString("utf8")); } catch { throw E.badRequest("invalid JSON body"); } }
export function send(res, status, obj, headers = {}) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers }); res.end(JSON.stringify(obj)); }
export function page(url, { max = 200, def = 50 } = {}) { const limit = Math.min(max, Math.max(1, Number(url.searchParams.get("limit") || def))); const offset = Math.max(0, Number(url.searchParams.get("offset") || 0)); return { limit, offset, next: (rows) => (rows.length === limit ? offset + limit : null) }; }
export const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max));

export function createRouter({ auth, log = console }) {
  const routes = [];
  /** add(method, path, { roles: [...]|"public", summary, body, query }, handler(ctx)) */
  function add(method, pathPattern, meta, handler) {
    const keys = [];
    const re = new RegExp("^" + pathPattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    // Authorization is deny-by-default: a route must state its roles. The
    // previous default was "public", so a new route that simply forgot the
    // option was served unauthenticated — a fail-open default in the one place
    // that must fail closed.
    if (meta.roles === undefined) throw new Error(`route ${method} ${pathPattern} must declare roles (use "public" deliberately)`);
    if (meta.roles !== "public" && meta.roles !== "any" && !(Array.isArray(meta.roles) && meta.roles.length)) {
      throw new Error(`route ${method} ${pathPattern} has an empty roles list; use "any" for every signed-in user`);
    }
    routes.push({ method, pathPattern, re, keys, meta: { ...meta }, handler });
  }
  async function dispatch(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const correlationId = String(req.headers["x-correlation-id"] || "").slice(0, 64) || `req_${crypto.randomBytes(8).toString("hex")}`;
    res.setHeader("x-correlation-id", correlationId);
    const t0 = Date.now();
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) return false;
    const params = {}; const m = url.pathname.match(match.re); match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    let user = null;
    try {
      if (match.meta.roles !== "public") {
        const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || (match.meta.allowTokenQuery ? url.searchParams.get("token") || "" : "");
        const session = auth.authenticate(bearer);
        if (!session) throw E.unauthorized();
        user = session.user;
        if (match.meta.roles !== "any" && !auth.hasRole(user, ...match.meta.roles)) throw E.forbidden(`requires one of: ${match.meta.roles.join(", ")}`);
        if (user.must_change_password && !match.meta.allowPasswordChange) throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "change your temporary password first");
      }
      const out = await match.handler({ req, res, url, params, user, correlationId, body: () => readJson(req, match.meta.bodyLimit), raw: () => readBody(req, match.meta.bodyLimit) });
      if (out !== undefined && !res.writableEnded) send(res, out?.__status || 200, out?.__status ? out.body : out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (DOMAIN_CODES[e.code] || 500);
      const code = e instanceof HttpError ? e.code : (e.code && DOMAIN_CODES[e.code] ? e.code : status === 500 ? "INTERNAL" : "ERROR");
      if (status >= 500) log.error?.("[http]", req.method, url.pathname, correlationId, e.stack || e.message);
      if (!res.writableEnded) send(res, status, { error: { code, message: status >= 500 ? "internal error" : e.message, correlationId, ...(e.extra || {}), ...(e.blockers ? { blockers: e.blockers } : {}) } }, status === 429 && e.extra?.retryAfter ? { "retry-after": String(e.extra.retryAfter) } : {});
    } finally {
      log.info?.(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: url.pathname, s: res.statusCode, ms: Date.now() - t0, cid: correlationId, u: user?.id || null }));
    }
    return true;
  }
  return { add, dispatch, routes };
}

/** OpenAPI 3.0 document from the route table (schemas are descriptive; see docs/api). */
export function openapi(routes, { title = "WhatsApp Promotion Platform API", version = "2.0.0" } = {}) {
  const paths = {};
  for (const r of routes) {
    const p = r.pathPattern.replace(/:([a-zA-Z_]+)/g, "{$1}");
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.meta.summary || "", tags: [r.meta.tag || "default"],
      security: r.meta.roles === "public" ? [] : [{ bearer: [] }],
      "x-roles": r.meta.roles, parameters: [...r.keys.map((k) => ({ name: k, in: "path", required: true, schema: { type: "string" } })), ...Object.entries(r.meta.query || {}).map(([k, d]) => ({ name: k, in: "query", schema: { type: "string" }, description: d }))],
      ...(r.meta.body ? { requestBody: { content: { "application/json": { schema: r.meta.body } } } } : {}),
      responses: { 200: { description: "OK" }, 400: { $ref: "#/components/responses/Error" }, 401: { $ref: "#/components/responses/Error" }, 403: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" }, 409: { $ref: "#/components/responses/Error" } },
    };
  }
  return { openapi: "3.0.3", info: { title, version, description: "Errors: { error: { code, message, correlationId } }. Pagination: ?limit&offset. Unknown body fields ignored. Idempotency: webhook events by provider message id; outbound by idempotency key; approval replay idempotent." }, components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, responses: { Error: { description: "Error envelope", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, correlationId: { type: "string" } } } } } } } } } }, paths };
}
