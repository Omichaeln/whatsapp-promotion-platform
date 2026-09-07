"use strict";
// Admin console for the WhatsApp Promotion Platform (no deps).
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const base = "";
let TOKEN = localStorage.getItem("wpp_token") || "";
let ME = null;

function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  return fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast";
  t.style.borderColor = isErr ? "var(--danger)" : "var(--border)";
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

const pill = (s, k) => {
  const map = { QUALIFIED: "ok", DUPLICATE: "danger", NOT_QUALIFIED: "danger", NEEDS_REVIEW: "warn", ERROR: "danger", active: "ok", paused: "warn", draft: "muted", published: "ok", approved: "ok", executed: "warn", frozen: "muted", delivered: "ok", dead: "danger", pending: "warn" };
  return `<span class="pill ${map[k] || "muted"}">${esc(s)}</span>`;
};
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const short = (id, n = 10) => (id ? `<code title="${esc(id)}">${esc(id.slice(0, n))}…</code>` : "—");

function card(title, inner) { return `<div class="card"><h2>${title}</h2>${inner}</div>`; }

// ---------- login ----------
async function doLogin() {
  const email = $("#login-email").value.trim(), password = $("#login-pass").value;
  const r = await api("/api/login", { method: "POST", body: { email, password } });
  if (r.status === 200) {
    TOKEN = r.body.token; localStorage.setItem("wpp_token", TOKEN);
    await loadMe(); enterApp();
  } else {
    $("#login-err").classList.remove("hidden"); $("#login-err").textContent = r.body.error || "login failed";
  }
}
async function loadMe() {
  const r = await api("/api/whoami");
  if (r.status === 200) ME = r.body;
}
function logout() { TOKEN = ""; localStorage.removeItem("wpp_token"); ME = null; location.reload(); }
const hasRole = (...roles) => ME?.roles?.includes("platform_admin") || (ME && roles.some((x) => ME.roles.includes(x)));

// ---------- tabs ----------
function switchTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("main > div").forEach((d) => d.classList.toggle("hidden", d.id !== `tab-${name}`));
  const loaders = { dashboard: loadDashboard, campaigns: loadCampaigns, outlets: loadOutlets, products: loadProducts, receipts: loadReceipts, entries: loadEntries, draws: loadDraws, crm: loadCRM, audit: loadAudit, webhook: loadWebhook };
  loaders[name]?.();
}
function renderLoggedOutViews() {
  $$("#tabs button").forEach((b) => { const pub = ["dashboard", "webhook"].includes(b.dataset.tab); b.classList.toggle("hidden", !pub); });
}

// ---------- dashboard ----------
async function loadDashboard() {
  const el = $("#tab-dashboard");
  const [camps, recs, entries, crm] = await Promise.all([
    api("/api/campaigns"), api("/api/receipts"), api("/api/entries"), api("/api/crm-sync"),
  ]);
  const c = camps.body?.campaigns || [];
  const rec = recs.body?.receipts || [];
  const ent = entries.body?.entries || [];
  const counts = {};
  rec.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  el.innerHTML =
    card("Quick status", `<table>
      <tr><th>Signal</th><th>Value</th></tr>
      <tr><td>Active campaigns</td><td>${c.filter((x) => x.status === "active").length}</td></tr>
      <tr><td>Receipts — review queue</td><td>${counts["NEEDS_REVIEW"] || 0}</td></tr>
      <tr><td>Receipts — qualified</td><td>${counts["QUALIFIED"] || 0}</td></tr>
      <tr><td>Receipts — duplicates</td><td>${counts["DUPLICATE"] || 0}</td></tr>
      <tr><td>Qualified entries</td><td>${ent.length}</td></tr>
      <tr><td>CRM pending</td><td>${crm.body?.reconcile?.pending || 0}</td></tr>
      <tr><td>CRM dead letters</td><td>${crm.body?.reconcile?.dead || 0}</td></tr>
    </table>
    <p class="muted">Start with the <b>Webhook Tester</b> tab to simulate a customer registering and uploading a receipt, then review it in <b>Receipts</b> and run a draw in <b>Draws</b>.</p>`);
}

