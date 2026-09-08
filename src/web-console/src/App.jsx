import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.js";
import { Desk } from "./desk/Desk.jsx";
import "./styles.css";

/* ===================== tiny helpers ===================== */
const sc = String;
const fmt = (i) => (i ? new Date(i).toLocaleString() : "—");
const short = (id, n = 12) => (id ? `${String(id).slice(0, n)}…` : "—");
const OWN = { QUALIFIED: "ok", NOT_QUALIFIED: "x", DUPLICATE: "x", NEEDS_REVIEW: "w", ERROR: "x", active: "ok", paused: "w", draft: "m", published: "ok", approved: "ok", executed: "w", frozen: "m", delivered: "ok", dead: "x", pending: "w" };
function Chip({ s }) { const t = OWN[s] || "m"; const c = { ok: ["#0d9488", "rgba(13,148,136,.12)"], w: ["#b45309", "rgba(180,83,9,.12)"], x: ["#b42318", "rgba(180,35,24,.12)"], m: ["#888", "rgba(100,116,139,.12)"] }[t]; return <span className="chip" style={{ color: c[0], background: c[1] }}>{s}</span>; }

/* ===================== login ===================== */
function Login({ onAuthed }) {
  const [email, setEmail] = useState(""); const [pw, setPw] = useState("");
  const [mfa, setMfa] = useState(null); const [code, setCode] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);

  // P1-04: two-step MFA — password first, then the 6-digit code when the
  // account has MFA enabled (server replies pendingMfa + userId, and
  // /api/login/mfa completes the session). The old gate only handled the
  // one-step {token} response and showed "Sign-in failed" for MFA accounts.
  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const r = await api("/api/login", { method: "POST", body: { email, password: pw }, auth: false });
      if (r.data?.pendingMfa) { setMfa(r.data); return; }
      if (r.ok && r.data?.token) { setToken(r.data.token); onAuthed(); }
      else if (r.status === 429) setErr(`Too many attempts — try again in ${r.data?.retryAfter || 30}s.`);
      else setErr(r.data?.error || "Sign-in failed.");
    } finally { setBusy(false); }
  };
  const submitCode = async () => {
    setErr("");
    if (!code.trim()) { setErr("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true);
    try {
      const r = await api("/api/login/mfa", { method: "POST", body: { userId: mfa.userId, code: code.trim() }, auth: false });
      if (r.ok && r.data?.token) { setToken(r.data.token); onAuthed(); }
      else setErr(r.data?.error || "That code wasn't accepted.");
    } finally { setBusy(false); }
  };
  const cancelMfa = () => { setMfa(null); setCode(""); setErr(""); };

  if (mfa) return (
    <div className="gate">
      <div className="gate-card frame">
        <div className="overline">WhatsApp Promotion Platform</div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.6 }}>
          Two-factor authentication. {mfa.message || "Enter the 6-digit code from your authenticator app."}
          <span style={{ opacity: 0.75 }}> The code expires in about 5 minutes.</span>
        </div>
        <input className="field" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitCode()} placeholder="6-digit code" inputMode="numeric" autoFocus style={{ width: "100%" }} />
        {err && <div className="notice" style={{ marginTop: 8 }}>{err}</div>}
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={submitCode} disabled={!code.trim() || busy}>Verify code</button>
          <button className="btn ghost" style={{ marginLeft: 8 }} onClick={cancelMfa} disabled={busy}>Back</button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="gate">
      <div className="gate-card frame">
        <div className="overline">WhatsApp Promotion Platform</div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.6 }}>Sign in with your operator account.</div>
        <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoFocus style={{ width: "100%" }} />
        <input className="field" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Password" style={{ width: "100%", marginTop: 6 }} />
        {err && <div className="notice" style={{ marginTop: 8 }}>{err}</div>}
        <div style={{ marginTop: 14 }}><button className="btn primary" onClick={submit} disabled={!email || !pw || busy}>Sign in</button></div>
      </div>
    </div>
  );
}

