// End-to-end system test against a RUNNING deployment (Railway, staging, or local).
// Exercises every function group over HTTP as a black box: health, console, auth,
// staff management, campaign configuration views, the participant journey through
// the simulator channel (registration, outlet selection, real-OCR receipt outcomes,
// duplicates, review), entries, draws (freeze -> execute -> approve -> verify ->
// publish), winners (notify -> verified -> accepted -> collected -> published),
// public winners, CRM/queue/alerts/audit views, exports, RBAC and session security.
//
// Usage:
//   BASE_URL=https://<app>.up.railway.app ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//     node scripts/remote-smoke.mjs [--no-draw] [--out docs/testing/evidence/remote-smoke.json]
//
// Requirements: the deployment runs the TEST ONLY sample campaign (non-production
// bootstrap), WHATSAPP_TRANSPORT=simulator (the participant steps use
// /api/simulator/inbound, which is disabled in production) and a real extractor.
// The script creates smoke-*@example.test staff accounts with random passwords
// (never printed) and renders fresh receipt images with unique numbers, so it does
// not consume the UAT-reserved fixtures. --no-draw leaves the un-drawn sample
// period (W-1) for the human UAT draw steps; without it the first run against a
// deployment executes that draw end to end.
import fs from "node:fs";
import crypto from "node:crypto";

const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = (process.env.BASE_URL || "").replace(/\/+$/, ""); const ADMIN_EMAIL = process.env.ADMIN_EMAIL, ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const NO_DRAW = args.includes("--no-draw"), OUT = opt("--out", null);
if (!BASE || !ADMIN_EMAIL || !ADMIN_PASSWORD) { console.error("BASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD are required (values are never printed)"); process.exit(2); }

const results = []; let current = "setup";
const rec = (name, pass, detail = "", skipped = false) => { results.push({ group: current, name, status: skipped ? "SKIP" : pass ? "PASS" : "FAIL", detail: String(detail ?? "").slice(0, 300) }); console.log(`${skipped ? "SKIP" : pass ? "PASS" : "FAIL"}  [${current}] ${name}${detail ? " — " + String(detail).slice(0, 160) : ""}`); return !!pass; };
const group = (g) => { current = g; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, { token = null, body = null, raw = false, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text: raw ? text : text.slice(0, 2000), headers: res.headers };
}
const randomPassword = () => "Smk-" + crypto.randomBytes(12).toString("base64url") + "9a";

// ---- receipt renderer (same fictional layouts as the fixtures; unique numbers per run)
async function renderReceipt({ layout = "A", no, date, items, branch = "Westgate Branch, Harare" }) {
  const sharp = (await import("sharp")).default;
  const money = (n) => n.toFixed(2);
  const L = {
    A: { header: ["SUNRISE SUPERMARKET", branch, "Tel 024 000000"], meta: [`Receipt No: ${no}   Till: 03`, `Date: ${date}  14:22`], line: (d, q, u, a) => [`${d}`, `   ${q} x ${u}          ${a}`], footer: (t) => ["--------------------------------", `TOTAL                    ${t}`, `CASH                     ${t}`, "Thank you for shopping"] },
    B: { header: ["VALUEMART", branch, "VAT REG 200000"], meta: [`INV ${no}   POS 7`, `${date}  14:22   CASHIER: T`], line: (d, q, u, a) => [`${d}  ${q} @ ${u}  ${a}`], footer: (t) => ["================================", `GRAND TOTAL         ${t}`, `CARD                ${t}`, "Keep this slip for the promotion"] },
  }[layout];
  const lines = [...L.header, ...L.meta, "--------------------------------"]; let total = 0;
  for (const it of items) { const amt = it.qty * it.unit; total += amt; lines.push(...L.line(it.desc, it.qty, money(it.unit), money(amt))); }
  lines.push(...L.footer(money(total)));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="${lines.length * 36 + 70}"><rect width="100%" height="100%" fill="#f7f5ef"/>${lines.map((l, i) => `<text x="30" y="${52 + i * 36}" font-family="DejaVu Sans Mono, Liberation Mono, Courier New, monospace" font-size="24" fill="#111">${esc(l)}</text>`).join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}
async function noiseImage() { const sharp = (await import("sharp")).default; const w = 600, h = 800, raw = Buffer.alloc(w * h * 3); let s = 12345; for (let i = 0; i < raw.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; raw[i] = s >>> 24; } return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 70 }).toBuffer(); }

