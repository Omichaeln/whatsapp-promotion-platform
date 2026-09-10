// Local CRM contract-test receiver (spec §16: "build a functioning contract-test
// receiver and mark the actual vendor connection unresolved"). Implements the
// webhook adapter contract: POST /events (upsert by external_key, rejects older
// versions with 409), GET /records/:type/:key (authoritative read-back),
// GET /health. Fault injection for T-27 via env:
//   CRM_RECEIVER_FAULT=timeout-after-write   accept + store, then never respond
//   CRM_RECEIVER_FAULT=down                  respond 503
//   CRM_RECEIVER_FAULT=none (default)
// Usage: CRM_RECEIVER_PORT=5197 node scripts/crm-receiver.mjs
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.CRM_RECEIVER_PORT || 5197);
const token = process.env.CRM_RECEIVER_TOKEN || "";
const stateFile = process.env.CRM_RECEIVER_STATE || "";
let fault = process.env.CRM_RECEIVER_FAULT || "none";
const store = new Map(); // `${type}:${key}` -> record
if (stateFile && fs.existsSync(stateFile)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(stateFile, "utf8")))) store.set(k, v);
const persist = () => { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(store))); };
const send = (res, s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (token && (req.headers.authorization || "") !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && url.pathname === "/fault") { const b = await body(req); fault = b.mode || "none"; return send(res, 200, { fault }); }
  if (url.pathname === "/health") return send(res, fault === "down" ? 503 : 200, { ok: fault !== "down", fault, records: store.size });
  if (fault === "down") return send(res, 503, { error: "down" });
  if (req.method === "POST" && url.pathname === "/events") {
    const ev = await body(req);
    if (!ev.entity_type || !ev.external_key || ev.entity_version == null) return send(res, 400, { error: "entity_type, external_key, entity_version required" });
    const k = `${ev.entity_type}:${ev.external_key}`;
    const cur = store.get(k);
    if (cur && Number(cur.entity_version) > Number(ev.entity_version)) return send(res, 409, { error: "older version", current: cur.entity_version });
    const rec = { id: cur?.id || `crm_${Math.random().toString(36).slice(2, 10)}`, entity_type: ev.entity_type, external_key: ev.external_key, entity_version: Number(ev.entity_version), mapping_version: ev.mapping_version, ...ev.record, updated_at: new Date().toISOString() };
    store.set(k, rec); persist();
    if (fault === "timeout-after-write") return; // never respond: client sees a timeout, record exists
    return send(res, 200, { id: rec.id, external_key: rec.external_key, entity_version: rec.entity_version });
  }
  const m = url.pathname.match(/^\/records\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && m) { const rec = store.get(`${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`); return rec ? send(res, 200, rec) : send(res, 404, { error: "not found" }); }
  if (req.method === "GET" && url.pathname === "/records") return send(res, 200, { records: [...store.values()] });
  send(res, 404, { error: "not found" });
});
function body(req) { return new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); }); }

if (process.argv[1] && process.argv[1].endsWith("crm-receiver.mjs")) {
  server.listen(port, "127.0.0.1", () => console.log(`[crm-receiver] listening on http://127.0.0.1:${port} fault=${fault}`));
}
