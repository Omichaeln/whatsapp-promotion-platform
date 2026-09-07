import { useEffect, useState } from "react";
import { api, setUnauthorised } from "./api.js";
import "./styles.css";

// ---------- helpers ------------------------------------------------------------
const esc = String;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const short = (id, n = 10) => (id ? `${String(id).slice(0, n)}…` : "—");
const OWN = { QUALIFIED: "ok", NOT_QUALIFIED: "danger", DUPLICATE: "danger", NEEDS_REVIEW: "warn", ERROR: "danger", active: "ok", paused: "warn", draft: "muted", published: "ok", approved: "ok", executed: "warn", frozen: "muted", delivered: "ok", dead: "danger", pending: "warn" };
const DOT = { ok: "#0d9488", warn: "#b7791f", danger: "#b42318", muted: "#7b8aa0" };
const Own = (s) => (OWN[s] || "muted");
function Chip({ label, tone }) { return <span className="chip"><span className="dot" style={{ background: DOT[tone] }} />{esc(label)}</span>; }
function Toast({ msg, err }) { return <div className={`toast${err ? " err" : ""}`}>{msg}</div>; }
let pushToast = () => {};
function setPush(fn) { pushToast = fn; }

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

// ---------- dashboard ------------------------------------------------------------
function Dashboard({ go }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    Promise.all([api("/api/campaigns"), api("/api/receipts"), api("/api/entries"), api("/api/crm-sync")]).then(([c, r, e, crm]) =>
      setData({ camps: c.body?.campaigns || [], recs: r.body?.receipts || [], entries: e.body?.entries || [], crm: crm.body?.reconcile || {} }));
  }, []);
  if (!data) return <div className="page"><div className="loader">Loading…</div></div>;
  const count = (s) => data.recs.filter((x) => x.status === s).length;
  const m = [
    { value: data.camps.filter((x) => x.status === "active").length, label: "Active campaigns" },
    { value: count("NEEDS_REVIEW"), label: "Receipts to review", tone: "warn" },
    { value: count("QUALIFIED"), label: "Qualified receipts", tone: "ok" },
    { value: count("DUPLICATE"), label: "Duplicates blocked", tone: "danger" },
    { value: data.entries.length, label: "Draw entries" },
    { value: data.crm.pending || 0, label: "CRM pending" },
  ];
  return (
    <div className="page">
      <h2>Dashboard</h2>
      <div className="card dim">
        <div className="row" style={{ display: "flex", gap: 8 }}>
          {m.map((x) => <div key={x.label} className="metric"><div className="big">{x.value}</div><div className="label">{x.label}</div></div>)}
        </div>
      </div>
      <div className="card"><h3>Campaigns</h3>
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Start</th><th>End</th></tr></thead><tbody>
          {data.camps.map((c) => <tr key={c.id}><td className="mono">{esc(c.code)}</td><td>{esc(c.name)}</td><td><Chip label={c.status} tone={Own(c.status)} /></td><td className="sub">{fmt(c.start_at)}</td><td className="sub">{fmt(c.end_at)}</td></tr>)}
        </tbody></table>
      </div>
      <div className="card dim"><p className="muted" style={{ fontSize: 13 }}>
        <b>How to test everything:</b> open <b>Test a Customer</b> to simulate a shopper
        (register → consent → outlet → receipt). Review the result under <b>Receipts</b>.
        Qualifying receipts appear under <b>Entries</b>. Finally run the draw under <b>Draws</b>.
      </p></div>
    </div>
  );
}