/* ===================== dashboard ===================== */
function Dashboard() {
  const [m, setM] = useState(null);
  useEffect(() => { api("/api/metrics").then((r) => r.ok && setM(r.data)); }, []);
  if (!m) return <div className="promo-page"><div className="promo-card note">Loading…</div></div>;
  const r = m.receipts || {};
  const stats = [
    [m.campaigns?.active || 0, "Active campaigns"],
    [r.NEEDS_REVIEW || 0, "Receipts to review"],
    [r.QUALIFIED || 0, "Qualified receipts"],
    [r.DUPLICATE || 0, "Duplicates blocked"],
    [m.entries || 0, "Draw entries"],
    [m.participants || 0, "Participants"],
  ];
  return (
    <div className="promo-page">
      <div className="promo-card">
        <div className="overline" style={{ marginBottom: 10 }}>Platform status</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {stats.map(([v, l]) => <div key={l}><div className="mono" style={{ fontSize: 24, fontWeight: 600 }}>{v}</div><div className="label" style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div></div>)}
        </div>
        <div className="spacer" />
        <div className="row">
          {[["Transport", m.transport?.provider], ["Linked", m.transport?.ready ? "yes" : "no"], ["Linked as", m.transport?.me || "—"], ["Messages", m.messages || 0], ["Open threads", m.threads?.open || 0], ["Needs reply", m.threads?.needsReply || 0], ["Model spend", `$${Number(m.usage?.month_usd || 0).toFixed(2)}`]].map(([k, v]) => (
            <div className="col" key={k}><div className="lab">{k}</div><div className="note">{v}</div></div>))}
        </div>
      </div>
      <div className="promo-card"><h4 style={{ marginBottom: 6 }}>Recent activity</h4>
        {(m.activity || []).slice(0, 8).map((a, i) => (
          <div key={i} className="sub" style={{ padding: "3px 0" }}>[{fmt(a.created_at)}] {a.summary}</div>))}
        {(m.activity || []).length === 0 && <div className="empty">No activity yet — run a brief or Test a Customer.</div>}
      </div>
    </div>
  );
}