// ---------- campaigns ----------
async function loadCampaigns() {
  const el = $("#tab-campaigns");
  const r = await api("/api/campaigns");
  const camps = r.body?.campaigns || [];
  el.innerHTML =
    (hasRole("campaign_manager") ? card("New campaign", `<div class="row">
        <div><label>Code</label><input id="nc-code" placeholder="SUGAR-2026" /></div>
        <div><label>Name</label><input id="nc-name" placeholder="Brown Sugar Promo" /></div>
        <div><label>Start (ISO)</label><input id="nc-start" placeholder="2026-09-01T00:00:00Z" /></div>
        <div><label>End (ISO)</label><input id="nc-end" placeholder="2026-11-30T23:59:59Z" /></div>
        <div style="align-self:end"><button class="act" onclick="createCampaign()">Create + activate</button></div>
      </div>`) : "") +
    card("Campaigns", `<table><tr><th>Code</th><th>Name</th><th>Status</th><th>Start</th><th>End</th><th>Version</th><th></th></tr>` +
      camps.map((c) => `<tr>
        <td class="mono">${esc(c.code)}</td><td>${esc(c.name)}</td><td>${pill(c.status, c.status)}</td>
        <td class="mono">${fmt(c.start_at)}</td><td class="mono">${fmt(c.end_at)}</td>
        <td id="cv-${c.id}">…</td>
        <td>${hasRole("campaign_manager") ? `<button class="ghost small" onclick='openVersion("${c.id}","${esc(c.code)}")'>+ version</button>` : ""}</td>
      </tr>`).join("") + `</table>`);
  camps.forEach((c) => loadVersionBadge(c.id));
}
async function loadVersionBadge(cid) {
  const r = await api(`/api/campaigns`);
  const c = r.body?.campaigns?.find((x) => x.id === cid);
  const v = await api(`/api/campaigns/${cid}/versions`);
  $(`#cv-${cid}`).textContent = v.status === 200 ? `${v.body?.versions?.length || 0} versions` : "-";
}
function openVersion(cid, code) {
  const json = JSON.stringify({ content: {}, rules: { products: [{ sku: "ZSB-2KG", pack_weight_kg: 2 }], min_packs: 2, min_total_qty_kg: 4, weekly_caps: { participant: 5 } }, flags: {} }, null, 2);
  const el = $("#tab-campaigns");
  el.innerHTML = `<div class="card"><h2>New version for ${esc(code)}</h2>
    <label>Version JSON (content + rules + flags)</label>
    <textarea id="ver-json" rows="16">${esc(json)}</textarea>
    <p style="margin-top:8px"><button class="act" onclick="createVersion('${cid}')">Save draft version</button>
    <button class="ghost" onclick="loadCampaigns()">Back</button></p></div>`;
}
async function createCampaign() {
  const body = { code: $("#nc-code").value.trim(), name: $("#nc-name").value.trim() || undefined, start_at: $("#nc-start").value, end_at: $("#nc-end").value };
  if (!body.code || !body.start_at || !body.end_at) return toast("code, start and end (ISO) required", true);
  const r = await api("/api/campaigns", { method: "POST", body });
  if (r.status === 201) {
    const rules = { products: [{ sku: "ZSB-2KG", pack_weight_kg: 2 }], min_packs: 2, min_total_qty_kg: 4, weekly_caps: { participant: 5 } };
    const vr = await api(`/api/campaigns/${r.body.id}/versions`, { method: "POST", body: { content: {}, rules, flags: {} } });
    if (vr.status === 201) await api(`/api/campaigns/${r.body.id}/versions/${vr.body.versionId}/activate`, { method: "POST", body: {} });
    toast("Campaign created + activated"); loadCampaigns();
  } else toast(`create failed: ${r.body?.error || r.status}`, true);
}
async function createVersion(cid) {
  let payload;
  try { payload = JSON.parse($("#ver-json").value); } catch { return toast("invalid JSON", true); }
  const vr = await api(`/api/campaigns/${cid}/versions`, { method: "POST", body: payload });
  if (vr.status === 201) {
    const ac = await api(`/api/campaigns/${cid}/versions/${vr.body.versionId}/activate`, { method: "POST", body: {} });
    toast("Version saved + activated"); loadCampaigns();
  } else toast(`version failed: ${vr.body?.error || vr.status}`, true);
}

