const TOKEN_KEY = "wpp_token";
const BASE = "";

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
export function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

export function apiUrl(p) { return BASE + p; }

export async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (auth) {
    const t = getToken();
    if (t) headers.authorization = `Bearer ${t}`;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* non-json */ }
  if (res.status === 401 && auth) {
    setToken("");
    onUnauthorised?.();
  }
  return { status: res.status, body: json };
}

export function setUnauthorised(cb) { onUnauthorised = cb; }
let onUnauthorised = null;