/* ===================== campaigns ===================== */
function Campaigns() {
  const [rows, setRows] = useState([]); const refresh = () => api("/api/campaigns").then((r) => r.ok && setRows(r.data?.campaigns || []));
  useEffect(refresh, []);
  const [f, setF] = useState({});
  const create = async () => {
    if (!f.code || !f.start_at || !f.end_at) return;
    const r = await api("/api/campaigns", { method: "POST", body: { code: f.code, name: f.name, start_at: f.start_at, end_at: f.end_at } });
    if (r.status === 201) { const v = await api(`/api/campaigns/${r.data.id}/versions`, { method: "POST", body: { content: {}, flags: {}, rules: { products: [{ sku: "ZSB-2KG", pack_weight_kg: 2 }], min_packs: 2, min_total_qty_kg: 4 } } }); if (v.status === 201) await api(`/api/campaigns/${r.data.id}/versions/${v.data.versionId}/activate`, { method: "POST", body: {} }); refresh(); }
  };
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>New campaign</h4>
        <div className="row">
          {[["code", "Code", "SUGAR-2026"], ["name", "Name"], ["start_at", "Start (ISO)", "2026-09-01T00:00:00Z"], ["end_at", "End (ISO)", "2026-11-30T23:59:59Z"]].map(([k, l, ph]) =>
            <div className="col" key={k}><div className="lab">{l}</div><input className="field" value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></div>)}
        </div>
        <div className="spacer" /><button className="btn" onClick={create}>Create and activate</button>
      </div>
      <div className="promo-card"><h4>All campaigns</h4>
        <table className="promo-table"><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Start</th><th>End</th></tr></thead><tbody>
          {rows.map((c) => <tr key={c.id}><td className="mono">{sc(c.code)}</td><td>{sc(c.name)}</td><td><Chip s={c.status} /></td><td className="sub">{fmt(c.start_at)}</td><td className="sub">{fmt(c.end_at)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

/* ===================== outlets / products ===================== */
function Outlets() {
  const [rows, setRows] = useState([]); const refresh = () => api("/api/outlets").then((r) => r.ok && setRows(r.data?.outlets || []));
  useEffect(refresh, []);
  const [f, setF] = useState({}); const add = async () => {
    if (!f.outlet_code || !f.retailer || !f.town || !f.province) return;
    const r = await api("/api/outlets", { method: "POST", body: f }); if (r.status === 201) { setF({}); refresh(); }
  };
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Add outlet</h4>
        <div className="row">
          {[["outlet_code", "Code", "OK-HRE-03"], ["retailer", "Retailer"], ["branch", "Branch"], ["town", "Town"], ["province", "Province"]].map(([k, l, ph]) =>
            <div className="col" key={k}><div className="lab">{l}</div><input className="field" value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></div>)}
        </div>
        <div className="spacer" /><button className="btn" onClick={add}>Add outlet</button>
      </div>
      <div className="promo-card"><h4>Outlets ({rows.length})</h4>
        <table className="promo-table"><thead><tr><th>Code</th><th>Retailer</th><th>Branch</th><th>Town</th><th>Province</th></tr></thead><tbody>
          {rows.map((o) => <tr key={o.id}><td className="mono">{sc(o.outlet_code)}</td><td>{sc(o.retailer)}</td><td>{sc(o.branch)}</td><td>{sc(o.town)}</td><td>{sc(o.province)}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}
function Products() {
  const [rows, setRows] = useState([]); const refresh = () => api("/api/products").then((r) => r.ok && setRows(r.data?.products || []));
  useEffect(refresh, []);
  const [f, setF] = useState({ pack_weight_kg: 2 }); const add = async () => {
    if (!f.sku || !f.name) return;
    const r = await api("/api/products", { method: "POST", body: { ...f, pack_weight_kg: Number(f.pack_weight_kg) } }); if (r.status === 201) { setF({ pack_weight_kg: 2 }); refresh(); }
  };
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Add product</h4>
        <div className="row">
          {[["sku", "SKU"], ["brand", "Brand"], ["name", "Name"]].map(([k, l]) => <div className="col" key={k}><div className="lab">{l}</div><input className="field" value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>)}
          <div className="col"><div className="lab">Pack weight (kg)</div><input className="field" type="number" step="0.1" value={f.pack_weight_kg} onChange={(e) => setF({ ...f, pack_weight_kg: e.target.value })} /></div>
        </div>
        <div className="spacer" /><button className="btn" onClick={add}>Add product</button>
      </div>
      <div className="promo-card"><h4>Products ({rows.length})</h4>
        <table className="promo-table"><thead><tr><th>SKU</th><th>Brand</th><th>Name</th><th>Pack kg</th></tr></thead><tbody>
          {rows.map((p) => <tr key={p.id}><td className="mono">{sc(p.sku)}</td><td>{sc(p.brand)}</td><td>{sc(p.name)}</td><td>{p.pack_weight_kg}</td></tr>)}
        </tbody></table>
      </div>
    </div>
  );
}

/* ===================== receipts ===================== */
function Receipts() {
  const [rows, setRows] = useState([]); const [rev, setRev] = useState(null); const refresh = () => api("/api/receipts").then((r) => r.ok && setRows(r.data?.receipts || []));
  useEffect(refresh, []);
  const [decision, setDecision] = useState("QUALIFIED"); const [reason, setReason] = useState("reviewer_confirmed");
  if (rev) {
    const x = rev.receipt, val = rev.validation?.[0];
    const submit = async () => {
      const r = await api(`/api/receipts/${x.id}/reviews`, { method: "POST", body: { decision, reason_code: reason, note: "console" } });
      if (r.ok) { setRev(null); refresh(); }
    };
    return (
      <div className="promo-page">
        <div className="promo-card"><h4>Review receipt {short(x.id, 14)}</h4>
          <div className="row">
            <div className="col"><div className="lab">Confidence</div><div className="note">{Math.round((val?.confidence || 0) * 100)}%</div></div>
            <div className="col"><div className="lab">Status</div><div><Chip s={x.status} /></div></div>
            <div className="col"><div className="lab">Outlet</div><div className="mono">{sc(x.selected_outlet_id || "—")}</div></div>
          </div>
          <div className="spacer" />
          <pre className="mono" style={{ fontSize: 11, background: "var(--bg)", padding: 10, borderRadius: 8, overflow: "auto" }}>{val ? JSON.stringify(JSON.parse(val.facts_json || "null"), null, 1) : "no facts"}</pre>
          <div className="spacer" />
          <div className="row">
            <div className="col"><div className="lab">Decision</div>
              <select className="field" value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="QUALIFIED">Qualify — create the entry</option>
                <option value="NOT_QUALIFIED">Reject</option><option value="DUPLICATE">Duplicate</option><option value="REQUIRES_REUPLOAD">Re-upload</option>
              </select></div>
            <div className="col"><div className="lab">Reason code</div><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div className="spacer" />
          </div>
          <div className="spacer" /><button className="btn" onClick={submit}>Apply decision</button> <button className="btn ghost" onClick={() => setRev(null)}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Receipts ({rows.length})</h4>
        <table className="promo-table"><thead><tr><th>ID</th><th>Status</th><th>Reason</th><th>Created</th><th></th></tr></thead><tbody>
          {rows.map((x) => <tr key={x.id}><td className="mono">{short(x.id, 14)}</td><td><Chip s={x.status} /></td><td className="sub">{sc(x.reason_code || "")}</td><td className="sub">{fmt(x.created_at)}</td>
            <td className="actions">{x.status === "NEEDS_REVIEW" ? <button className="btn small ghost" onClick={() => api(`/api/receipts/${x.id}`).then((r) => r.ok && setRev(r.data))}>Review</button> : "—"}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No receipts yet — Test a Customer.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

/* ===================== entries ===================== */
function Entries() {
  const [rows, setRows] = useState([]); useEffect(() => { api("/api/entries").then((r) => r.ok && setRows(r.data?.entries || [])); }, []);
  return (
    <div className="promo-page"><div className="promo-card"><h4>Qualified entries ({rows.length})</h4>
      <table className="promo-table"><thead><tr><th>ID</th><th>Period</th><th>Entry #</th><th>Status</th><th>Created</th></tr></thead><tbody>
        {rows.map((e) => <tr key={e.id}><td className="mono">{short(e.id, 12)}</td><td className="mono">{sc(e.draw_period)}</td><td>{e.entry_no}</td><td><Chip s={e.status} /></td><td className="sub">{fmt(e.created_at)}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No entries yet — qualify a receipt.</div></td></tr>}
      </tbody></table>
    </div></div>
  );
}

/* ===================== draws ===================== */
function Draws() {
  const [entries, setEntries] = useState([]); const [draws, setDraws] = useState([]); const [period, setPeriod] = useState("");
  const refresh = () => { api("/api/entries").then((r) => r.ok && setEntries(r.data?.entries || [])); api("/api/draws").then((r) => r.ok && setDraws(r.data?.draws || [])); };
  useEffect(refresh, []);
  const periods = {}; entries.forEach((e) => { periods[e.draw_period] = (periods[e.draw_period] || 0) + 1; });
  const act = async (id, action) => { const r = await api(`/api/draws/${id}/${action}`, { method: "POST", body: {} }); refresh(); };
  const freeze = async () => { if (!period) return; await api("/api/draws", { method: "POST", body: { draw_period: period } }); refresh(); };
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Run a draw</h4>
        <div className="row">
          <div className="col"><div className="lab">Period (from entries)</div>
            <select className="field" value={period} onChange={(e) => setPeriod(e.target.value)}><option value="">— choose —</option>
              {Object.entries(periods).map(([p, n]) => <option key={p} value={p}>{p} ({n} entries)</option>)}</select></div>
          <button className="btn" onClick={freeze}>Freeze candidates</button>
        </div>
      </div>
      <div className="promo-card"><h4>Draws ({draws.length})</h4>
        <table className="promo-table"><thead><tr><th>Period</th><th>Status</th><th>Snapshot</th><th>Output</th><th></th></tr></thead><tbody>
          {draws.map((d) => <tr key={d.id}><td className="mono">{sc(d.draw_period)}</td><td><Chip s={d.status} /></td><td className="mono sub">{short(d.snapshot_hash, 10)}</td><td className="mono sub">{d.output_hash ? short(d.output_hash, 10) : "—"}</td>
            <td className="actions">
              {d.status === "frozen" && <button className="btn small ghost" onClick={() => act(d.id, "execute")}>Execute</button>}
              {d.status === "executed" && <button className="btn small ghost" onClick={() => act(d.id, "approve")}>Approve</button>}
              {d.status === "approved" && <button className="btn small ghost" onClick={() => act(d.id, "publish")}>Publish winners</button>}
            </td></tr>)}
          {draws.length === 0 && <tr><td colSpan={5}><div className="empty">No draws yet.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

/* ===================== CRM / audit ===================== */
function Crm() {
  const [d, setD] = useState(null); useEffect(() => { api("/api/crm-sync").then((r) => r.ok && setD(r.data)); }, []);
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Reconciliation</h4>
        {d && <div className="row">{[["pending", "Pending"], ["delivered", "Delivered"], ["dead", "Dead letters"]].map(([k, l]) => <div className="col" key={k}><div className="lab">{l}</div><div className="note" style={{ fontSize: 20 }}>{d.reconcile?.[k] || 0}</div></div>)}</div>}
        <div className="spacer" /><table className="promo-table"><thead><tr><th>Entity</th><th>Event</th><th>Status</th><th>Attempts</th></tr></thead><tbody>
          {(d?.jobs || []).map((j) => <tr key={j.id}><td className="mono">{sc(j.entity_type)} {short(j.entity_id, 8)}</td><td className="mono">{sc(j.event_type)}</td><td><Chip s={j.status} /></td><td>{j.attempts || 0}</td></tr>)}
          {(d?.jobs || []).length === 0 && <tr><td colSpan={4}><div className="empty">No CRM events yet.</div></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}
function AuditView() {
  const [rows, setRows] = useState([]); useEffect(() => { api("/api/audit-events").then((r) => r.ok && setRows(r.data?.events || [])); }, []);
  return (
    <div className="promo-page"><div className="promo-card"><h4>Audit trail (append-only, hash-chained)</h4>
      <table className="promo-table"><thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>Hash</th><th>When</th></tr></thead><tbody>
        {rows.map((e) => <tr key={e.id}><td className="mono">{sc(e.action)}</td><td className="mono sub">{sc(e.actor_id || "")}</td><td className="mono sub">{sc(e.target_type || "")} {short(e.target_id, 8)}</td><td className="mono sub">{short(e.entry_hash, 10)}</td><td className="sub">{fmt(e.created_at)}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No audit events yet.</div></td></tr>}
      </tbody></table>
    </div></div>
  );
}

/* ===================== test a customer ===================== */
function TestCustomer() {
  const [phone, setPhone] = useState("263771234567"); const [fn, setFn] = useState("Tapiwa"); const [sn, setSn] = useState("Moyo"); const [outlet, setOutlet] = useState("OK-HRE-01");
  const [log, setLog] = useState([]);
  // P1-06: functional state update — the old closure captured `log` from the
  // FIRST render and replaced it, so the event log only ever showed (and
  // clobbered) the latest event. This appends with a bounded window.
  const push = (l) => setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${l}`, ...prev].slice(0, 25));
  const jid = () => "w" + Date.now() % 1000000 + Math.floor(Math.random() * 9999);
  const facts = (no) => ({ outlet, date: new Date().toISOString(), receiptNo: no, total: 12.5, currency: "USD", _confidence: 0.95, lineItems: [{ description: "ZimSweet Brown Sugar 2kg", quantity: 2, amount: 5 }] });
  const marker = (no) => `WPP_RECEIVED:${btoa(unescape(encodeURIComponent(JSON.stringify(facts(no)))))}:`;
  async function send(events, media) {
    // P1-06: media must sit under the server's `media` map — the server reads
    // payload.media[providerMessageId]. Spreading it into the body top-level
    // produced a 200 but the receipt had no bytes (zero confidence -> review),
    // which is exactly the false confidence this tool used to give.
    const r = await api("/webhooks/whatsapp", { method: "POST", body: { events, media: media || {} }, auth: false });
    push(`${events.map((e) => e.type).join(",")} → HTTP ${r.status} ${JSON.stringify(r.data || {})}`);
    return r;
  }
  // P1-06: verify the ACTUAL outcome from the API (receipt status + entry),
  // not just the webhook's HTTP 200.
  const verify = async (label) => {
    const r = await api("/api/receipts");
    const r2 = await api("/api/entries");
    const rec = (r.data?.receipts || [])[0];
    const ent = rec ? (r2.data?.entries || []).find((e) => e.receipt_id === rec.id) : null;
    push(`${label}: receipt ${rec ? `${rec.status}${rec.reason_code ? ` · ${rec.reason_code}` : ""}` : "(none still)"}${ent ? ` → entry ${short(ent.id, 8)} created` : (rec && rec.status === "QUALIFIED" ? " ⚠ entry missing" : "")}`);
  };
  const journey = async () => {
    // P1-01: menu numbering — 1 = Register (the old leading "2" is now ENTER).
    for (const t of ["1", `${fn} ${sn}`, "63-1234567F12", "Harare", "yes", outlet]) await send([{ providerMessageId: jid(), phoneUid: phone, type: "message.text", text: t }]);
    const id = jid();
    await send([{ providerMessageId: id, phoneUid: phone, type: "message.image", text: "" }], { [id]: btoa(marker("R-" + Math.floor(1000 + Math.random() * 9000))) });
    await verify("journey result");
  };
  const dup = async () => {
    const a = jid(), b = jid(), bytes = btoa(marker("R-DUP"));
    await send([{ providerMessageId: a, phoneUid: phone, type: "message.image", text: "" }], { [a]: bytes });
    await send([{ providerMessageId: b, phoneUid: phone, type: "message.image", text: "" }], { [b]: bytes });
    await verify("duplicate check");
  };
  return (
    <div className="promo-page">
      <div className="promo-card"><h4>Simulate a WhatsApp customer</h4>
        <p className="note">Sends real webhooks to this deployment — the same state machine live customers use.</p>
        <div className="row">
          {[["phone", "Phone"], ["fn", "First name"], ["sn", "Surname"], ["outlet", "Outlet code"]].map(([k, l]) => <div className="col" key={k}><div className="lab">{l}</div><input className="field" value={{ phone, fn, sn, outlet }[k]} onChange={(e) => ({ phone: setPhone, fn: setFn, sn: setSn, outlet: setOutlet })[k](e.target.value)} /></div>)}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={journey}>Full journey: register → consent → receipt</button>
        <button className="btn ghost" style={{ marginLeft: 8 }} onClick={() => send([{ providerMessageId: jid(), phoneUid: phone, type: "message.image", text: "" }])}>Send a random photo</button>
        <button className="btn ghost" style={{ marginLeft: 8 }} onClick={dup}>Same receipt twice → duplicate</button>
      </div>
      <div className="promo-card"><h4>Event log</h4>
        {log.map((l, i) => <div key={i} className="mono sub" style={{ padding: "3px 0", whiteSpace: "pre-wrap" }}>{l}</div>)}
        {log.length === 0 && <div className="empty">No events yet.</div>}
      </div>
    </div>
  );
}

/* ===================== shell ===================== */
const TABS = [["desk", "Desk"], ["dash", "Dashboard"], ["campaigns", "Campaigns"], ["outlets", "Outlets"], ["products", "Products"], ["receipts", "Receipts"], ["entries", "Entries"], ["draws", "Draws"], ["crm", "CRM"], ["audit", "Audit"], ["test", "Test a Customer"]];
const VIEWS = { dash: Dashboard, campaigns: Campaigns, outlets: Outlets, products: Products, receipts: Receipts, entries: Entries, draws: Draws, crm: Crm, audit: AuditView, test: TestCustomer };

export function App() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("desk");
  // onAuthed: after a successful login, resolve /api/whoami with retry so a
  // transient failure never strands a valid session on the login screen.
  const authed = () => {
    const tryWhoami = async (n) => {
      const r = await api("/api/whoami");
      if (r.ok) { setMe(r.data); return; }
      if (n < 3) { await new Promise((s) => setTimeout(s, 600 * (n + 1))); return tryWhoami(n + 1); }
      setToken("");
    };
    tryWhoami(0);
  };
  useEffect(() => {
    if (!getToken()) return;
    api("/api/whoami").then((r) => { if (r.ok) setMe(r.data); else setToken(""); });
  }, []);
  if (!me) return <Login onAuthed={authed} />;
  const View = VIEWS[tab];
  return (
    <div className="promo">
      <div className="promo-tabs">
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        <button onClick={() => { api("/api/logout", { method: "POST" }); setToken(""); setMe(null); }}>Sign out</button>
      </div>
      {tab === "desk" ? <Desk /> : <div className="promo"><View /></div>}
    </div>
  );
}