// ---------- outlets ----------
async function loadOutlets() {
  const el = $("#tab-outlets");
  const r = await api("/api/outlets");
  const rows = r.body?.outlets || [];
  el.innerHTML =
    (hasRole("campaign_manager") ? card("Add outlet", `<div class="row">
        <div><label>Code</label><input id="ol-code" placeholder="OK-HRE-03" /></div>
        <div><label>Retailer</label><input id="ol-ret" placeholder="OK Mart" /></div>
        <div><label>Branch</label><input id="ol-branch" placeholder="Borrowdale" /></div>
        <div><label>Town</label><input id="ol-town" placeholder="Harare" /></div>
        <div><label>Province</label><input id="ol-prov" placeholder="Harare" /></div>
        <div style="align-self:end"><button class="act" onclick="addOutlet()">Add</button></div>
      </div>`) : "") +
    card(`Outlets (${rows.length})`, `<table><tr><th>Code</th><th>Retailer</th><th>Branch</th><th>Town</th><th>Province</th><th>Collection</th></tr>` +
      rows.map((o) => `<tr><td class="mono">${esc(o.outlet_code)}</td><td>${esc(o.retailer)}</td><td>${esc(o.branch)}</td><td>${esc(o.town)}</td><td>${esc(o.province)}</td><td>${o.collection_enabled ? "✓" : "—"}</td></tr>`).join("") + `</table>`);
}
async function addOutlet() {
  const body = { outlet_code: $("#ol-code").value.trim(), retailer: $("#ol-ret").value.trim(), branch: $("#ol-branch").value.trim(), town: $("#ol-town").value.trim(), province: $("#ol-prov").value.trim() };
  if (!body.outlet_code || !body.retailer || !body.town || !body.province) return toast("code, retailer, town, province required", true);
  const r = await api("/api/outlets", { method: "POST", body });
  r.status === 201 ? (toast("Outlet added"), loadOutlets()) : toast(`failed: ${r.body?.error || r.status}`, true);
}

// ---------- products ----------
async function loadProducts() {
  const el = $("#tab-products");
  const r = await api("/api/products");
  const rows = r.body?.products || [];
  el.innerHTML =
    (hasRole("campaign_manager") ? card("Add product", `<div class="row">
        <div><label>SKU</label><input id="pr-sku" placeholder="ZSB-2KG" /></div>
        <div><label>Brand</label><input id="pr-brand" placeholder="ZimSweet" /></div>
        <div><label>Name</label><input id="pr-name" placeholder="Brown Sugar 2kg" /></div>
        <div><label>Pack weight (kg)</label><input id="pr-w" type="number" step="0.1" value="2" /></div>
        <div style="align-self:end"><button class="act" onclick="addProduct()">Add</button></div>
      </div>`) : "") +
    card(`Products (${rows.length})`, `<table><tr><th>SKU</th><th>Brand</th><th>Name</th><th>Pack kg</th><th>Aliases</th></tr>` +
      rows.map((p) => `<tr><td class="mono">${esc(p.sku)}</td><td>${esc(p.brand)}</td><td>${esc(p.name)}</td><td>${p.pack_weight_kg}</td><td class="muted">${esc((p.aliases_json || "[]"))}</td></tr>`).join("") + `</table>`);
}
async function addProduct() {
  const body = { sku: $("#pr-sku").value.trim(), brand: $("#pr-brand").value.trim(), name: $("#pr-name").value.trim(), pack_weight_kg: Number($("#pr-w").value) };
  if (!body.sku || !body.name || !body.pack_weight_kg) return toast("sku, name, pack weight required", true);
  const r = await api("/api/products", { method: "POST", body });
  r.status === 201 ? (toast("Product added"), loadProducts()) : toast(`failed: ${r.body?.error || r.status}`, true);
}