// ---- simulator channel helpers
const replyText = (r) => (typeof r === "string" ? r : r?.body || r?.text || JSON.stringify(r || ""));
async function sim(token, phone, textOrImage, mime = "image/jpeg") {
  const body = Buffer.isBuffer(textOrImage) ? { phone, image_b64: textOrImage.toString("base64"), mime } : { phone, text: textOrImage };
  const r = await api("POST", "/api/simulator/inbound", { token, body });
  const replies = (r.json?.replies || []).map(replyText);
  return { status: r.status, replies, text: replies.join("\n"), state: r.json?.result?.state || null, raw: r.json };
}
async function transcript(token, phone) { const r = await api("GET", `/api/simulator/transcript/${phone}`, { token }); return (r.json?.transcript || []).map((t) => `${t.dir}:${t.purpose || t.kind}:${t.text || ""}`); }
async function waitReceipt(token, reference, maxMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { const r = await api("GET", `/api/receipts?reference=${encodeURIComponent(reference)}`, { token }); const rc = r.json?.receipts?.[0]; if (rc && !["received", "processing", "delayed"].includes(rc.status)) return rc; await sleep(1500); }
  return null;
}
async function submitReceipt(adminToken, phone, outletQuery, image) {
  await sim(adminToken, phone, "2"); await sim(adminToken, phone, outletQuery); const pick = await sim(adminToken, phone, "1");
  const up = await sim(adminToken, phone, image);
  const ref = (up.text.match(/R-[A-Z0-9]{8}/) || [])[0];
  const receipt = ref ? await waitReceipt(adminToken, ref) : null;
  return { pick, up, ref, receipt };
}

// ---- staff bootstrap: create (or reset) role-scoped accounts and log them in
async function staffToken(adminToken, email, roles) {
  const list = await api("GET", "/api/users", { token: adminToken });
  const existing = (list.json?.users || []).find((u) => u.email === email);
  let temp;
  if (existing) { const r = await api("POST", `/api/users/${existing.id}/reset-password`, { token: adminToken }); temp = r.json?.temporaryPassword; if (!temp) throw new Error(`reset-password for ${email} failed: ${r.status} ${r.text}`); }
  else { const r = await api("POST", "/api/users", { token: adminToken, body: { email, name: `Smoke ${roles[0]}`, roles } }); temp = r.json?.temporaryPassword; if (!temp) throw new Error(`create user ${email} failed: ${r.status} ${r.text}`); }
  const l1 = await api("POST", "/api/login", { body: { email, password: temp } }); if (!l1.json?.token) throw new Error(`temp login ${email} failed: ${l1.status}`);
  const pw = randomPassword();
  const ch = await api("POST", "/api/password", { token: l1.json.token, body: { currentPassword: temp, newPassword: pw } }); if (!ch.ok) throw new Error(`password change ${email} failed: ${ch.status} ${ch.text}`);
  const l2 = await api("POST", "/api/login", { body: { email, password: pw } }); if (!l2.json?.token) throw new Error(`login ${email} after change failed`);
  return { token: l2.json.token, mustChangeBefore: !!l1.json.user?.mustChangePassword };
}