// ---------- campaigns --------------------------------------------------------------
function Campaigns() {
  const [camps, setCamps] = useState(null);
  const refresh = () => api("/api/campaigns").then((r) => setCamps(r.body?.campaigns || []));
  useEffect(() => { refresh(); }, []);
  const [f, setF] = useState({});
  const create = async () => {
    if (!f.code || !f.start_at || !f.end_at) return pushToast("Code, start and end (ISO) required", true);
    const r = await api("/api/campaigns", { method: "POST", body: { code: f.code, name: f.name, start_at: f.start_at, end_at: f.end_at } });
    if (r.status === 201) {
      const rules = { products: [{ sku: "ZSB-2KG", pack_weight_kg: 2 }], min_packs: 2, min_total_qty_kg: 4, weekly_caps: { participant: 5 } };
      const v = await api(`/api/campaigns/${r.body.id}/versions`, { method: "POST", body: { content: {}, flags: {}, rules } });
      if (v.status === 201) await api(`/api/campaigns/${r.body.id}/versions/${v.body.versionId}/activate`, { method: "POST", body: {} });
      pushToast("Campaign created and activated"); refresh();
    } else pushToast(r.body?.error || "Create failed", true);
  };
  return (
    <div className="page"><h2>Campaigns</h2>
      <div className="card"><h3>New campaign</h3>
        <div className="row">
          <div className="field"><label>Code</label><input value={f.code || ""} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="SUGAR-2026" /></div>
          <div className="field"><label>Name</label><input value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Brown Sugar Promo" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Start (ISO)</label><input value={f.start_at || ""} onChange={(e) => setF({ ...f, start_at: e.target.value })} placeholder="2026-09-01T00:00:00Z" /></div>
          <div className="field"><label>End (ISO)</label><input value={f.end_at || ""} onChange={(e) => setF({ ...f, end_at: e.target.value })} placeholder="2026-11-30T23:59:59Z" /></div>
        </div>
        <p style={{ marginTop: 8 }}><button className="btn" onClick={create}>Create and activate</button></p>
      </div>
      <div className="card"><h3>All campaigns</h3>
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Start</th><th>End</th></tr></thead><tbody>
          {(camps || []).map((c) => <tr key={c.id}><td className="mono">{esc(c.code)}</td><td>{esc(c.name)}</td><td><Chip label={c.status} tone={Own(c.status)} /></td><td className="sub">{fmt(c.start_at)}</td><td className="sub">{fmt(c.end_at)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- outlets -----------------------------------------------------------------
function Outlets() {
  const [rows, setRows] = useState(null);
  const refresh = () => api("/api/outlets").then((r) => setRows(r.body?.outlets || []));
  useEffect(() => { refresh(); }, []);
  const [f, setF] = useState({});
  const add = async () => {
    if (!f.outlet_code || !f.retailer || !f.town || !f.province) return pushToast("Code, retailer, town, province required", true);
    const r = await api("/api/outlets", { method: "POST", body: f });
    r.status === 201 ? (pushToast("Outlet added"), refresh()) : pushToast(r.body?.error || "Failed", true);
  };
  return (
    <div className="page"><h2>Participating outlets</h2>
      <div className="card"><h3>Add outlet</h3>
        <div className="row">
          {[["outlet_code", "Code", "OK-HRE-03"], ["retailer", "Retailer", "OK Mart"], ["branch", "Branch", "Borrowdale"], ["town", "Town", "Harare"], ["province", "Province", "Harare"]].map(([k, label, ph]) =>
            <div className="field" key={k}><label>{label}</label><input value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></div>)}
        </div>
        <p style={{ marginTop: 8 }}><button className="btn" onClick={add}>Add outlet</button></p>
      </div>
      <div className="card"><h3>{rows ? `Outlets (${rows.length})` : "Outlets"}</h3>
        <table className="table"><thead><tr><th>Code</th><th>Retailer</th><th>Branch</th><th>Town</th><th>Province</th></tr></thead><tbody>
          {(rows || []).map((o) => <tr key={o.id}><td className="mono">{esc(o.outlet_code)}</td><td>{esc(o.retailer)}</td><td>{esc(o.branch)}</td><td>{esc(o.town)}</td><td>{esc(o.province)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- products -----------------------------------------------------------------
function Products() {
  const [rows, setRows] = useState(null);
  const refresh = () => api("/api/products").then((r) => setRows(r.body?.products || []));
  useEffect(() => { refresh(); }, []);
  const [f, setF] = useState({ pack_weight_kg: 2 });
  const add = async () => {
    if (!f.sku || !f.name) return pushToast("SKU and name required", true);
    const r = await api("/api/products", { method: "POST", body: { ...f, pack_weight_kg: Number(f.pack_weight_kg) } });
    r.status === 201 ? (pushToast("Product added"), refresh()) : pushToast(r.body?.error || "Failed", true);
  };
  return (
    <div className="page"><h2>Qualifying products</h2>
      <div className="card"><h3>Add product</h3>
        <div className="row">
          {[["sku", "SKU", "ZSB-2KG"], ["brand", "Brand", "ZimSweet"], ["name", "Name", "Brown Sugar 2kg"]].map(([k, label, ph]) =>
            <div className="field" key={k}><label>{label}</label><input value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></div>)}
          <div className="field"><label>Pack weight (kg)</label><input type="number" step="0.1" value={f.pack_weight_kg} onChange={(e) => setF({ ...f, pack_weight_kg: e.target.value })} /></div>
        </div>
        <p style={{ marginTop: 8 }}><button className="btn" onClick={add}>Add product</button></p>
      </div>
      <div className="card"><h3>{rows ? `Products (${rows.length})` : "Products"}</h3>
        <table className="table"><thead><tr><th>SKU</th><th>Brand</th><th>Name</th><th>Pack kg</th></tr></thead><tbody>
          {(rows || []).map((p) => <tr key={p.id}><td className="mono">{esc(p.sku)}</td><td>{esc(p.brand)}</td><td>{esc(p.name)}</td><td>{p.pack_weight_kg}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- receipts + review ---------------------------------------------------------
function Receipts({ go }) {
  const [rows, setRows] = useState(null);
  const [review, setReview] = useState(null);
  const refresh = () => api("/api/receipts").then((r) => setRows(r.body?.receipts || []));
  useEffect(() => { refresh(); }, []);
  const openReview = async (id) => {
    const r = await api(`/api/receipts/${id}`);
    if (r.status === 200) setReview(r.body);
  };
  if (review) {
    const x = review.receipt, val = review.validation?.[0];
    const [decision, setDecision] = useState("QUALIFIED");
    const [reason, setReason] = useState("reviewer_confirmed");
    const submit = async () => {
      const r = await api(`/api/receipts/${x.id}/reviews`, { method: "POST", body: { decision, reason_code: reason, note: "console review" } });
      r.status === 200 ? (pushToast(`Decision applied: ${r.body.decision}`), setReview(null), refresh()) : pushToast(r.body?.error || "Failed", true);
    };
    return (
      <div className="page"><h2>Review receipt</h2>
        <div className="card"><h3>Extracted evidence</h3>
          <table className="table">
            <tbody>
              <tr><td>Confidence</td><td>{Math.round((val?.confidence || 0) * 100)}%</td><td>Status</td><td><Chip label={x.status} tone={Own(x.status)} /></td></tr>
              <tr><td>Outlet selected</td><td className="mono">{esc(x.selected_outlet_id || "—")}</td><td>Extraction</td><td className="mono">{esc((val?.extractor_provider || "") + " · " + (val?.extractor_version || ""))}</td></tr>
            </tbody>
          </table>
          <pre className="mono" style={{ fontSize: 12, marginTop: 8 }}>{JSON.stringify(JSON.parse(val?.facts_json || "null"), null, 1)}</pre>
        </div>
        <div className="card"><h3>Decision</h3>
          <div className="row">
            <div className="field"><label>Decision</label>
              <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="QUALIFIED">Qualify — create the entry</option>
                <option value="NOT_QUALIFIED">Reject — not eligible</option>
                <option value="DUPLICATE">Mark as duplicate</option>
                <option value="REQUIRES_REUPLOAD">Request a re-upload</option>
              </select></div>
            <div className="field"><label>Reason code</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          </div>
          <p style={{ marginTop: 8 }}><button className="btn" onClick={submit}>Apply decision</button>
            <button className="btn ghost" style={{ marginLeft: 8 }} onClick={() => setReview(null)}>Back</button></p>
        </div>
      </div>
    );
  }
  return (
    <div className="page"><h2>Receipts</h2>
      <div className="card"><h3>{rows ? `Receipts (${rows.length}) — review what needs attention` : "Receipts"}</h3>
        <table className="table"><thead><tr><th>ID</th><th>Status</th><th>Reason</th><th>Created</th><th></th></tr></thead><tbody>
          {(rows || []).map((x) => <tr key={x.id}>
            <td className="mono">{short(x.id, 14)}</td>
            <td><Chip label={x.status} tone={Own(x.status)} /></td>
            <td className="sub">{esc(x.reason_code || "")}</td>
            <td className="sub">{fmt(x.created_at)}</td>
            <td className="actions">{x.status === "NEEDS_REVIEW" ? <button className="btn small ghost" onClick={() => openReview(x.id)}>Review</button> : <span className="sub">—</span>}</td>
          </tr>)}
          {(rows || []).length === 0 && <tr><td colSpan={5}><div className="empty">No receipts yet — use <b>Test a Customer</b> to create one.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- entries ----------------------------------------------------------------
function Entries() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api("/api/entries").then((r) => setRows(r.body?.entries || [])); }, []);
  return (
    <div className="page"><h2>Draw entries</h2>
      <div className="card"><h3>{rows ? `Qualified entries (${rows.length})` : "Entries"}</h3>
        <table className="table"><thead><tr><th>ID</th><th>Receipt</th><th>Draw period</th><th>Entry #</th><th>Status</th><th>Created</th></tr></thead><tbody>
          {(rows || []).map((e) => <tr key={e.id}><td className="mono">{short(e.id, 12)}</td><td className="mono">{short(e.receipt_id, 12)}</td><td className="mono">{esc(e.draw_period)}</td><td>{e.entry_no}</td><td><Chip label={e.status} tone={Own(e.status)} /></td><td className="sub">{fmt(e.created_at)}</td></tr>)}
          {(rows || []).length === 0 && <tr><td colSpan={6}><div className="empty">No entries yet. Qualify a receipt to create one.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- draws -----------------------------------------------------------------
function Draws() {
  const [entries, setEntries] = useState(null);
  const [draws, setDraws] = useState(null);
  const refresh = () => { api("/api/entries").then((r) => setEntries(r.body?.entries || [])); api("/api/draws").then((r) => setDraws(r.body?.draws || [])); };
  useEffect(refresh, []);
  const [period, setPeriod] = useState("");
  const periods = (entries || []).reduce((acc, e) => { const p = e.draw_period; if (!acc[p]) acc[p] = 0; acc[p]++; return acc; }, {});
  const freeze = async () => {
    if (!period) return pushToast("Pick a draw period first", true);
    const r = await api("/api/draws", { method: "POST", body: { draw_period: period } });
    r.status === 201 ? (pushToast(`Frozen — ${r.body.count} candidate(s)`), refresh()) : pushToast(r.body?.error || "Freeze failed", true);
  };
  const act = async (id, action) => {
    const r = await api(`/api/draws/${id}/${action}`, { method: "POST", body: {} });
    r.status === 200 ? (pushToast(`${action}ok`), refresh()) : pushToast(r.body?.error || `${action} failed`, true);
  };
  return (
    <div className="page"><h2>Draws</h2>
      <div className="card"><h3>Run a draw</h3>
        <div className="row">
          <div className="field"><label>Draw period (from entries)</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">— choose —</option>
              {Object.entries(periods).map(([p, n]) => <option key={p} value={p}>{p} ({n} entr{ n === 1 ? "y" : "ies" })</option>)}
            </select></div>
          <p style={{ marginTop: 20 }}><button className="btn" onClick={freeze}>Freeze candidates</button></p>
        </div>
      </div>
      <div className="card"><h3>{draws ? `Draws (${draws.length})` : "Draws"}</h3>
        <table className="table"><thead><tr><th>Period</th><th>Status</th><th>Snapshot</th><th>Output</th><th></th></tr></thead><tbody>
          {(draws || []).map((d) => <tr key={d.id}>
            <td className="mono">{esc(d.draw_period)}</td><td><Chip label={d.status} tone={Own(d.status)} /></td>
            <td className="mono sub">{short(d.snapshot_hash, 10)}</td><td className="mono sub">{d.output_hash ? short(d.output_hash, 10) : "—"}</td>
            <td className="actions">
              {d.status === "frozen" && <button className="btn small ghost" onClick={() => act(d.id, "execute")}>Execute</button>}
              {d.status === "executed" && <button className="btn small ghost" onClick={() => act(d.id, "approve")}>Approve</button>}
              {d.status === "approved" && <button className="btn small ghost" onClick={() => act(d.id, "publish")}>Publish winners</button>}
            </td>
          </tr>)}
          {(draws || []).length === 0 && <tr><td colSpan={5}><div className="empty">No draws yet — freeze a period to start.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- CRM + audit ---------------------------------------------------------------
function Crm() {
  const [d, setD] = useState(null);
  useEffect(() => { api("/api/crm-sync").then((r) => setD(r.body)); }, []);
  return (
    <div className="page"><h2>CRM sync</h2>
      {d && <div className="card"><h3>Reconciliation</h3>
        <div className="row" style={{ display: "flex", gap: 8 }}>
          {[["pending", "Pending"], ["delivered", "Delivered"], ["dead", "Dead letters"]].map(([k, label]) => <div className="metric" key={k}><div className="big">{d.reconcile?.[k] || 0}</div><div className="label">{label}</div></div>)}
        </div></div>}
      <div className="card"><h3>{d ? `Sync jobs (${(d.jobs || []).length})` : "Jobs"}</h3>
        <table className="table"><thead><tr><th>Entity</th><th>Event</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead><tbody>
          {(d?.jobs || []).map((j) => <tr key={j.id}><td className="mono">{esc(j.entity_type)} {short(j.entity_id, 8)}</td><td className="mono">{esc(j.event_type)}</td><td><Chip label={j.status} tone={Own(j.status)} /></td><td>{j.attempts || 0}</td><td className="sub">{esc(j.last_error || "")}</td></tr>)}
          {(d?.jobs || []).length === 0 && <tr><td colSpan={5}><div className="empty">No CRM events yet.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api("/api/audit-events").then((r) => setRows(r.body?.events || [])); }, []);
  return (
    <div className="page"><h2>Audit trail</h2>
      <div className="card"><h3>Append-only, hash-chained changes</h3>
        <table className="table"><thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>Hash</th><th>When</th></tr></thead><tbody>
          {(rows || []).map((e) => <tr key={e.id}><td className="mono">{esc(e.action)}</td><td className="mono sub">{esc(e.actor_id || "")}</td><td className="mono sub">{esc(e.target_type || "")} {short(e.target_id, 8)}</td><td className="mono sub">{short(e.entry_hash || "", 10)}</td><td className="sub">{fmt(e.created_at)}</td></tr>)}
          {(rows || []).length === 0 && <tr><td colSpan={5}><div className="empty">No audit events yet.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

// ---------- Test a customer (webhook simulator) ------------------------------------
function CustomerTester() {
  const [phone, setPhone] = useState("263771234567");
  const [fn, setFn] = useState("Tapiwa");
  const [sn, setSn] = useState("Moyo");
  const [outlet, setOutlet] = useState("OK-HRE-01");
  const [log, setLog] = useState([]);
  const add = (line) => setLog([{ t: new Date().toLocaleTimeString(), line }, ...log].slice(0, 30));
  const jid = () => "w" + Date.now() % 1000000 + Math.floor(Math.random() * 9999);
  const facts = (no) => ({ outlet, date: new Date().toISOString(), receiptNo: no, total: 12.5, currency: "USD", _confidence: 0.95, lineItems: [{ description: "ZimSweet Brown Sugar 2kg", quantity: 2, amount: 5 }] });
  const marker = (no) => `WPP_RECEIVED:${b64(JSON.stringify(facts(no)))}:`;
  async function send(events, media) {
    const body = { events };
    if (media) body.media = media;
    const r = await api("/webhooks/whatsapp", { method: "POST", body, auth: false });
    add(`${JSON.stringify(events.map((e) => e.type))} → ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  }
  const journey = async () => {
    const p = phone;
    for (const t of ["2", `${fn} ${sn}`, "63-1234567F12", "Harare", "yes", outlet]) {
      await send([{ providerMessageId: jid(), phoneUid: p, type: "message.text", text: t }]);
    }
    const id = jid();
    await send([{ providerMessageId: id, phoneUid: p, type: "message.image", text: "" }], { [id]: b64(marker("R-" + Math.floor(1000 + Math.random() * 9000))) });
    pushToast("Journey complete — check Receipts (should be QUALIFIED)");
  };
  const fakeMedia = async () => {
    const id = jid();
    await send([{ providerMessageId: id, phoneUid: phone, type: "message.image", text: "" }]);
    pushToast("Random photo → should appear under Receipts as Needs review");
  };
  const dup = async () => {
    const a = jid(), b = jid(), bytes = b64(marker("R-DUP"));
    await send([{ providerMessageId: a, phoneUid: phone, type: "message.image", text: "" }], { [a]: bytes });
    await send([{ providerMessageId: b, phoneUid: phone, type: "message.image", text: "" }], { [b]: bytes });
    pushToast("Same receipt sent twice — second should be Duplicate");
  };
  return (
    <div className="page"><h2>Test a customer in WhatsApp</h2>
      <div className="card"><h3>Simulate the shopper journey</h3>
        <p className="muted" style={{ fontSize: 13 }}>Sends real webhooks to this deployment — the same state machine live customers use.</p>
        <div className="row">
          <div className="field"><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="field"><label>First name</label><input value={fn} onChange={(e) => setFn(e.target.value)} /></div>
          <div className="field"><label>Surname</label><input value={sn} onChange={(e) => setSn(e.target.value)} /></div>
          <div className="field"><label>Outlet code</label><input value={outlet} onChange={(e) => setOutlet(e.target.value)} /></div>
        </div>
        <p style={{ marginTop: 8 }}>
          <button className="btn" onClick={journey}>Run full journey — register, consent, receipt</button>
          <button className="btn ghost" style={{ marginLeft: 8 }} onClick={fakeMedia}>Send a random photo</button>
          <button className="btn ghost" style={{ marginLeft: 8 }} onClick={dup}>Replay the same receipt twice</button>
        </p>
      </div>
      <div className="card"><h3>Live event log</h3>
        {log.length === 0 ? <div className="empty">No events yet.</div> :
          log.map((x, i) => <pre key={i} className="mono" style={{ fontSize: 12, margin: "4px 0" }}>[{x.t}] {x.line}</pre>)}
      </div>
    </div>
  );
}

// ---------- app shell ------------------------------------------------------------------
const TABS = [
  ["dashboard", "Dashboard", Dashboard],
  ["campaigns", "Campaigns", Campaigns],
  ["outlets", "Outlets", Outlets],
  ["products", "Products", Products],
  ["receipts", "Receipts", Receipts],
  ["entries", "Entries", Entries],
  ["draws", "Draws", Draws],
  ["crm", "CRM", Crm],
  ["audit", "Audit", Audit],
  ["test", "Test a Customer", CustomerTester],
];

function Login({ onAuthed }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [err, setErr] = useState("");
  const submit = async () => {
    const r = await api("/api/login", { method: "POST", body: { email, password }, auth: false });
    if (r.status === 200 && r.body?.token) { localStorage.setItem("wpp_token", r.body.token); onAuthed(); }
    else setErr(r.body?.error || "Sign-in failed");
  };
  return (
    <div className="login">
      <div className="brand"><span className="logo">P</span>WhatsApp Promotion Platform</div>
      <p>Sign in to manage campaigns, receipts and draws.</p>
      <div className="field"><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
      <div className="field"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
      {err && <div className="err">{err}</div>}
      <p style={{ marginTop: 12 }}><button className="btn" style={{ width: "100%" }} onClick={submit}>Sign in</button></p>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState("dashboard");
  const [me, setMe] = useState(null);
  const [tokens, setTokens] = useState([]);
  useEffect(() => { setPush((msg, err) => setTokens([...tokens].slice(-3).concat([{ msg, err: !!err }]))); }, [tokens]);
  useEffect(() => {
    const t = localStorage.getItem("wpp_token");
    if (t) api("/api/whoami").then((r) => { if (r.status === 200) setMe(r.body); else localStorage.removeItem("wpp_token"); });
  }, []);
  useEffect(() => { setUnauthorised(() => { setMe(null); }); }, []);
  if (!me) return <><Login onAuthed={async () => { const r = await api("/api/whoami"); if (r.status === 200) setMe(r.body); }} /><div className="toasts">{tokens.map((x, i) => <Toast key={i} {...x} />)}</div></>;
  const active = TABS.find(([k]) => k === tab) || TABS[0];
  const Page = active[2];
  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">P</div>
        <div><h1>WhatsApp Promotion Platform</h1><div className="sub">Operations console</div></div>
        <span className="who">{me?.name || me?.email || ""} · {(me?.roles || []).join(", ")}</span>
        <button className="signout" onClick={() => { localStorage.removeItem("wpp_token"); setMe(null); }}>Sign out</button>
      </header>
      <nav className="nav">
        {TABS.map(([k, label]) => <button key={k} className={k === tab ? "active" : ""} onClick={() => setTab(k)}>{label}</button>)}
      </nav>
      <Page key={tab} go={setTab} />
      <div className="toasts">{tokens.map((x, i) => <Toast key={i} {...x} />)}</div>
    </div>
  );
}