// ---------- receipts + review ----------
async function loadReceipts() {
  const el = $("#tab-receipts");
  const r = await api("/api/receipts");
  const rows = r.body?.receipts || [];
  el.innerHTML =
    card(`Receipts (${rows.length})`, `<table><tr><th>ID</th><th>Status</th><th>Reason</th><th>Campaign</th><th>Created</th><th></th></tr>` +
      rows.map((x) => `<tr>
        <td class="mono">${short(x.id, 14)}</td><td>${pill(x.status, x.status)}</td>
        <td class="mono muted">${esc(x.reason_code || "")}</td><td class="mono muted">${short(x.campaign_id, 8)}</td>
        <td>${fmt(x.created_at)}</td>
        <td>${x.status === "NEEDS_REVIEW" && hasRole("reviewer") ? `<button class="ghost small" onclick="openReview('${x.id}')">Review</button>` : ""}</td>
      </tr>`).join("") + `</table>`);
}
async function openReview(id) {
  const r = await api(`/api/receipts/${id}`);
  if (r.status !== 200) return toast("receipt not found", true);
  const x = r.body.receipt, val = r.body.validation?.[0];
  const el = $("#tab-receipts");
  el.innerHTML = `<div class="card"><h2>Review receipt — ${short(x.id, 16)}</h2>
    <table>
      <tr><th>Status</th><td>${pill(x.status, x.status)}</td><th>Outcome copy (sent to participant)</th></tr>
      <tr><th>Campaign version</th><td class="mono">${short(x.campaign_version_id, 14)}</td><th>Selected outlet</th><td class="mono">${esc(x.selected_outlet_id || "—")}</td></tr>
      <tr><th>Confidence</th><td>${Math.round((val?.confidence || 0) * 100)}%</td><th>Provider</th><td class="mono">${esc(val?.extractor_provider || "")}</td></tr>
      <tr><th>Extracted facts</th><td colspan="3"><pre class="log">${esc(JSON.stringify(JSON.parse(val?.facts_json || "null"), null, 1))}</pre></td></tr>
      <tr><th>Rules</th><td colspan="3"><pre class="log">${esc(JSON.stringify(JSON.parse(val?.rule_results_json || "[]"), null, 1))}</pre></td></tr>
    </table>
    <label>Decision</label>
    <select id="rv-decision"><option value="QUALIFIED">Qualify (create entry)</option><option value="NOT_QUALIFIED">Reject</option><option value="DUPLICATE">Duplicate</option><option value="REQUIRES_REUPLOAD">Request re-upload</option></select>
    <label>Reason code</label><input id="rv-reason" placeholder="reviewer_confirmed" />
    <label>Note</label><input id="rv-note" placeholder="optional internal note" />
    <p style="margin-top:8px"><button class="act" onclick="submitReview('${id}')">Apply decision</button>
    <button class="ghost" onclick="loadReceipts()">Back</button></p></div>`;
}
async function submitReview(id) {
  const body = { decision: $("#rv-decision").value, reason_code: $("#rv-reason").value.trim() || undefined, note: $("#rv-note").value.trim() || undefined };
  const r = await api(`/api/receipts/${id}/reviews`, { method: "POST", body });
  r.status === 200 ? (toast(`Decision applied ${r.body.decision}`), loadReceipts()) : toast(`failed: ${r.body?.error || r.status}`, true);
}