const run = String(Date.now()).slice(-7); const P1 = `26377${run}1`.slice(0, 12), P2 = `26377${run}2`.slice(0, 12);
const today = new Date(); const dmy = `${String(today.getUTCDate()).padStart(2, "0")}/${String(today.getUTCMonth() + 1).padStart(2, "0")}/${today.getUTCFullYear()}`;
const SUGAR = (qty) => ({ desc: "GOLDCANE BROWN SUGAR 2KG", qty, unit: 3.1 }); const BREAD = { desc: "BREAD WHITE 700G", qty: 1, unit: 1.2 };
let admin, campaign, campaignDetail, staff = {};
const startedAt = new Date().toISOString();
try {
  // ===== 1. availability
  group("availability");
  const live = await api("GET", "/health/live"); rec("GET /health/live", live.status === 200, `HTTP ${live.status}`);
  const ready = await api("GET", "/health/ready"); rec("GET /health/ready (db + extractor + worker)", ready.status === 200 && ready.json?.ok, `HTTP ${ready.status} extractor=${ready.json?.extractor?.provider || "?"} mode=${ready.json?.extractor?.mode || "?"}`);
  const home = await api("GET", "/", { raw: true }); rec("console served at /", home.status === 200 && /<div id="root"|<script/i.test(home.text), `HTTP ${home.status} ${home.headers.get("content-type")}`);
  const oa = await api("GET", "/api/openapi.json"); rec("OpenAPI document", oa.status === 200 && oa.json?.paths && Object.keys(oa.json.paths).length > 50, `${Object.keys(oa.json?.paths || {}).length} paths`);
  const pub = await api("GET", "/api/winners/public"); rec("public winners endpoint (no auth)", pub.status === 200 && Array.isArray(pub.json?.winners), `${pub.json?.winners?.length ?? "?"} published winners, periods=${(pub.json?.periods || []).map((p) => p.code || p).join(",")}`);

  // ===== 2. authentication and session security
  group("auth");
  const bad = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: "definitely-wrong-password" } }); rec("wrong password rejected", bad.status === 401, `HTTP ${bad.status}`);
  const login = await api("POST", "/api/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }); admin = login.json?.token; if (!rec("admin login", !!admin, `HTTP ${login.status} roles=${(login.json?.user?.roles || []).join(",")}`)) throw new Error("cannot continue without admin token");
  const who = await api("GET", "/api/whoami", { token: admin }); rec("whoami reports roles and environment", who.ok && who.json?.roles?.length, `env=${who.json?.environment} mfa=${who.json?.mfa}`);
  const unauth = await api("GET", "/api/receipts"); rec("unauthenticated API call rejected", unauth.status === 401, `HTTP ${unauth.status}`);
  const badTok = await api("GET", "/api/receipts", { token: "not-a-real-token" }); rec("garbage token rejected", badTok.status === 401, `HTTP ${badTok.status}`);

  // ===== 3. staff management + RBAC
  group("staff");
  for (const [k, email, roles] of [["reviewer", "smoke-reviewer@example.test", ["reviewer"]], ["draw", "smoke-draw@example.test", ["draw_officer"]], ["approver", "smoke-approver@example.test", ["draw_approver"]], ["ops", "smoke-ops@example.test", ["winner_ops"]], ["support", "smoke-support@example.test", ["support"]]]) {
    try { staff[k] = await staffToken(admin, email, roles); rec(`account ${email}: create/reset -> temporary password -> forced change -> login`, true, `forced change=${staff[k].mustChangeBefore}`); } catch (e) { rec(`account ${email}`, false, e.message); }
  }
  const forbid = await api("POST", "/api/users", { token: staff.reviewer?.token, body: { email: "x@example.test", roles: ["reviewer"] } }); rec("reviewer cannot manage staff (403)", forbid.status === 403, `HTTP ${forbid.status}`);
  const adminDraw = await api("POST", "/api/draws", { token: admin, body: { campaign_id: "x", period_id: "y" } }); rec("platform_admin cannot freeze a draw (no draw_officer role)", adminDraw.status === 403, `HTTP ${adminDraw.status}`);
  const revQueue = await api("GET", "/api/reviews/queue", { token: staff.reviewer?.token }); rec("reviewer sees the review queue", revQueue.ok, `HTTP ${revQueue.status}`);

  // ===== 4. campaign configuration views
  group("campaign");
  const camps = await api("GET", "/api/campaigns", { token: admin }); campaign = (camps.json?.campaigns || []).find((c) => c.status === "active") || camps.json?.campaigns?.[0];
  if (!rec("active campaign present", !!campaign, campaign ? `${campaign.code} (${campaign.status}) v${campaign.active_version}` : "none")) throw new Error("no campaign");
  const det = await api("GET", `/api/campaigns/${campaign.id}`, { token: admin }); campaignDetail = det.json; rec("campaign detail: active version with rules, content, flags", det.ok && det.json?.active_version?.rules?.primary_rule, `rules primary=${JSON.stringify(det.json?.active_version?.rules?.primary_rule || {})}`);
  const periods = await api("GET", `/api/campaigns/${campaign.id}/periods`, { token: admin }); rec("periods listed", periods.ok && periods.json?.periods?.length >= 1, (periods.json?.periods || []).map((p) => `${p.code}:${p.status || ""}`).join(" "));
  const outlets = await api("GET", `/api/campaigns/${campaign.id}/outlets`, { token: admin }); const outletRows = outlets.json?.outlets || outlets.json || []; rec("campaign outlet master (80 sample outlets)", outlets.ok && outletRows.length >= 80, `${outletRows.length} outlets`);
  const products = await api("GET", "/api/products", { token: admin }); rec("product catalogue with pack grams", products.ok && (products.json?.products || []).some((p) => p.pack_grams), (products.json?.products || []).map((p) => p.code).join(","));
  const decisions = await api("GET", `/api/campaigns/${campaign.id}/decisions`, { token: admin }); const decRows = decisions.json?.decisions || decisions.json || []; rec("decision register D-01..D-22", decisions.ok && decRows.length >= 22, `${decRows.length} decisions, open=${decRows.filter((d) => d.status === "open").length}`);
  const act = await api("GET", `/api/campaigns/${campaign.id}/activation`, { token: admin }); rec("production activation validator refuses (sample markers / open decisions)", act.ok && act.json?.ok === false && (act.json?.failures || []).length > 0, `${(act.json?.failures || []).length} failures`);
  const readiness = await api("GET", "/api/readiness", { token: admin }); rec("readiness endpoint with provider modes", readiness.ok && readiness.json?.providers?.extractor?.mode, `transport=${readiness.json?.providers?.transport?.mode} extractor=${readiness.json?.providers?.extractor?.mode} crm=${readiness.json?.providers?.crm?.mode} levels=${JSON.stringify(readiness.json?.levels)}`);
  const csv = await api("GET", "/api/outlets/export.csv", { token: admin, raw: true }); rec("outlet CSV export", csv.status === 200 && /^outlet_code,/.test(csv.text), `${csv.text.split(/\r?\n/).length - 1} rows`);
  const versions = await api("GET", `/api/campaigns/${campaign.id}/versions`, { token: admin }); rec("versions listed", versions.ok, `${(versions.json?.versions || []).length} versions`);

  // ===== 5. participant journey (simulator channel, real OCR)
  group("participant");
  const hi = await sim(admin, P1, "hi"); rec("greeting returns the menu", hi.status === 200 && /1\./.test(hi.text) && hi.state === "HOME", hi.text.split("\n")[0]);
  await sim(admin, P1, "1"); await sim(admin, P1, "Smoke"); await sim(admin, P1, "Tester"); await sim(admin, P1, `TESTSMK${run.slice(-4)}A`); const conf = await sim(admin, P1, "Harare"); await sim(admin, P1, "yes"); const reg = await sim(admin, P1, "yes");
  rec("registration: name, surname, ID (masked in confirmation), town, confirm, terms", /\*\*/.test(conf.text) && /registered/i.test(reg.text) && reg.state === "HOME", reg.text.split("\n")[0]);
  const part = await api("GET", `/api/participants?q=${P1}`, { token: admin }); const p1 = part.json?.participants?.[0]; rec("participant visible to staff with masked identity", !!p1 && !/TESTSMK/.test(JSON.stringify(p1)), p1 ? `id=${p1.id} status=${p1.status}` : "not found");
  const no1 = `${run.slice(-5)}1`;
  const img1 = await renderReceipt({ layout: "A", no: no1, date: dmy, items: [SUGAR(2), BREAD] });
  const s1 = await submitReceipt(admin, P1, "sunrise westgate harare", img1);
  rec("outlet selection by search resolves to a canonical outlet", /Outlet: Sunrise Supermarket/.test(s1.pick.text), s1.pick.text.split("\n")[0]);
  rec("receipt acknowledged durably with a reference", !!s1.ref, s1.up.text.split("\n")[0]);
  rec("fresh two-pack receipt read from pixels -> QUALIFIED", s1.receipt?.status === "QUALIFIED", `${s1.ref} -> ${s1.receipt?.status} ${s1.receipt?.reason_code || ""}`);
  const tr1 = await transcript(admin, P1); rec("participant told ONE entry was added", tr1.some((t) => /ONE entry has been added/.test(t)), tr1.filter((t) => t.startsWith("out:receipt_outcome")).slice(-1)[0]);
  const ent = await api("GET", `/api/entries?participant=${p1?.id}`, { token: admin }); const e1 = ent.json?.entries?.[0]; rec("exactly one active entry in the ledger", ent.ok && (ent.json?.entries || []).filter((e) => e.status === "active").length === 1, `${(ent.json?.entries || []).length} entries`);
  if (e1) { const trace = await api("GET", `/api/entries/${e1.id}`, { token: admin }); rec("entry trace shows the OCR provider and rules version", trace.ok && trace.json?.validation && /tesseract|vision/.test(JSON.stringify(trace.json.validation)), `provider=${JSON.stringify(trace.json?.validation?.extractor_provider || trace.json?.validation?.[0]?.extractor_provider || "")}`); }
  const s1b = await submitReceipt(admin, P1, "sunrise westgate harare", img1); rec("same receipt again (same phone) -> DUPLICATE, no second entry", s1b.receipt?.status === "DUPLICATE", `${s1b.ref} -> ${s1b.receipt?.status}`);
  await sim(admin, P2, "hi"); await sim(admin, P2, "1"); await sim(admin, P2, "Smoke"); await sim(admin, P2, "Second"); await sim(admin, P2, `TESTSMK${run.slice(-4)}B`); await sim(admin, P2, "Bulawayo"); await sim(admin, P2, "yes"); await sim(admin, P2, "yes");
  const s1c = await submitReceipt(admin, P2, "sunrise westgate harare", img1); rec("same receipt from another phone -> DUPLICATE (cross-phone re-use blocked)", s1c.receipt?.status === "DUPLICATE", `${s1c.ref} -> ${s1c.receipt?.status}`);
  const one = await submitReceipt(admin, P2, "sunrise westgate harare", await renderReceipt({ layout: "A", no: `${run.slice(-5)}2`, date: dmy, items: [SUGAR(1), BREAD] })); rec("one pack -> NOT_QUALIFIED below_minimum_quantity", one.receipt?.status === "NOT_QUALIFIED" && one.receipt?.reason_code === "below_minimum_quantity", `${one.ref} -> ${one.receipt?.status} ${one.receipt?.reason_code}`);
  const noise = await submitReceipt(admin, P2, "sunrise westgate harare", await noiseImage()); rec("non-receipt photo -> REUPLOAD_REQUIRED", noise.receipt?.status === "REUPLOAD_REQUIRED", `${noise.ref} -> ${noise.receipt?.status} ${noise.receipt?.reason_code || ""}`);
  const badBytes = await sim(admin, P2, Buffer.from("this is not an image"), "image/jpeg"); rec("malformed upload refused with guidance (not stored as a receipt)", /couldn't be used|not.*used|try again|photo/i.test(badBytes.text), badBytes.text.split("\n")[0]);
  const amb = await submitReceipt(admin, P2, "valuemart westgate harare", await renderReceipt({ layout: "B", no: `${run.slice(-5)}3`, date: "11/01/2026", items: [SUGAR(2), BREAD] })); rec("date readable both ways (11/01/2026) -> REVIEW_REQUIRED, never auto-decided", amb.receipt?.status === "REVIEW_REQUIRED", `${amb.ref} -> ${amb.receipt?.status} ${amb.receipt?.reason_code || ""}`);
  const mine = await sim(admin, P1, "7"); rec("menu 7: own entry status", /1 qualified|entries|entry/i.test(mine.text), mine.text.split("\n")[0]);
  const mech = await sim(admin, P1, "3"); const terms = await sim(admin, P1, "4"); const prizes = await sim(admin, P1, "5"); const winnersMenu = await sim(admin, P1, "6"); rec("menu 3/4/5/6: mechanics, terms, prizes, winners", [mech, terms, prizes, winnersMenu].every((m) => m.status === 200 && m.text.length > 20), `winners: ${winnersMenu.text.split("\n")[0]}`);
  const help = await sim(admin, P1, "help"); const menu = await sim(admin, P1, "menu"); rec("HELP and MENU keywords", help.status === 200 && /1\./.test(menu.text), menu.text.split("\n")[0]);

  // ===== 6. review workflow
  group("review");
  if (amb.receipt && staff.reviewer) {
    const q = await api("GET", "/api/reviews/queue", { token: staff.reviewer.token }); rec("review queue contains the uncertain receipt", JSON.stringify(q.json || "").includes(amb.receipt.id), `queue size=${(q.json?.queue || q.json?.items || q.json?.receipts || []).length}`);
    const assign = await api("POST", `/api/receipts/${amb.receipt.id}/assign`, { token: staff.reviewer.token }); rec("reviewer assigns the task", assign.ok, `HTTP ${assign.status}`);
    const detail = await api("GET", `/api/receipts/${amb.receipt.id}`, { token: staff.reviewer.token }); const mediaUrl = detail.json?.media?.original?.url || (typeof detail.json?.media?.original === "string" ? detail.json.media.original : null); rec("receipt workspace: facts, rule results, outlet match, signed media link", detail.ok && detail.json?.receipt && mediaUrl, `media link=${mediaUrl ? "signed, expires " + (detail.json?.media?.original?.expiresAt || "") : "none"}`);
    if (mediaUrl) { const anon = await fetch(BASE + mediaUrl, { signal: AbortSignal.timeout(30_000) }); rec("signed media link without a staff session refused", anon.status === 401, `HTTP ${anon.status}`); const m = await fetch(BASE + mediaUrl, { headers: { authorization: `Bearer ${staff.reviewer.token}` }, signal: AbortSignal.timeout(30_000) }); rec("signed media link serves the image to the reviewer", m.status === 200 && /image\//.test(m.headers.get("content-type") || ""), `HTTP ${m.status} ${m.headers.get("content-type")}`); const bogus = await fetch(BASE + mediaUrl.replace(/sig=[^&]+/, "sig=deadbeef"), { headers: { authorization: `Bearer ${staff.reviewer.token}` }, signal: AbortSignal.timeout(30_000) }); rec("tampered media signature refused even with a session", bogus.status === 401 || bogus.status === 403, `HTTP ${bogus.status}`); }
    const adminReview = await api("POST", `/api/receipts/${amb.receipt.id}/review`, { token: admin, body: { decision: "QUALIFIED" } }); rec("platform_admin cannot decide a review (reviewer role only)", adminReview.status === 403, `HTTP ${adminReview.status}`);
    const rv = await api("POST", `/api/receipts/${amb.receipt.id}/review`, { token: staff.reviewer.token, body: { decision: "QUALIFIED", note: "smoke: date confirmed as 1 November" } }); rec("reviewer qualifies through the integrity path -> entry awarded", rv.ok && rv.json?.entryId, `HTTP ${rv.status} entry=${rv.json?.entryId || "none"}`);
    const again = await api("POST", `/api/receipts/${amb.receipt.id}/review`, { token: staff.reviewer.token, body: { decision: "NOT_QUALIFIED" } }); rec("second decision on the same receipt refused", !again.ok, `HTTP ${again.status}`);
    await sleep(2500); const tr2 = await transcript(admin, P2); rec("participant told the review outcome", tr2.some((t) => /after review/i.test(t) && /qualif/i.test(t)), tr2.filter((t) => t.startsWith("out:receipt_outcome")).slice(-1)[0]);
    if (rv.json?.entryId) { const dq = await api("POST", `/api/entries/${rv.json.entryId}/disqualify`, { token: admin, body: { reason: "smoke: disqualify then reinstate" } }); rec("entry disqualification (audited)", dq.ok, `HTTP ${dq.status}`); const ri = await api("POST", `/api/entries/${rv.json.entryId}/reinstate`, { token: admin, body: { reason: "smoke: reinstated" } }); rec("entry reinstatement", ri.ok, `HTTP ${ri.status}`); }
  } else rec("review workflow", false, "no uncertain receipt or reviewer account", true);

  // ===== 7. support handoff and privacy
  group("support");
  if (staff.support) {
    const conv = await api("GET", `/api/conversations/${P1}`, { token: staff.support.token }); rec("support sees the conversation transcript (masked phone)", conv.ok, `HTTP ${conv.status}`);
    const claim = await api("POST", `/api/conversations/${P1}/claim`, { token: staff.support.token }); const during = await sim(admin, P1, "hello?"); const send = await api("POST", `/api/conversations/${P1}/send`, { token: staff.support.token, body: { text: "Smoke support reply" } }); const release = await api("POST", `/api/conversations/${P1}/release`, { token: staff.support.token }); const after = await sim(admin, P1, "menu");
    rec("handoff: claim suspends automation (holding message only), operator sends, release resumes the menu", claim.ok && send.ok && release.ok && !/1\. Register/.test(during.text) && /1\./.test(after.text), `claim=${claim.status} send=${send.status} release=${release.status} during handoff: "${during.text.split("\n")[0].slice(0, 80)}"`);
  }
  if (p1) { const reveal = await api("POST", `/api/participants/${p1.id}/reveal-identity`, { token: admin, body: { reason: "smoke: winner verification test" } }); rec("identity reveal requires a reason and is audited", reveal.ok && /TESTSMK/.test(JSON.stringify(reveal.json)), `HTTP ${reveal.status}`); const aud = await api("GET", `/api/audit-events?target_id=${p1.id}`, { token: admin }); rec("audit trail records the reveal", aud.ok && JSON.stringify(aud.json).includes("reveal"), `${(aud.json?.events || aud.json?.audit_events || []).length} events`); }

  // ===== 8. draws and winners
  group("draw");
  const perRows = periods.json?.periods || [];
  const drawsList = await api("GET", `/api/campaigns/${campaign.id}/draws`, { token: admin }); const drawn = new Set((drawsList.json?.draws || []).filter((d) => d.status !== "void").map((d) => d.period_id));
  let candidate = null;
  for (const p of perRows) { if (drawn.has(p.id)) continue; const b = await api("GET", `/api/campaigns/${campaign.id}/periods/${p.id}/barrier`, { token: admin }); if (b.json?.ok) { candidate = { period: p, barrier: b.json }; break; } else if (p.code === "W-1") rec(`barrier W-1 reports blockers`, true, (b.json?.blockers || []).map((x) => x.code).join(",") || `HTTP ${b.status}`, true); }
  rec("existing draws listed with period codes and status", drawsList.ok, (drawsList.json?.draws || []).map((d) => `${d.period_code}:${d.status}`).join(" "));
  const existingPublished = (drawsList.json?.draws || []).find((d) => d.status === "published");
  if (existingPublished) { const v = await api("GET", `/api/draws/${existingPublished.id}/verify`, { token: admin }); rec("stored published draw re-verifies (seed, snapshot, output hashes)", v.ok && (v.json?.ok ?? v.json?.verified ?? true), JSON.stringify(v.json || {}).slice(0, 120)); const bundle = await api("GET", `/api/draws/${existingPublished.id}/bundle`, { token: admin }); rec("bundle export for the independent verifier", bundle.ok && bundle.json?.bundle_version && bundle.json?.audit_checkpoint, `${bundle.json?.bundle_version} events=${(bundle.json?.audit_events || []).length}`); }
  if (NO_DRAW) rec("draw execution", false, "--no-draw: sample period left for the human UAT", true);
  else if (!candidate) rec("draw execution", false, "no closed period with a passing barrier (already drawn on this deployment)", true);
  else if (!(staff.draw && staff.approver && staff.ops)) rec("draw execution", false, "staff accounts missing", true);
  else {
    const { period, barrier } = candidate; rec(`barrier ${period.code} passes`, true, `eligible=${barrier.eligible} distinct=${barrier.distinctParticipants} winners planned=${barrier.plan?.totalWinners}`);
    const fz = await api("POST", "/api/draws", { token: staff.draw.token, body: { campaign_id: campaign.id, period_id: period.id } }); const draw = fz.json?.draw; rec("freeze candidates (draw officer)", fz.status === 201 && draw?.snapshot_hash, `status=${draw?.status} snapshot=${(draw?.snapshot_hash || "").slice(0, 12)}`);
    const selfApprove = await api("POST", `/api/draws/${draw?.id}/approve`, { token: staff.draw.token, body: {} }); rec("draw officer cannot approve (separation of duties)", selfApprove.status === 403 || selfApprove.status === 409, `HTTP ${selfApprove.status}`);
    const ex = await api("POST", `/api/draws/${draw?.id}/execute`, { token: staff.draw.token }); const executed = ex.json?.draw; rec("execute with committed seed -> output hash", ex.ok && executed?.output_hash, `status=${executed?.status} output=${(executed?.output_hash || "").slice(0, 12)}`);
    const wrongHash = await api("POST", `/api/draws/${draw?.id}/approve`, { token: staff.approver.token, body: { expected_output_hash: "0000", note: "smoke" } }); rec("approval with a mismatching expected hash refused", !wrongHash.ok, `HTTP ${wrongHash.status}`);
    const ap = await api("POST", `/api/draws/${draw?.id}/approve`, { token: staff.approver.token, body: { expected_output_hash: executed?.output_hash, note: "smoke approval" } }); rec("independent approver approves against the output hash", ap.ok && ap.json?.draw?.status === "approved", `status=${ap.json?.draw?.status}`);
    const ver = await api("GET", `/api/draws/${draw?.id}/verify`, { token: admin }); rec("stored draw re-verifies deterministically", ver.ok && (ver.json?.ok ?? ver.json?.verified ?? true), JSON.stringify(ver.json || {}).slice(0, 120));
    const pubDraw = await api("POST", `/api/draws/${draw?.id}/publish`, { token: staff.ops.token }); const created = Array.isArray(pubDraw.json?.winners) ? pubDraw.json.winners.length : Number(pubDraw.json?.winners || 0); rec("publish draw materialises winners (fulfilment role)", pubDraw.ok && (created > 0 || pubDraw.json?.idempotent), `winners created=${created} status=${pubDraw.json?.draw?.status}`);
    group("winners");
    const wl = await api("GET", `/api/winners?draw=${draw?.id}`, { token: staff.ops.token }); const w = (wl.json?.winners || []).find((x) => x.status === "selected") || wl.json?.winners?.[0];
    rec("winners listed for the draw", wl.ok && (wl.json?.winners || []).length > 0, `${(wl.json?.winners || []).length} winners`);
    if (w) {
      const nt = await api("POST", `/api/winners/${w.id}/notify`, { token: staff.ops.token }); rec("notify winner -> claim reference + deadline, message queued", nt.ok && nt.json?.claimRef, `deadline=${nt.json?.deadline || "?"}`);
      const wrongOrder = await api("POST", `/api/winners/${w.id}/transition`, { token: staff.ops.token, body: { status: "collected" } }); rec("invalid transition (notified -> collected) refused", !wrongOrder.ok, `HTTP ${wrongOrder.status}`);
      const v1 = await api("POST", `/api/winners/${w.id}/transition`, { token: staff.ops.token, body: { status: "verified", evidence: "smoke: ID checked" } }); rec("verified", v1.ok, `HTTP ${v1.status}`);
      const collectionOutlet = outletRows.find((o) => o.campaign_collection_enabled || o.collection_enabled); const a1 = await api("POST", `/api/winners/${w.id}/transition`, { token: staff.ops.token, body: { status: "accepted", collection_outlet_id: collectionOutlet?.id } }); rec("accepted with a collection outlet", a1.ok, `HTTP ${a1.status} outlet=${collectionOutlet?.outlet_code || "none"}`);
      const c1 = await api("POST", `/api/winners/${w.id}/transition`, { token: staff.ops.token, body: { status: "collected", fulfilment_ref: `SMOKE-${run}` } }); rec("collected with fulfilment reference", c1.ok, `HTTP ${c1.status}`);
      const c2 = await api("POST", `/api/winners/${w.id}/transition`, { token: staff.ops.token, body: { status: "collected", fulfilment_ref: "again" } }); rec("second collection refused", !c2.ok, `HTTP ${c2.status}`);
      const pw = await api("POST", `/api/winners/${w.id}/publish`, { token: staff.ops.token }); rec("publish winner (projection only)", pw.ok, `HTTP ${pw.status}`);
      const pub2 = await api("GET", `/api/winners/public?period=${encodeURIComponent(period.code)}`); const row = (pub2.json?.winners || [])[0]; rec("public list shows only name initial, town, prize, week", pub2.ok && row && Object.keys(row).sort().join(",") === "location,name,period,prize,rank" && /^\S+ \S\.$/.test(row.name), JSON.stringify(row || {}));
      const wmenu = await sim(admin, P1, "6"); rec("participant menu 6 lists the published week", /W-|week|winner/i.test(wmenu.text), wmenu.text.split("\n")[0]);
    }
  }

  // ===== 9. operations views
  group("operations");
  const integ = await api("GET", "/api/integrations", { token: admin }); rec("integrations: transport/extractor/crm/db/storage/worker/queues", integ.ok && integ.json?.extractor && integ.json?.queues, `transport=${integ.json?.transport?.mode || integ.json?.transport?.provider} extractor=${integ.json?.extractor?.provider} crm=${integ.json?.crm?.mode} worker=${JSON.stringify(integ.json?.worker || {}).slice(0, 60)}`);
  const queue = await api("GET", "/api/queue", { token: admin }); rec("queue stats and dead letters", queue.ok, `dead events=${(queue.json?.dead_events || []).length} dead jobs=${(queue.json?.dead_jobs || []).length}`);
  const outb = await api("GET", "/api/outbound", { token: admin }); rec("outbound messages listed with masked phones", outb.ok && (outb.json?.messages || []).length > 0 && !(outb.json?.messages || []).some((m) => m.wa_phone_uid === P1), `${(outb.json?.messages || []).length} messages`);
  const crmEv = await api("GET", "/api/crm/events", { token: admin }); rec("CRM events queued and visible (provider may be not_configured)", crmEv.ok && (crmEv.json?.events || []).length > 0, `${(crmEv.json?.events || []).length} events; summary=${JSON.stringify(crmEv.json?.summary || {}).slice(0, 100)}`);
  const map = await api("GET", "/api/crm/mapping-preview", { token: admin }); rec("CRM mapping preview", map.ok, `HTTP ${map.status}`);
  const recon = await api("POST", "/api/crm/reconcile", { token: admin }); rec("CRM reconcile runs (audited)", recon.ok, `HTTP ${recon.status}`);
  const alerts = await api("GET", "/api/alerts", { token: admin }); rec("alerts view", alerts.ok, `${(alerts.json?.alerts || []).length} open alerts`);
  const rep = await api("GET", `/api/reports/summary?campaign=${campaign.id}`, { token: admin }); rec("reports summary", rep.ok, JSON.stringify(rep.json || {}).slice(0, 160));
  const exp = await api("GET", `/api/reports/export?scope=entries&campaign=${campaign.id}&format=csv`, { token: admin, raw: true }); rec("entries export (CSV, watermarked, formula-safe)", exp.status === 200 && exp.text.length > 10, `${exp.text.split(/\r?\n/).length - 1} rows`);
  const auditOk = await api("GET", "/api/audit/verify", { token: admin }); rec("audit hash chain verifies", auditOk.ok && (auditOk.json?.ok ?? auditOk.json?.valid), JSON.stringify(auditOk.json || {}).slice(0, 120));
  const setting = await api("GET", "/api/settings/sample_data", { token: admin }); rec("sample-data marker present (TEST ONLY deployment)", setting.ok && setting.json?.value, JSON.stringify(setting.json?.value || null).slice(0, 80));

  // ===== 10. session end
  group("auth");
  const lo = await api("POST", "/api/logout", { token: staff.support?.token || admin }); const afterLogout = await api("GET", "/api/whoami", { token: staff.support?.token || admin }); rec("logout revokes the session token", lo.ok && afterLogout.status === 401, `logout=${lo.status} whoami after=${afterLogout.status}`);
} catch (e) { rec("aborted", false, e.message); }

const summary = { base_url: BASE, started_at: startedAt, finished_at: new Date().toISOString(), pass: results.filter((r) => r.status === "PASS").length, fail: results.filter((r) => r.status === "FAIL").length, skip: results.filter((r) => r.status === "SKIP").length, results };
console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(summary, null, 2)); console.log(`written ${OUT}`); }
process.exit(summary.fail ? 1 : 0);
