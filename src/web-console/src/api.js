// API client for the restored WhatsApp Desk console.
// Returns { ok, status, data }; persists the bearer token; triggers
// onUnauthorised on any 401.
const BASE = "";
const TOKEN_KEY = "wpp_token";

export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } }
export function apiUrl(path) { return BASE + path; }

let unauthCb = null;
export function onUnauthorised(cb) { unauthCb = cb; return () => { unauthCb = null; }; }

export async function api(path, { method = "GET", body, auth = true, timeout = 0 } = {}) {
  const headers = {};
  if (body && !(body instanceof FormData)) headers["content-type"] = "application/json";
  if (auth) { const t = getToken(); if (t) headers.authorization = `Bearer ${t}`; }
  const opts = { method, headers, body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined) };
  if (timeout > 0) opts.signal = AbortSignal.timeout(timeout);
  try {
    const res = await fetch(BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* non-json (e.g. QR svg) */ }
    if (res.status === 401 && auth) { setToken(""); unauthCb?.(); }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "network" } };
  }
}