// ---------- entries ----------
async function loadEntries() {
  const el = $("#tab-entries");
  const r = await api("/api/entries");
  const rows = r.body?.entries || [];
  el.innerHTML = card(`Qualified entries (${rows.length})`, `<table><tr><th>ID</th><th>Receipt</th><th>Participant</th><th>Draw period</th><th>Entry #</th><th>Status</th><th>Created</th></tr>` +
    rows.map((e) => `<tr><td class="mono">${short(e.id, 14)}</td><td class="mono">${short(e.receipt_id, 14)}</td><td class="mono">${short(e.participant_id, 12)}</td><td class="mono">${esc(e.draw_period)}</td><td>${e.entry_no}</td><td>${pill(e.status, e.status)}</td><td>${fmt(e.created_at)}</td></tr>`).join("") + `</table>`);
}

// ---------- draws ----------
let DRAWS = [];
async function loadDraws() {
  const el = $("#tab-draws");
  const r = await api("/api/entries");
  const entries = r.body?.entries || [];
  const periods = [...new Set(entries.map((e) => e.draw_period))];
  el.innerHTML =
    card("Freeze a draw", `<div class="row">
        <div><label>Draw period (ISO week)</label><select id="dr-period"><option value="">— select —</option>
          ${periods.map((p) => `<option value="${esc(p)}">${esc(p)} (${entries.filter((e) => e.draw_period === p).length} entries)</option>`).join("")}
        </select></div>
        <div style="align-self:end"><button class="act" ${hasRole("draw_officer") ? "" : "disabled title='requires draw_officer'" } onclick="freezeDraw()">Freeze candidates</button></div>
      </div>
      <p class="muted">Draw missing from the list? Use the Webhook Tester to create entries first, then reload this tab.</p>`) +
    card("Draws — last executed", drawRows());
}
async function drawRows() {
  // draws aren't listed via the API; read output from the DB via audit-reachable state — use /api/receipts? no.
  // Expose frozen draws through a lightweight endpoint: reuse /api/draws GET list.
  const r = await api("/api/draws");
  if (r.status !== 200) return `<p class="muted">${esc(r.body?.error || "no draws")}</p>`;
  const draws = r.body?.draws || [];
  DRAWS = draws;
  return `<table><tr><th>ID</th><th>Period</th><th>Status</th><th>Snapshot</th><th>Output</th><th>Actions</th></tr>` +
    draws.map((d) => `<tr>
      <td class="mono">${short(d.id, 10)}</td><td class="mono">${esc(d.draw_period)}</td><td>${pill(d.status, d.status)}</td>
      <td class="mono muted">${esc((d.snapshot_hash || "").slice(0, 12))}</td>
      <td class="mono muted">${d.output_hash ? esc(d.output_hash.slice(0, 12)) : "—"}</td>
      <td>
        ${d.status === "frozen" && hasRole("draw_officer") ? `<button class="ghost small" onclick="runDraw('${d.id}','execute')">Execute</button>` : ""}
        ${d.status === "executed" && hasRole("draw_approver") ? `<button class="ghost small" onclick="runDraw('${d.id}','approve')">Approve</button>` : ""}
        ${d.status === "approved" && hasRole("winner_ops") ? `<button class="ghost small" onclick="runDraw('${d.id}','publish')">Publish</button>` : ""}
      </td></tr>`).join("") + `</table>`;
}
async function freezeDraw() {
  const period = $("#dr-period").value;
  if (!period) return toast("select a draw period", true);
  const r = await api("/api/draws", { method: "POST", body: { draw_period: period } });
  r.status === 201 ? (toast(`Frozen: ${r.body.count} candidates`), loadDraws()) : toast(`freeze failed: ${r.body?.error || r.status}`, true);
}
async function runDraw(id, action) {
  const r = await api(`/api/draws/${id}/${action}`, { method: "POST", body: {} });
  r.status === 200 ? (toast(`${action} ok`), loadDraws()) : toast(`${action} failed: ${r.body?.error || r.status}`, true);
}

// ---------- CRM ----------
async function loadCRM() {
  const el = $("#tab-crm");
  const r = await api("/api/crm-sync");
  el.innerHTML =
    card("Reconciliation", `<table><tr><th>Pending</th><th>Delivered</th><th>Dead letters</th></tr>
      <tr><td>${r.body?.reconcile?.pending || 0}</td><td>${r.body?.reconcile?.delivered || 0}</td><td>${r.body?.reconcile?.dead || 0}</td></tr></table>`) +
    card("Sync jobs", `<table><tr><th>ID</th><th>Entity</th><th>Event</th><th>Status</th><th>Attempts</th><th>Error</th></tr>` +
      (r.body?.jobs || []).map((j) => `<tr><td class="mono">${short(j.id, 10)}</td><td class="mono">${esc(j.entity_type)}:${short(j.entity_id, 8)}</td><td class="mono">${esc(j.event_type)}</td><td>${pill(j.status, j.status)}</td><td>${j.attempts || 0}</td><td class="muted">${esc(j.last_error || "")}</td></tr>`).join("") + `</table>`);
}

// ---------- audit ----------
async function loadAudit() {
  const el = $("#tab-audit");
  const r = await api("/api/audit-events");
  el.innerHTML = card(`Audit trail (${r.body?.events?.length || 0})`, `<table><tr><th>Action</th><th>Actor</th><th>Target</th><th>Hash</th><th>When</th></tr>` +
    (r.body?.events || []).map((e) => `<tr><td class="mono">${esc(e.action)}</td><td class="mono">${esc(e.actor_id || "")}</td><td class="mono">${esc(e.target_type || "")}:${short(e.target_id, 8)}</td><td class="mono muted">${esc((e.entry_hash || "").slice(0, 12))}</td><td>${fmt(e.created_at)}</td></tr>`).join("") + `</table>`);
}

// ---------- webhook tester ----------
let WH_LOG = [];
function whAdd(line) { WH_LOG.unshift({ t: new Date().toLocaleTimeString(), line }); WH_LOG = WH_LOG.slice(0, 40); }
async function whSend(events, media) {
  const body = { events };
  if (media) body.media = media;
  const r = await fetch(base + "/webhooks/whatsapp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  whAdd(`→ ${JSON.stringify(events.map((e) => e.type))}: ${r.status} ${JSON.stringify(j)}`);
  renderWhLog();
  return j;
}
function renderWhLog() {
  $("#wh-log").innerHTML = WH_LOG.map((x) => `<div class="muted">[${x.t}]</div><pre class="log">${esc(x.line)}</pre>`).join("");
}
function loadWebhook() {
  const el = $("#tab-webhook");
  el.innerHTML = `<div class="card"><h2>Simulate an inbound WhatsApp customer</h2>
    <p class="muted">Each click sends a real webhook to <code>/webhooks/whatsapp</code> on this deployment. The customer journey runs the same state machine as live traffic.</p>
    <div class="row">
      <div><label>Phone</label><input id="wh-phone" value="263771234567" /></div>
      <div><label>First name</label><input id="wh-fn" value="Tapiwa" /></div>
      <div><label>Surname</label><input id="wh-sn" value="Moyo" /></div>
      <div><label>Outlet code</label><input id="wh-outlet" value="OK-HRE-01" /></div>
    </div>
    <p style="margin-top:8px"><button class="act" onclick="whJourney()">Run full journey: register → consent → outlet → receipt</button>
    <button class="ghost" onclick="whFakeMedia()">Send random photo (→ review)</button>
    <button class="ghost" onclick="whDupReceipt()">Replay same receipt (→ duplicate)</button></p></div>
    <div class="card"><h2>Event log</h2><div id="wh-log"></div></div>
    <div class="card"><h2>Manual event</h2>
      <label>Payload (JSON array of events)</label>
      <textarea id="wh-manual" rows="4">[{"providerMessageId":"m1","phoneUid":"263771234567","type":"message.text","text":"8"}]</textarea>
      <p style="margin-top:8px"><button class="act" onclick="whManual()">Send</button></p></div>`;
  renderWhLog();
}
function whPhone() { return $("#wh-phone").value.trim(); }
function receiptFacts(receiptNo) {
  return { outlet: $("#wh-outlet").value.trim(), date: new Date().toISOString(), receiptNo, total: 12.5, currency: "USD", _confidence: 0.95,
    lineItems: [{ description: "ZimSweet Brown Sugar 2kg", quantity: 2, amount: 5 }] };
}
function receiptMarkerBytes(facts) {
  const marker = `WPP_RECEIVED:${btoaUnicode(JSON.stringify(facts))}:`;
  return btoaUnicode(marker); // base64 of the marker string -> server decodes to raw marker bytes
}
function btoaUnicode(s) { return btoa(unescape(encodeURIComponent(s))); }
function jid() { return "w" + Date.now() % 1000000 + Math.floor(Math.random() * 9999); }
async function whJourney() {
  const p = whPhone();
  const steps = [
    "2", `${$("#wh-fn").value.trim()} ${$("#wh-sn").value.trim()}`, "63-1234567F12", "Harare", "yes", $("#wh-outlet").value.trim(),
  ];
  for (let i = 0; i < steps.length; i++) {
    const id = jid();
    await whSend([{ providerMessageId: id, phoneUid: p, type: "message.text", text: steps[i] }]);
  }
  // final step: qualifying receipt image with embedded facts -> QUALIFIED + entry
  const rid = jid();
  const media = { [rid]: receiptMarkerBytes(receiptFacts("R-" + Math.floor(1000 + Math.random() * 9000))) };
  const r = await whSend([{ providerMessageId: rid, phoneUid: p, type: "message.image", text: "" }], media);
  whAdd("→ journey complete. Open Receipts (should be QUALIFIED) / Entries / Draws");
  renderWhLog();
  toast("Journey done — receipt should be QUALIFIED. Check Receipts → Entries → Draws");
}
async function whFakeMedia() {
  const p = whPhone();
  const id = jid();
  await whSend([{ providerMessageId: id, phoneUid: p, type: "message.image", text: "", mediaId: "media_" + id }]);
  toast("Random photo → should land in NEEDS_REVIEW (open Receipts)");
}
async function whDupReceipt() {
  const p = whPhone();
  const a = jid(), b = jid();
  const bytes = receiptMarkerBytes(receiptFacts("R-DUP"));
  await whSend([{ providerMessageId: a, phoneUid: p, type: "message.image", text: "" }], { [a]: bytes });
  await whSend([{ providerMessageId: b, phoneUid: p, type: "message.image", text: "" }], { [b]: bytes });
  toast("Check Receipts — first QUALIFIES, second is DUPLICATE");
}
async function whManual() {
  let events;
  try { events = JSON.parse($("#wh-manual").value); } catch { return toast("invalid JSON", true); }
  await whSend(events);
}

// ---------- boot ----------
function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").textContent = `${ME?.name || ME?.email || ""} · ${(ME?.roles || []).join(", ")}`;
  renderLoggedOutViews();
  switchTab("dashboard");
}
function boot() {
  if (TOKEN) {
    loadMe().then(() => (ME ? enterApp() : logout()));
  } else {
    $("#login").classList.remove("hidden");
  }
}
$("#login-btn").onclick = doLogin;
$("#login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#logout").onclick = logout;
$$("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
boot();
window.createCampaign = createCampaign; window.openVersion = openVersion; window.createVersion = createVersion;
window.addOutlet = addOutlet; window.addProduct = addProduct;
window.openReview = openReview; window.submitReview = submitReview;
window.freezeDraw = freezeDraw; window.runDraw = runDraw;
window.whJourney = whJourney; window.whFakeMedia = whFakeMedia; window.whDupReceipt = whDupReceipt; window.whManual = whManual;