import { useEffect, useState, useCallback } from "react";
import { api, apiBlob, getToken, setToken } from "./api.js";
import { Desk } from "./desk/Desk.jsx";
import "./styles.css";

/* ===================== helpers ===================== */
const fmt = (i) => (i ? new Date(i).toLocaleString() : "—");
const short = (id, n = 12) => (id ? `${String(id).slice(0, n)}…` : "—");
const TONE = { QUALIFIED: "ok", NOT_QUALIFIED: "x", DUPLICATE: "x", REVIEW_REQUIRED: "w", REUPLOAD_REQUIRED: "w", received: "m", processing: "m", delayed: "w", active: "ok", paused: "w", draft: "m", closed: "m", archived: "m", published: "ok", approved: "ok", executed: "w", frozen: "m", executing: "w", voided: "x", delivered: "ok", sent: "ok", read: "ok", pending: "w", retryable_failure: "w", permanent_failure: "x", unknown_outcome: "x", reconciled: "ok", dead: "x", failed: "x", processed: "ok", selected: "m", notified: "w", verified: "ok", accepted: "ok", collected: "ok", expired: "x", replaced: "x", ineligible: "x", declined: "x", disputed: "w", unreachable: "w", open: "w", assigned: "w", decided: "ok", excluded: "x", scheduled: "m", drawn: "ok", critical: "x", warning: "w", info: "m", real: "ok", simulated: "w", configured: "ok", not_configured: "w", unconfigured: "x" };
function Chip({ s }) { const t = TONE[s] || "m"; const c = { ok: ["#0d9488", "rgba(13,148,136,.12)"], w: ["#b45309", "rgba(180,83,9,.12)"], x: ["#b42318", "rgba(180,35,24,.12)"], m: ["#666", "rgba(100,116,139,.12)"] }[t]; return <span className="chip" style={{ color: c[0], background: c[1] }}>{String(s ?? "—")}</span>; }
/** Image behind the staff session: <img> cannot send the bearer header. */
function AuthImg({ src, alt, style }) {
  const [s, set] = useState({ url: null, error: null, loading: true });
  useEffect(() => {
    let live = true, made = null;
    set({ url: null, error: null, loading: true });
    apiBlob(src).then((r) => {
      if (!live) { if (r.url) URL.revokeObjectURL(r.url); return; }
      if (!r.ok) return set({ url: null, error: r.status === 401 ? "not authorised to view this image" : `image unavailable (HTTP ${r.status || "network"})`, loading: false });
      made = r.url; set({ url: r.url, error: null, loading: false });
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [src]);
  if (s.loading) return <div className="sub">loading image…</div>;
  if (s.error) return <div className="sub" style={{ color: "#b42318" }}>{s.error}</div>;
  return <img src={s.url} alt={alt} style={style} />;
}
function useApi(path, deps = []) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const load = useCallback(() => { set((s) => ({ ...s, loading: true })); api(path).then((r) => set({ loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error?.message || `HTTP ${r.status}`) })); }, [path, ...deps]);
  useEffect(() => { let alive = true; api(path).then((r) => { if (alive) set({ loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error?.message || `HTTP ${r.status}`) }); }); return () => { alive = false; }; }, [path, ...deps]);
  return [state, load];
}
/**
 * UI role gate that matches the server's (auth.mjs hasRole + ADMIN_IMPLIES).
 * /api/whoami returns the literal role array, so platform_admin's implied roles
 * have to be expanded here too — otherwise actions the server accepts (e.g.
 * resending a result message) render no button at all for that account.
 */
const ADMIN_IMPLIES = ["campaign_manager", "support", "auditor"];
const hasRole = (me, ...roles) => roles.some((r) => !!me?.roles?.includes(r) || (!!me?.roles?.includes("platform_admin") && ADMIN_IMPLIES.includes(r)));
const Card = ({ title, children, right }) => <div className="promo-card"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><h4>{title}</h4>{right}</div>{children}</div>;
const Empty = ({ children }) => <div className="empty">{children}</div>;
const Loading = () => <div className="empty">Loading…</div>;
const Err = ({ e }) => (e ? <div className="notice">{String(e)}</div> : null);
const Field = ({ label, children }) => <div className="col"><span className="lab">{label}</span>{children}</div>;
const Input = (p) => <input className="field" {...p} />;
const Btn = ({ children, ghost, small, danger, ...p }) => <button className={`btn ${ghost ? "ghost" : ""} ${small ? "small" : ""} ${danger ? "danger" : ""}`} {...p}>{children}</button>;
function useAction() { const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null); const run = async (fn, { confirm: c } = {}) => { if (c && !window.confirm(c)) return null; setBusy(true); setMsg(null); try { const r = await fn(); if (r && r.ok === false) setMsg({ err: r.data?.error?.message || `HTTP ${r.status}`, detail: r.data?.error }); else setMsg({ ok: true }); return r; } catch (e) { setMsg({ err: e.message }); return null; } finally { setBusy(false); } }; return { busy, msg, run, Msg: () => msg?.err ? <div className="notice">{msg.err}{msg.detail?.failures ? <ul>{msg.detail.failures.map((f) => <li key={f.code}>{f.code}: {f.message}</li>)}</ul> : null}{msg.detail?.blockers ? <ul>{msg.detail.blockers.map((b, i) => <li key={i}>{b.code} {b.detail ? JSON.stringify(b.detail) : ""}</li>)}</ul> : null}</div> : null }; }
const Table = ({ cols, rows, render, empty = "Nothing here yet." }) => <div className="tbl-wrap"><table className="promo-table"><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows?.length ? rows.map(render) : <tr><td colSpan={cols.length}><Empty>{empty}</Empty></td></tr>}</tbody></table></div>;
const Pager = ({ next, onMore }) => (next != null ? <div style={{ marginTop: 8 }}><Btn ghost small onClick={onMore}>Load more</Btn></div> : null);

/* ===================== login ===================== */
function Login({ onAuthed }) {
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [mfa, setMfa] = useState(null); const [code, setCode] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => { setErr(""); setBusy(true); try { const r = await api("/api/login", { method: "POST", body: { email, password: pw }, auth: false }); if (r.data?.pendingMfa) { setMfa(r.data); return; } if (r.ok && r.data?.token) { setToken(r.data.token); onAuthed(); } else if (r.status === 429) setErr(`Too many attempts — try again in ${r.data?.error?.retryAfter || 30}s.`); else setErr(r.data?.error?.message || "Sign-in failed."); } finally { setBusy(false); } };
  const submitCode = async () => { setErr(""); setBusy(true); try { const r = await api("/api/login/mfa", { method: "POST", body: { userId: mfa.userId, code: code.trim() }, auth: false }); if (r.ok && r.data?.token) { setToken(r.data.token); onAuthed(); } else setErr(r.data?.error?.message || "That code wasn't accepted."); } finally { setBusy(false); } };
  return (
    <div className="gate"><div className="gate-card frame">
      <div className="overline">Promotion Operations Console</div>
      {mfa ? <>
        <div className="note">Enter the 6-digit code from your authenticator app.</div>
        <Input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitCode()} placeholder="6-digit code" inputMode="numeric" autoFocus />
        <Err e={err} /><div style={{ marginTop: 14 }}><Btn onClick={submitCode} disabled={!code.trim() || busy}>Verify code</Btn> <Btn ghost onClick={() => setMfa(null)}>Back</Btn></div>
      </> : <>
        <div className="note">Sign in with your named staff account.</div>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoFocus autoComplete="username" />
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Password" autoComplete="current-password" style={{ marginTop: 6 }} />
        <Err e={err} /><div style={{ marginTop: 14 }}><Btn onClick={submit} disabled={!email || !pw || busy}>Sign in</Btn></div>
      </>}
    </div></div>
  );
}
function ChangePassword({ onDone }) {
  const [cur, setCur] = useState(""); const [nw, setNw] = useState(""); const a = useAction();
  return <div className="gate"><div className="gate-card frame"><div className="overline">Change your temporary password</div><div className="note">Your account was created with a temporary password. Choose a new one (12+ characters) to continue.</div>
    <Input type="password" placeholder="Temporary password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /><Input type="password" placeholder="New password" value={nw} onChange={(e) => setNw(e.target.value)} style={{ marginTop: 6 }} autoComplete="new-password" />
    <a.Msg /><div style={{ marginTop: 14 }}><Btn disabled={a.busy || nw.length < 12} onClick={async () => { const r = await a.run(() => api("/api/password", { method: "POST", body: { currentPassword: cur, newPassword: nw } })); if (r?.ok) { setToken(""); onDone(); } }}>Save and sign in again</Btn></div></div></div>;
}

/* ===================== overview ===================== */
function Overview({ me }) {
  const [m] = useApi("/api/metrics"); const [rep] = useApi("/api/reports/summary"); const [al, reloadAl] = useApi("/api/alerts");
  if (m.loading) return <Loading />;
  const r = m.data?.receipts || {}, s = rep.data || {};
  const stats = [[s.registrations ?? 0, "Registrations"], [s.submissions ?? 0, "Submissions"], [s.canonical_receipts ?? 0, "Distinct receipts"], [s.entries_active ?? 0, "Active entries"], [r.DUPLICATE || 0, "Duplicates blocked"], [s.review_open ?? 0, "Awaiting review"], [s.winners_selected ?? 0, "Winners selected"], [s.winners_verified ?? 0, "Winners verified"], [s.prizes_fulfilled ?? 0, "Prizes fulfilled"]];
  return <div className="promo-page">
    <Card title="Campaign at a glance" right={<span className="sub">Definitions: {Object.entries(s.definitions || {}).map(([k, v]) => `${k} = ${v}`).join(" · ")}</span>}>
      <div className="stats">{stats.map(([v, l]) => <div key={l} className="stat"><div className="mono big">{v}</div><div className="lab">{l}</div></div>)}</div>
      <div className="row" style={{ marginTop: 12 }}>
        {[["Environment", m.data.environment], ["Transport", `${m.data.transport?.provider} (${m.data.transport?.mode || "?"})`], ["Outbound pending", m.data.outbound?.byStatus?.pending || 0], ["Outbound failed", (m.data.outbound?.byStatus?.permanent_failure || 0) + (m.data.outbound?.byStatus?.unknown_outcome || 0)], ["CRM pending", m.data.crm?.pending || 0], ["Queue events", m.data.queues?.events?.received || 0], ["Open alerts", m.data.alerts_open || 0]].map(([k, v]) => <Field key={k} label={k}><div className="note">{String(v)}</div></Field>)}
      </div>
    </Card>
    <Card title="Not qualifying — by reason"><Table cols={["Reason", "Count"]} rows={s.not_qualified_by_reason || []} render={(x) => <tr key={x.k}><td className="mono">{x.k}</td><td>{x.n}</td></tr>} /></Card>
    <Card title="Open alerts" right={<Btn ghost small onClick={reloadAl}>Refresh</Btn>}>
      <Table cols={["Severity", "Kind", "Message", "Runbook", ""]} rows={al.data?.alerts || []} empty="No open alerts." render={(x) => <tr key={x.id}><td><Chip s={x.severity} /></td><td className="mono">{x.kind}</td><td>{x.message}</td><td className="sub">{x.runbook || "—"}</td><td><Btn ghost small onClick={() => api(`/api/alerts/${x.id}/ack`, { method: "POST" }).then(reloadAl)}>Acknowledge</Btn></td></tr>} />
    </Card>
    <Card title="Recent activity">{(m.data.activity || []).slice(0, 10).map((a, i) => <div key={i} className="sub" style={{ padding: "3px 0" }}>[{fmt(a.created_at)}] {a.summary}</div>)}{!(m.data.activity || []).length && <Empty>No activity yet.</Empty>}</Card>
  </div>;
}

/* ===================== campaigns ===================== */
function Campaigns({ me }) {
  const [list, reload] = useApi("/api/campaigns"); const [sel, setSel] = useState(null);
  if (list.loading) return <Loading />;
  if (sel) return <CampaignDetail id={sel} me={me} onBack={() => { setSel(null); reload(); }} />;
  return <div className="promo-page">
    <NewCampaign onCreated={reload} />
    <Card title={`Campaigns (${list.data?.campaigns?.length || 0})`}>
      <Table cols={["Code", "Name", "Status", "Version", "Open decisions", "Start", "End", ""]} rows={list.data?.campaigns} render={(c) => <tr key={c.id}><td className="mono">{c.code}</td><td>{c.name}</td><td><Chip s={c.status} /></td><td>{c.active_version || "—"}</td><td>{c.open_decisions}</td><td className="sub">{fmt(c.start_at)}</td><td className="sub">{fmt(c.end_at)}</td><td><Btn ghost small onClick={() => setSel(c.id)}>Open</Btn></td></tr>} />
    </Card>
  </div>;
}
function NewCampaign({ onCreated }) {
  const [f, setF] = useState({}); const a = useAction();
  return <Card title="New campaign (created as draft with a draft version)"><div className="row">
    {[["code", "Code (A-Z0-9-)", "SUGAR-2027"], ["name", "Name", ""], ["start_at", "Start (ISO UTC)", "2027-01-04T00:00:00Z"], ["end_at", "End (ISO UTC)", "2027-03-01T00:00:00Z"]].map(([k, l, ph]) => <Field key={k} label={l}><Input value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} /></Field>)}
    <Btn disabled={a.busy} onClick={async () => { const r = await a.run(() => api("/api/campaigns", { method: "POST", body: f })); if (r?.ok) { setF({}); onCreated(); } }}>Create draft</Btn></div><a.Msg /></Card>;
}
function CampaignDetail({ id, me, onBack }) {
  const [d, reload] = useApi(`/api/campaigns/${id}`); const [tab, setTab] = useState("overview"); const a = useAction();
  if (d.loading) return <Loading />; if (!d.data) return <Err e={d.error} />;
  const c = d.data.campaign, v = d.data.active_version;
  const status = (s, reason) => a.run(() => api(`/api/campaigns/${id}/status`, { method: "POST", body: { status: s, reason } }), { confirm: `Move campaign to ${s}?` }).then(reload);
  const T = [["overview", "Overview"], ["versions", "Rules & versions"], ["content", "Content"], ["periods", "Periods"], ["outlets", "Outlets"], ["decisions", "Decisions"], ["activation", "Activation"]];
  return <div className="promo-page">
    <div className="row" style={{ marginBottom: 10 }}><Btn ghost small onClick={onBack}>← Campaigns</Btn><h3 style={{ margin: 0 }}>{c.name} <Chip s={c.status} /></h3><span className="sub mono">{c.code}</span></div>
    <div className="subtabs">{T.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
    <a.Msg />
    {tab === "overview" && <>
      <Card title="Lifecycle"><div className="row">
        <Field label="Status"><Chip s={c.status} /></Field><Field label="Active version">{v ? `v${v.version_no} (${short(v.config_hash, 10)})` : "none"}</Field><Field label="Timezone">{c.timezone}</Field><Field label="Window">{fmt(c.start_at)} → {fmt(c.end_at)}</Field>
        {c.status === "draft" && <Btn onClick={() => status("active")}>Activate (test env)</Btn>}{c.status === "active" && <Btn ghost onClick={() => status("paused")}>Pause</Btn>}{c.status === "paused" && <Btn onClick={() => status("active")}>Resume</Btn>}{["active", "paused"].includes(c.status) && <Btn danger onClick={() => status("closed", prompt("Reason for closing?") || "closed")}>Close</Btn>}{c.status === "closed" && <Btn ghost onClick={() => status("archived")}>Archive</Btn>}
        <Btn ghost onClick={async () => { const code = prompt("Code for the clone?"); if (!code) return; const r = await a.run(() => api(`/api/campaigns/${id}/clone`, { method: "POST", body: { code } })); if (r?.ok) onBack(); }}>Clone</Btn>
      </div></Card>
      <Card title="Pause controls (separate switches)"><div className="row">{["intake", "auto_qualify", "outbound", "draws"].map((k) => <label key={k} className="check"><input type="checkbox" checked={!!d.data.pause?.[k]} onChange={(e) => a.run(() => api(`/api/campaigns/${id}/pause`, { method: "POST", body: { [k]: e.target.checked } })).then(reload)} /> pause {k.replace("_", " ")}</label>)}</div><div className="sub">Pausing intake stops new receipts; pausing auto-qualify routes every decision to review; pausing outbound holds messages; pausing draws blocks freezing.</div></Card>
      <Card title="Edit details"><EditCampaign c={c} onSaved={reload} /></Card>
    </>}
    {tab === "versions" && <Versions id={id} data={d.data} onChange={reload} />}
    {tab === "content" && <ContentEditor id={id} data={d.data} onChange={reload} />}
    {tab === "periods" && <Periods id={id} data={d.data} onChange={reload} />}
    {tab === "outlets" && <CampaignOutlets id={id} data={d.data} me={me} onChange={reload} />}
    {tab === "decisions" && <Decisions id={id} data={d.data} onChange={reload} />}
    {tab === "activation" && <Activation id={id} />}
  </div>;
}
function EditCampaign({ c, onSaved }) { const [f, setF] = useState({ name: c.name, start_at: c.start_at, end_at: c.end_at, timezone: c.timezone, draw_config: JSON.stringify(c.draw_config, null, 1) }); const a = useAction(); return <><div className="row">{[["name", "Name"], ["start_at", "Start"], ["end_at", "End"], ["timezone", "Timezone"]].map(([k, l]) => <Field key={k} label={l}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}</div><Field label="Draw config (prizes, alternates, one prize per participant)"><textarea className="area" rows={5} value={f.draw_config} onChange={(e) => setF({ ...f, draw_config: e.target.value })} /></Field><a.Msg /><div className="spacer" /><Btn disabled={a.busy} onClick={() => { let dc; try { dc = JSON.parse(f.draw_config); } catch { return alert("draw config is not valid JSON"); } a.run(() => api(`/api/campaigns/${c.id}`, { method: "PATCH", body: { ...f, draw_config: dc } })).then(onSaved); }}>Save</Btn></>; }
function Versions({ id, data, onChange }) {
  const [vs] = useApi(`/api/campaigns/${id}/versions`, [data]); const [draft, setDraft] = useState(null); const a = useAction();
  const rows = vs.data?.versions || [];
  return <>
    <Card title="Versions (activated versions are immutable; changes are new versions)" right={<Btn small onClick={() => a.run(() => api(`/api/campaigns/${id}/versions`, { method: "POST", body: { from_active: true } })).then(onChange)}>New draft from active</Btn>}>
      <a.Msg /><Table cols={["#", "Status", "Frozen", "Config hash", "Products", "Rule", ""]} rows={rows} render={(v) => <tr key={v.id}><td>v{v.version_no}</td><td><Chip s={v.status} /></td><td className="sub">{fmt(v.frozen_at)}</td><td className="mono sub">{short(v.config_hash, 12)}</td><td>{(v.rules.products || []).map((p) => p.code).join(", ") || "—"}</td><td className="sub">{v.rules.primary_rule ? `${v.rules.primary_rule.min_packs} × ${v.rules.primary_rule.pack_grams}g ≥ ${v.rules.primary_rule.min_total_grams}g${v.rules.allow_pack_combinations ? " (combinations allowed)" : ""}; entries/receipt ${v.rules.award?.entries_per_receipt}` : "—"}</td><td>{v.status === "draft" && <><Btn ghost small onClick={() => setDraft(v)}>Edit</Btn> <Btn small onClick={() => a.run(() => api(`/api/campaigns/${id}/versions/${v.id}/activate`, { method: "POST" }), { confirm: `Activate v${v.version_no}? This freezes it and retires the current active version.` }).then(onChange)}>Activate</Btn></>}</td></tr>} />
    </Card>
    {draft && <Card title={`Edit draft v${draft.version_no}`}><JsonEditor value={{ rules: draft.rules, flags: draft.flags }} onSave={(val) => a.run(() => api(`/api/campaigns/${id}/versions/${draft.id}`, { method: "PATCH", body: val })).then(() => { setDraft(null); onChange(); })} onCancel={() => setDraft(null)} help="rules: products[{code,name,aliases,pack_grams,qualifying}], primary_rule{min_packs,pack_grams,min_total_grams}, allow_pack_combinations, award{entries_per_receipt}, caps{per_participant_per_period}, date_order, outlet_match{required,min_score}, purchase_window{start,end}. flags: participant_status, registration{identity_stage: registration|winner|off}" /></Card>}
  </>;
}
function JsonEditor({ value, onSave, onCancel, help }) { const [t, setT] = useState(JSON.stringify(value, null, 2)); const [err, setErr] = useState(""); return <><div className="sub" style={{ marginBottom: 6 }}>{help}</div><textarea className="area mono" rows={18} value={t} onChange={(e) => setT(e.target.value)} /><Err e={err} /><div className="spacer" /><Btn onClick={() => { try { onSave(JSON.parse(t)); } catch (e) { setErr(`Invalid JSON: ${e.message}`); } }}>Save</Btn> <Btn ghost onClick={onCancel}>Cancel</Btn></>; }
const CONTENT_KEYS = ["terms_version", "privacy_version", "terms_url", "prizes_text", "prize_artwork_url", "winner_template_name", "menu_home", "mechanics", "terms", "prizes", "received", "qualified", "duplicate", "not_qualified", "reupload", "under_review", "delayed", "review_result_qualified", "review_result_not_qualified", "winner_contact", "winner_collect", "help", "support_handoff", "campaign_closed", "campaign_paused"];
function ContentEditor({ id, data, onChange }) {
  const cur = data.active_version?.content || {}; const [c, setC] = useState(cur); const [preview, setPreview] = useState("menu_home"); const a = useAction();
  return <>
    <Card title="Versioned content (saving creates a new draft version; activate it under Rules & versions)" right={<Btn disabled={a.busy} onClick={() => a.run(() => api(`/api/campaigns/${id}/versions`, { method: "POST", body: { from_active: true, content: c } })).then(onChange)}>Save as new draft</Btn>}>
      <div className="sub">Variables: {"{campaign} {reference} {reason} {count_line} {first_name} {prize} {claim_ref} {deadline} {terms_version} {privacy_version} {terms_url} {min_packs} {pack_label} {product}"}. Leave a key blank to use the platform default. Every message must render as plain text on a phone.</div>
      <a.Msg />
      {CONTENT_KEYS.map((k) => <Field key={k} label={k}><textarea className="area" rows={k.startsWith("menu") || k === "winner_contact" ? 4 : 2} value={c[k] || ""} placeholder="(platform default)" onChange={(e) => setC({ ...c, [k]: e.target.value })} onFocus={() => setPreview(k)} /></Field>)}
    </Card>
    <Card title={`Phone preview — ${preview}`}><div className="phone">{(c[preview] || "(platform default — see src/copy.mjs)").split("\n").map((l, i) => <div key={i}>{l || " "}</div>)}</div></Card>
  </>;
}
function Periods({ id, data, onChange }) {
  const [f, setF] = useState({}); const a = useAction();
  return <Card title="Draw periods (half-open UTC windows; entry time = server intake time)"><div className="row">{[["code", "Code", "W5"], ["label", "Label", "Week 5"], ["starts_at", "Starts (ISO)", ""], ["ends_at", "Ends (ISO, exclusive)", ""], ["draw_at", "Draw at (ISO)", ""]].map(([k, l, ph]) => <Field key={k} label={l}><Input value={f[k] || ""} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}<Btn disabled={a.busy} onClick={() => a.run(() => api(`/api/campaigns/${id}/periods`, { method: "POST", body: f })).then(() => { setF({}); onChange(); })}>Add / update</Btn></div><a.Msg />
    <Table cols={["Code", "Label", "Starts", "Ends", "Draw at", "Status", "Prize config"]} rows={data.periods} render={(p) => <tr key={p.id}><td className="mono">{p.code}</td><td>{p.label}</td><td className="sub">{fmt(p.starts_at)}</td><td className="sub">{fmt(p.ends_at)}</td><td className="sub">{fmt(p.draw_at)}</td><td><Chip s={p.status} /></td><td className="mono sub">{p.prize_config_json === "{}" ? "campaign default" : p.prize_config_json}</td></tr>} /></Card>;
}
function CampaignOutlets({ id, data, me, onChange }) {
  const [list, reload] = useApi(`/api/campaigns/${id}/outlets`, [data]); const [csv, setCsv] = useState(""); const [res, setRes] = useState(null); const a = useAction();
  const importCsv = async (dry) => { const r = await a.run(() => api(`/api/campaigns/${id}/outlets/import`, { method: "POST", body: { csv, dry_run: dry } })); setRes(r?.data || null); if (!dry && r?.ok) { reload(); onChange(); } };
  const rows = list.data?.outlets || [];
  // CSV import only ever grows the membership (`insert or ignore`), so PUT is the
  // only way to take a closed branch out of the consumer's outlet menu. The
  // campaign-level collection flags of the outlets that stay are sent with it,
  // otherwise the replace would silently reset them to the master outlet value.
  const remove = (o) => { const keep = rows.filter((x) => x.id !== o.id); return a.run(() => api(`/api/campaigns/${id}/outlets`, { method: "PUT", body: { outlet_ids: keep.map((x) => x.id), collection: Object.fromEntries(keep.map((x) => [x.id, x.campaign_collection_enabled ? 1 : 0])) } }), { confirm: `Remove ${o.outlet_code} (${o.branch}) from this campaign? Consumers will no longer see it in the outlet menu. Membership is replaced with the ${keep.length} outlet(s) listed here.` }).then((r) => { if (r?.ok) { reload(); onChange(); } }); };
  return <>
    <Card title={`Participating outlets (${rows.length})`} right={<a className="link-btn" href="/api/outlets/export.csv" onClick={(e) => { e.preventDefault(); api("/api/outlets/export.csv", {}).then(() => window.open(`/api/outlets/export.csv`)); }}>Export CSV</a>}>
      <a.Msg />
      <Table cols={["Code", "Retailer", "Branch", "Town", "Province", "Collection", "Active", ""]} rows={rows} render={(o) => <tr key={o.id}><td className="mono">{o.outlet_code}</td><td>{o.retailer}</td><td>{o.branch}</td><td>{o.town}</td><td>{o.province}</td><td>{o.campaign_collection_enabled ? "yes" : "no"}</td><td>{o.active ? "yes" : "no"}</td><td>{hasRole(me, "campaign_manager") && <Btn ghost small danger disabled={a.busy} onClick={() => remove(o)}>Remove</Btn>}</td></tr>} />
      <div className="sub">Removing takes the outlet out of this campaign only; the master record (and its aliases) is kept. Outlets whose master record is inactive are not listed and are dropped from the campaign when membership is replaced.</div>
    </Card>
    <Card title="CSV import (validated preview first; all-or-nothing)">
      <div className="sub">Header: outlet_code,retailer,branch,town,province,collection_enabled,active_from,active_to,aliases (aliases separated by ;). Template: fixtures/outlets-import-template.csv</div>
      <textarea className="area mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="outlet_code,retailer,branch,town,province,collection_enabled,active_from,active_to,aliases" />
      <div className="spacer" /><Btn ghost disabled={!csv || a.busy} onClick={() => importCsv(true)}>Validate (dry run)</Btn> <Btn disabled={!csv || a.busy || !res?.ok} onClick={() => importCsv(false)}>Import {res?.rows || 0} rows</Btn><a.Msg />
      {res && <div style={{ marginTop: 8 }}>{res.ok ? <div className="note">Valid: {res.rows} rows{res.imported ? ` — imported ${res.imported}` : ""}.</div> : <Table cols={["Row", "Error"]} rows={res.errors} render={(e, i) => <tr key={i}><td>{e.row}</td><td>{e.error}</td></tr>} />}</div>}
    </Card>
  </>;
}
function Decisions({ id, data, onChange }) {
  const a = useAction(); const [edit, setEdit] = useState(null);
  return <Card title="Client decision register (test values are never sign-off; approve with an approved value)"><a.Msg />
    <Table cols={["ID", "Question", "Test value", "Approved value", "Status", "Owner", ""]} rows={data.decisions} render={(d) => <tr key={d.id}><td className="mono">{d.decision_id}</td><td>{d.question}</td><td className="sub">{d.test_value}</td><td>{d.approved_value || "—"}</td><td><Chip s={d.status} /></td><td className="sub">{d.owner || "—"}</td><td><Btn ghost small onClick={() => setEdit({ ...d })}>Edit</Btn></td></tr>} />
    {edit && <div className="frame" style={{ marginTop: 12, padding: 12 }}><div className="row"><Field label="Approved value"><Input value={edit.approved_value || ""} onChange={(e) => setEdit({ ...edit, approved_value: e.target.value })} /></Field><Field label="Status"><select className="field" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{["open", "proposed", "approved", "not_required"].map((s) => <option key={s}>{s}</option>)}</select></Field><Field label="Owner"><Input value={edit.owner || ""} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} /></Field><Field label="Evidence (email/document ref)"><Input value={edit.evidence || ""} onChange={(e) => setEdit({ ...edit, evidence: e.target.value })} /></Field><Btn onClick={() => a.run(() => api(`/api/campaigns/${id}/decisions/${edit.decision_id}`, { method: "PUT", body: edit })).then(() => { setEdit(null); onChange(); })}>Save</Btn><Btn ghost onClick={() => setEdit(null)}>Cancel</Btn></div></div>}
  </Card>;
}
// The Campaigns tab is open to every role but this route is campaign_manager/
// auditor only: without the !v.data guard a 403 left data=null and `d.ok` threw
// during render, which the root ErrorBoundary turns into "the console hit an
// error" — a reviewer clicking this sub-tab lost the whole console.
function Activation({ id }) { const [v] = useApi(`/api/campaigns/${id}/activation`); if (v.loading) return <Loading />; if (!v.data) return <Err e={v.error || "activation preflight unavailable"} />; const d = v.data; return <Card title={`Production activation preflight — ${d.ok ? "READY" : `${d.blockingCount} blocking in ${d.environment}`}`}><div className="sub">Server-side validator; the same checks block activation in a production environment. Non-blocking rows are informational in this environment.</div><Table cols={["Code", "Message", "Blocking here"]} rows={d.failures} empty="All checks pass." render={(f) => <tr key={f.code}><td className="mono">{f.code}</td><td>{f.message}</td><td>{f.blocking ? <Chip s="critical" /> : <Chip s="info" />}</td></tr>} /></Card>; }

/* ===================== master data ===================== */
/**
 * Body for the outlet master upsert.
 *
 * services.mjs upsertOutlet is a full-row replace whose omitted-field defaults
 * are collection_enabled=1, active=1, active_from=1970-01-01,
 * active_to=9999-12-31 and aliases=[]. Posting only the five visible text fields
 * therefore silently reactivated closed branches (they reappear in the
 * consumer's outlet menu), turned non-collection branches into prize collection
 * points, and wiped the OCR aliases an outlet is matched by. Every field is now
 * sent, and anything the operator did not set is carried over from the record
 * already on screen rather than from those defaults.
 */
function outletBody(f, cur) {
  const v = (k, d) => (f[k] !== undefined && f[k] !== "" ? f[k] : d);
  const flag = (k) => (Number(f[k] !== undefined ? f[k] : (cur?.[k] ?? 1)) ? 1 : 0);
  return {
    outlet_code: f.outlet_code, retailer: v("retailer", cur?.retailer), branch: v("branch", cur?.branch), town: v("town", cur?.town), province: v("province", cur?.province ?? ""),
    aliases: f.aliases !== undefined ? String(f.aliases).split(";").map((s) => s.trim()).filter(Boolean) : JSON.parse(cur?.aliases_json || "[]"),
    collection_enabled: flag("collection_enabled"), active: flag("active"),
    active_from: v("active_from", cur?.active_from) || undefined, active_to: v("active_to", cur?.active_to) || undefined,
  };
}
function Outlets() {
  const [l, reload] = useApi("/api/outlets"); const [f, setF] = useState({}); const a = useAction();
  const rows = l.data?.outlets || []; const cur = rows.find((o) => o.outlet_code === f.outlet_code) || null;
  const shown = (k, d) => (f[k] !== undefined ? f[k] : d);
  const openRow = (o) => setF({ loaded: o.outlet_code, outlet_code: o.outlet_code, retailer: o.retailer, branch: o.branch, town: o.town, province: o.province || "", aliases: JSON.parse(o.aliases_json || "[]").join("; "), collection_enabled: !!o.collection_enabled, active: !!o.active, active_from: o.active_from, active_to: o.active_to });
  const save = () => a.run(() => api("/api/outlets", { method: "POST", body: outletBody(f, cur) }), cur && f.loaded !== f.outlet_code ? { confirm: `${f.outlet_code} already exists. Saving replaces its whole master record — press Cancel and open it with Edit first if you have not checked its aliases, collection flag and active window.` } : {}).then((r) => { if (r?.ok) { setF({}); reload(); } });
  return <div className="promo-page">
    <Card title="Add / update outlet (master)" right={f.outlet_code ? <Btn ghost small onClick={() => setF({})}>Clear / new outlet</Btn> : null}>
      <div className="row">{[["outlet_code", "Code"], ["retailer", "Retailer"], ["branch", "Branch"], ["town", "Town"], ["province", "Province"], ["aliases", "Aliases (; separated)"], ["active_from", "Active from"], ["active_to", "Active to"]].map(([k, l2]) => <Field key={k} label={l2}><Input value={shown(k, "") ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
        <label className="check"><input type="checkbox" checked={!!shown("collection_enabled", cur ? !!cur.collection_enabled : true)} onChange={(e) => setF({ ...f, collection_enabled: e.target.checked })} /> collection point</label>
        <label className="check"><input type="checkbox" checked={!!shown("active", cur ? !!cur.active : true)} onChange={(e) => setF({ ...f, active: e.target.checked })} /> active</label>
        <Btn disabled={a.busy || !f.outlet_code} onClick={save}>Save</Btn></div>
      <div className="sub">Saving writes the whole master record for every campaign. Use Edit on a row to load its current aliases, collection flag and active window before changing it.</div><a.Msg />
    </Card>
    <Card title={`Outlet master (${rows.length})`}><Table cols={["Code", "Retailer", "Branch", "Town", "Province", "Collection", "Active", "Aliases", ""]} rows={rows} render={(o) => <tr key={o.id}><td className="mono">{o.outlet_code}</td><td>{o.retailer}</td><td>{o.branch}</td><td>{o.town}</td><td>{o.province}</td><td>{o.collection_enabled ? "yes" : "no"}</td><td>{o.active ? "yes" : "no"}</td><td className="sub">{JSON.parse(o.aliases_json || "[]").join("; ")}</td><td><Btn ghost small onClick={() => openRow(o)}>Edit</Btn></td></tr>} /></Card>
  </div>;
}
function Products() { const [l, reload] = useApi("/api/products"); const [f, setF] = useState({ pack_grams: 2000 }); const a = useAction(); return <div className="promo-page"><Card title="Add / update product"><div className="row">{[["sku", "SKU / code"], ["brand", "Brand"], ["name", "Name"], ["pack_grams", "Pack grams"], ["aliases", "Aliases (; separated)"]].map(([k, l2]) => <Field key={k} label={l2}><Input value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}<Btn disabled={a.busy} onClick={() => a.run(() => api("/api/products", { method: "POST", body: { ...f, pack_grams: Number(f.pack_grams), aliases: String(f.aliases || "").split(";").map((s) => s.trim()).filter(Boolean) } })).then(() => { setF({ pack_grams: 2000 }); reload(); })}>Save</Btn></div><a.Msg /><div className="sub">Products become qualifying only when listed in an activated campaign version's rules.</div></Card><Card title="Product master"><Table cols={["SKU", "Brand", "Name", "Pack (g)", "Aliases"]} rows={l.data?.products} render={(p) => <tr key={p.id}><td className="mono">{p.sku}</td><td>{p.brand}</td><td>{p.name}</td><td>{p.pack_grams}</td><td className="sub">{p.aliases.join("; ")}</td></tr>} /></Card></div>; }

/* ===================== participants ===================== */
function Participants({ me }) {
  const [q, setQ] = useState(""); const [l, reload] = useApi(`/api/participants?q=${encodeURIComponent(q)}`, [q]); const [sel, setSel] = useState(null);
  if (sel) return <ParticipantDetail id={sel} me={me} onBack={() => { setSel(null); reload(); }} />;
  return <div className="promo-page"><Card title="Participants" right={<Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />}><Table cols={["Name", "Town", "Phone", "ID", "Status", "Registered", ""]} rows={l.data?.participants} render={(p) => <tr key={p.id}><td>{p.first_name} {p.surname}</td><td>{p.location}</td><td className="mono">{p.wa_phone_uid}</td><td className="mono">{p.identity_masked || "—"}</td><td><Chip s={p.status} /></td><td className="sub">{fmt(p.created_at)}</td><td><Btn ghost small onClick={() => setSel(p.id)}>Open</Btn></td></tr>} /></Card></div>;
}
function ParticipantDetail({ id, me, onBack }) {
  const [d, reload] = useApi(`/api/participants/${id}`); const a = useAction(); const [edit, setEdit] = useState(null); const [phone, setPhone] = useState(null);
  if (d.loading) return <Loading />; if (!d.data) return <Err e={d.error} />;
  const p = d.data.participant; const can = (r) => me.roles.includes(r) || (me.roles.includes("platform_admin") && ["support", "campaign_manager", "auditor"].includes(r));
  return <div className="promo-page"><Btn ghost small onClick={onBack}>← Participants</Btn><a.Msg />
    <Card title={`${p.first_name} ${p.surname}`} right={<Chip s={p.status} />}><div className="row"><Field label="Phone"><span className="mono">{p.phone}</span></Field><Field label="ID (masked)"><span className="mono">{p.identity_masked || "—"}</span></Field><Field label="Town">{p.location}</Field><Field label="Registered">{fmt(p.created_at)}</Field></div>
      <div className="row" style={{ marginTop: 10 }}>{can("support") && <Btn ghost small onClick={() => setEdit({ first_name: p.first_name, surname: p.surname, location: p.location })}>Correct details</Btn>}{can("support") && <Btn ghost small onClick={() => setPhone({ phone: "", reason: "" })}>Change phone (audited)</Btn>}{(me.roles.includes("winner_ops") || me.roles.includes("auditor")) && <Btn ghost small onClick={async () => { const reason = prompt("Reason for revealing the identity number (audited)?"); if (!reason) return; const r = await a.run(() => api(`/api/participants/${id}/reveal-identity`, { method: "POST", body: { reason } })); if (r?.ok) alert(`Identity: ${r.data.identity}`); }}>Reveal ID (audited)</Btn>}{can("support") && <Btn ghost small onClick={() => a.run(() => api(`/api/participants/${id}/withdraw`, { method: "POST", body: { reason: prompt("Reason?") || "request" } }), { confirm: "Withdraw this participant from all campaigns?" }).then(reload)}>Withdraw</Btn>}{me.roles.includes("platform_admin") && <Btn danger small onClick={() => a.run(() => api(`/api/participants/${id}/anonymise`, { method: "POST", body: { reason: prompt("Deletion request reference?") || "" } }), { confirm: "Anonymise personal data? Ledger references are kept. This cannot be undone." }).then(reload)}>Anonymise (deletion)</Btn>}</div>
      {edit && <div className="row" style={{ marginTop: 10 }}>{["first_name", "surname", "location"].map((k) => <Field key={k} label={k}><Input value={edit[k] || ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}<Btn onClick={() => a.run(() => api(`/api/participants/${id}`, { method: "PATCH", body: { ...edit, reason: "support correction" } })).then(() => { setEdit(null); reload(); })}>Save</Btn></div>}
      {/* A winner who changed SIM could not be updated from the console at all:
          POST /api/participants/:id/phone had no surface, so support had to curl
          it or the prize could never be delivered. The detail page shows a
          masked number, so the new one is typed in full. */}
      {phone && <div className="row" style={{ marginTop: 10 }}><Field label="New WhatsApp number (digits, country code first)"><Input value={phone.phone} onChange={(e) => setPhone({ ...phone, phone: e.target.value.replace(/\D/g, "") })} placeholder="2637…" /></Field><Field label="Reason (audited)"><Input value={phone.reason} onChange={(e) => setPhone({ ...phone, reason: e.target.value })} placeholder="e.g. SIM swap confirmed with ID" /></Field><Btn disabled={a.busy || phone.phone.length < 9 || !phone.reason.trim()} onClick={() => a.run(() => api(`/api/participants/${id}/phone`, { method: "POST", body: { phone: phone.phone, reason: phone.reason.trim() } }), { confirm: `Move this participant to ${phone.phone}? Their registration, entries and any winner record follow the new number.` }).then((r) => { if (r?.ok) { setPhone(null); reload(); } })}>Save</Btn><Btn ghost onClick={() => setPhone(null)}>Cancel</Btn></div>}
    </Card>
    <Card title="Enrollments"><Table cols={["Campaign", "Terms", "Privacy", "Marketing", "Enrolled", "Withdrawn"]} rows={d.data.enrollments} render={(e) => <tr key={e.id}><td className="mono">{e.campaign_code}</td><td>{e.terms_version}</td><td>{e.privacy_version}</td><td>{e.marketing_consent ? "yes" : "no"}</td><td className="sub">{fmt(e.enrolled_at)}</td><td className="sub">{fmt(e.withdrawn_at)}</td></tr>} /></Card>
    <Card title="Submissions"><Table cols={["Reference", "Status", "Reason", "Period", "Submitted", "Decided"]} rows={d.data.submissions} render={(s) => <tr key={s.id}><td className="mono">{s.reference}</td><td><Chip s={s.status} /></td><td className="sub">{s.reason_code}</td><td>{s.period_code}</td><td className="sub">{fmt(s.created_at)}</td><td className="sub">{fmt(s.decided_at)}</td></tr>} /></Card>
  </div>;
}

/* ===================== receipts + review ===================== */
function Receipts({ me }) {
  const [filters, setF] = useState({ status: "REVIEW_REQUIRED" }); const qs = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const [l, reload] = useApi(`/api/receipts?${qs}`, [qs]); const [queue] = useApi("/api/reviews/queue", [qs]); const [sel, setSel] = useState(null);
  if (sel) return <ReceiptDetail id={sel} me={me} onBack={() => { setSel(null); reload(); }} />;
  const q = queue.data;
  return <div className="promo-page">
    {q && <Card title="Review queue"><div className="stats">{[[q.count, "Open"], [q.overdue, "Over SLA"], [q.oldest ? Math.round((Date.now() - Date.parse(q.oldest)) / 60000) + " min" : "—", "Oldest"]].map(([v, l2]) => <div className="stat" key={l2}><div className="mono big">{v}</div><div className="lab">{l2}</div></div>)}{Object.entries(q.byReason || {}).map(([k, v]) => <div className="stat" key={k}><div className="mono big">{v}</div><div className="lab">{k}</div></div>)}</div></Card>}
    <Card title="Receipts" right={<div className="row">{[["status", ["", "REVIEW_REQUIRED", "QUALIFIED", "NOT_QUALIFIED", "DUPLICATE", "REUPLOAD_REQUIRED", "delayed", "received", "processing"]]].map(([k, opts]) => <select key={k} className="field" value={filters[k] || ""} onChange={(e) => setF({ ...filters, [k]: e.target.value })}>{opts.map((o) => <option key={o} value={o}>{o || "all statuses"}</option>)}</select>)}<Input placeholder="Reference R-…" value={filters.reference || ""} onChange={(e) => setF({ ...filters, reference: e.target.value })} style={{ maxWidth: 160 }} /><Input placeholder="Period" value={filters.period || ""} onChange={(e) => setF({ ...filters, period: e.target.value })} style={{ maxWidth: 90 }} /></div>}>
      {l.loading ? <Loading /> : <Table cols={["Reference", "Status", "Reason", "Period", "Review", "Assignee", "Submitted", ""]} rows={l.data?.receipts} render={(x) => <tr key={x.id}><td className="mono">{x.reference}</td><td><Chip s={x.status} /></td><td className="sub">{x.reason_code}</td><td>{x.period_code}</td><td>{x.review_state ? <Chip s={x.review_state} /> : "—"}</td><td className="sub">{x.assignee ? short(x.assignee, 10) : "—"}</td><td className="sub">{fmt(x.created_at)}</td><td><Btn ghost small onClick={() => setSel(x.id)}>Open</Btn></td></tr>} />}
    </Card>
  </div>;
}
function ReceiptDetail({ id, me, onBack }) {
  const [d, reload] = useApi(`/api/receipts/${id}`); const a = useAction(); const [decision, setDecision] = useState("QUALIFIED"); const [reason, setReason] = useState(""); const [note, setNote] = useState("");
  if (d.loading) return <Loading />; if (!d.data) return <div className="promo-page"><Btn ghost small onClick={onBack}>← Receipts</Btn><Err e={d.error} /></div>;
  const x = d.data.receipt, v = d.data.validation?.at(-1), facts = v?.facts; const isReviewer = me.roles.includes("reviewer");
  const act = (fn, c) => a.run(fn, c ? { confirm: c } : {}).then(reload);
  return <div className="promo-page"><Btn ghost small onClick={onBack}>← Receipts</Btn><a.Msg />
    <div className="split2">
      <Card title={`Receipt ${x.reference}`} right={<Chip s={x.status} />}>
        {d.data.media ? <div className="imgbox"><AuthImg src={d.data.media.original.url} alt="receipt (original)" /><div className="sub">Original · signed link expires {fmt(d.data.media.original.expiresAt)} · {d.data.media.width}×{d.data.media.height} {d.data.media.mime}</div><AuthImg src={d.data.media.normalised.url} alt="receipt (normalised for OCR)" style={{ marginTop: 8, filter: "grayscale(1)" }} /><div className="sub">Normalised image used for OCR</div></div> : <Empty>Image viewing requires the reviewer or auditor role.</Empty>}
      </Card>
      <div>
        <Card title="Evidence"><div className="row"><Field label="Participant">{x.participant?.first_name} {x.participant?.surname} · {x.participant?.phone}</Field><Field label="Selected outlet">{x.outlet ? `${x.outlet.retailer} — ${x.outlet.branch}, ${x.outlet.town}` : "—"}</Field><Field label="Period">{x.period_code || "—"}</Field><Field label="Rules version"><span className="mono">{short(d.data.rules_version, 12)}</span></Field><Field label="Intake">{fmt(x.intake_at)}</Field><Field label="Extractor">{v ? `${v.extractor_provider} ${v.extractor_version} (${v.latency_ms} ms)` : "—"}</Field></div>
          {facts && <div className="row" style={{ marginTop: 8 }}><Field label="Document">{facts.document?.kind} (score {facts.document?.score})</Field><Field label="Merchant text">{facts.merchant?.rawText || "—"}</Field><Field label="Receipt no">{facts.transaction?.receiptNo || "—"}</Field><Field label="Date">{facts.transaction?.date || "—"}{facts.transaction?.dateAmbiguous ? " (day/month ambiguous)" : ""}</Field><Field label="Total">{facts.transaction?.totalMinor != null ? (facts.transaction.totalMinor / 100).toFixed(2) : "—"}</Field><Field label="OCR confidence">{facts.quality?.confidence ?? "n/a"}</Field></div>}
          {x.outlet_match?.length ? <div className="sub" style={{ marginTop: 6 }}>Outlet candidates: {x.outlet_match.map((c) => `${c.outletId} (${c.score})`).join(", ")}</div> : null}
          {x.quality && <div className="sub">Image quality: brightness {x.quality.brightness}, contrast {x.quality.contrast}, sharpness {x.quality.sharpness}{x.quality.blurry ? " · blurry" : ""}{x.quality.tooDark ? " · dark" : ""}</div>}
        </Card>
        <Card title="Line items"><Table cols={["Description", "Qty", "Pack (g)", "Amount", "Voided", "Matched"]} rows={d.data.items} render={(i) => { const ev = JSON.parse(i.evidence_json || "{}"); return <tr key={i.id}><td>{i.description}</td><td>{i.quantity ?? "?"}</td><td>{ev.packGrams ?? "—"}</td><td>{i.amount ?? "—"}</td><td>{ev.voided ? "yes" : ""}</td><td className="mono">{i.sku || ""}</td></tr>; }} /></Card>
        <Card title="Rule results"><Table cols={["Rule", "Outcome", "Reason", "Evidence"]} rows={v?.rules || []} render={(r, i) => <tr key={i}><td className="mono">{r.rule}</td><td><Chip s={r.outcome === "pass" ? "QUALIFIED" : r.outcome === "fail" ? "NOT_QUALIFIED" : "REVIEW_REQUIRED"} /></td><td className="sub">{r.reason}</td><td className="sub mono">{r.evidence ? JSON.stringify(r.evidence).slice(0, 140) : ""}</td></tr>} /></Card>
        <Card title="Duplicate candidates"><Table cols={["Candidate", "Kind", "Score", "Candidate status", "Same participant", "Resolution", ""]} rows={d.data.duplicates} empty="No duplicate candidates." render={(c) => <tr key={c.id}><td className="mono">{c.candidate_reference}</td><td>{c.kind}</td><td>{c.score}</td><td><Chip s={c.candidate_status} /></td><td>{c.same_participant ? "yes" : "no"}</td><td><Chip s={c.resolution} /></td><td>{isReviewer && c.resolution === "open" && <><Btn ghost small onClick={() => act(() => api(`/api/duplicates/${c.id}/resolve`, { method: "POST", body: { resolution: "same_purchase" } }))}>Same purchase</Btn> <Btn ghost small onClick={() => act(() => api(`/api/duplicates/${c.id}/resolve`, { method: "POST", body: { resolution: "different_purchase" } }))}>Different</Btn></>}</td></tr>} /></Card>
        {d.data.attempts?.length > 1 && <Card title="Related attempts"><Table cols={["Reference", "Status", "At"]} rows={d.data.attempts} render={(t) => <tr key={t.id}><td className="mono">{t.reference}</td><td><Chip s={t.status} /></td><td className="sub">{fmt(t.created_at)}</td></tr>} /></Card>}
        {v?.ocr_text && <Card title="OCR text (evidence)"><pre className="mono ocr">{v.ocr_text}</pre></Card>}
        {isReviewer && d.data.review && d.data.review.state !== "decided" && <Card title="Decision (audited; version-checked)">
          <div className="row">{d.data.review.assignee !== me.id ? <Btn ghost small onClick={() => act(() => api(`/api/receipts/${id}/assign`, { method: "POST" }))}>Assign to me</Btn> : <Btn ghost small onClick={() => act(() => api(`/api/receipts/${id}/release`, { method: "POST" }))}>Release</Btn>}<span className="sub">SLA due {fmt(d.data.review.sla_due_at)} · assignee {d.data.review.assignee ? short(d.data.review.assignee, 10) : "none"}</span></div>
          <div className="row" style={{ marginTop: 8 }}><Field label="Decision"><select className="field" value={decision} onChange={(e) => setDecision(e.target.value)}><option value="QUALIFIED">Qualify — award one entry</option><option value="NOT_QUALIFIED">Reject with reason</option><option value="DUPLICATE">Duplicate of a credited receipt</option><option value="REUPLOAD_REQUIRED">Request a clearer image</option></select></Field><Field label="Reason code"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={decision === "QUALIFIED" ? "(ok)" : "e.g. below_minimum_quantity"} /></Field><Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
          <div className="spacer" /><Btn disabled={a.busy} onClick={() => act(() => api(`/api/receipts/${id}/review`, { method: "POST", body: { decision, reason_code: reason || undefined, note, expected_version: x.row_version } }), `Apply ${decision}? The participant will be messaged.`)}>Apply decision</Btn>
        </Card>}
        {(me.roles.includes("reviewer") || me.roles.includes("platform_admin")) && x.status !== "QUALIFIED" && <Card title="Operations"><Btn ghost small onClick={() => act(() => api(`/api/receipts/${id}/reprocess`, { method: "POST", body: { reason: "operator reprocess" } }), "Re-run extraction and rules for this receipt?")}>Reprocess</Btn></Card>}
        {/* Resend is a support action (admin.mjs grants it to support only), but it
            used to be nested inside the reviewer-only Operations card and hidden for
            QUALIFIED receipts — so no delivered account could see it, and the common
            case ("I never got my confirmation") was excluded. It stands on its own
            gate now, with platform_admin's implied support role expanded. */}
        {hasRole(me, "support") && <Card title="Support"><Btn ghost small onClick={() => act(() => api(`/api/receipts/${id}/resend-result`, { method: "POST" }))}>Resend result to participant</Btn><div className="sub">Re-sends the last outcome message for this receipt, whatever its status. Logged and audited.</div></Card>}
        {d.data.entry && <Card title="Award"><div className="row"><Field label="Entry"><span className="mono">{d.data.entry.id}</span></Field><Field label="Status"><Chip s={d.data.entry.status} /></Field><Field label="Period">{d.data.entry.period_code}</Field></div></Card>}
      </div>
    </div>
  </div>;
}

/* ===================== entries ===================== */
function Entries({ me }) {
  const [f, setF] = useState({}); const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); const [l, reload] = useApi(`/api/entries?${qs}`, [qs]); const [sel, setSel] = useState(null); const a = useAction();
  const [detail] = useApi(sel ? `/api/entries/${sel}` : "/api/whoami", [sel]);
  return <div className="promo-page"><a.Msg />
    <Card title="Qualified entries (immutable awards; current eligibility from events)" right={<div className="row"><Input placeholder="Period" value={f.period || ""} onChange={(e) => setF({ ...f, period: e.target.value })} style={{ maxWidth: 90 }} /><select className="field" value={f.status || ""} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">all</option><option>active</option><option>excluded</option></select></div>}>
      <Table cols={["Entry", "Receipt", "Period", "Status", "Awarded", ""]} rows={l.data?.entries} render={(e) => <tr key={e.id}><td className="mono">{short(e.id, 14)}</td><td className="mono">{e.reference}</td><td>{e.period_code}</td><td><Chip s={e.status} /></td><td className="sub">{fmt(e.created_at)}</td><td><Btn ghost small onClick={() => setSel(e.id)}>Trace</Btn></td></tr>} />
    </Card>
    {sel && detail.data?.entry && <Card title={`Trace ${short(sel, 14)}`} right={<Btn ghost small onClick={() => setSel(null)}>Close</Btn>}>
      <div className="row"><Field label="Receipt">{detail.data.receipt?.id} · <Chip s={detail.data.receipt?.status} /></Field><Field label="Decided by">{detail.data.receipt?.decided_by} at {fmt(detail.data.receipt?.decided_at)}</Field><Field label="Canonical receipt"><span className="mono">{detail.data.canonical?.canonical_key}</span></Field><Field label="Rules version"><span className="mono">{short(detail.data.rules_version, 12)}</span></Field></div>
      <Table cols={["Validation attempt", "Extractor", "Decision", "At"]} rows={detail.data.validation} render={(v, i) => <tr key={i}><td>{v.attempt_no}</td><td>{v.extractor_provider} {v.extractor_version}</td><td><Chip s={v.decision} /></td><td className="sub">{fmt(v.created_at)}</td></tr>} />
      <Table cols={["Draw", "Period", "Draw status", "Candidate status"]} rows={detail.data.draws} empty="Not in any draw yet." render={(x) => <tr key={x.id}><td className="mono">{short(x.id, 12)}</td><td>{x.draw_period}</td><td><Chip s={x.status} /></td><td><Chip s={x.candidate_status} /></td></tr>} />
      <Table cols={["Event", "Reason", "Actor", "Approved by", "Effective"]} rows={detail.data.events} empty="No eligibility events." render={(x) => <tr key={x.id}><td>{x.type}</td><td>{x.reason}</td><td className="sub">{short(x.actor_id, 10)}</td><td className="sub">{x.approved_by ? short(x.approved_by, 10) : "—"}</td><td className="sub">{fmt(x.effective_at)}</td></tr>} />
      <Table cols={["Audit action", "Actor", "Reason", "At"]} rows={detail.data.audit} render={(x, i) => <tr key={i}><td className="mono">{x.action}</td><td className="sub">{short(x.actor_id, 10)}</td><td className="sub">{x.reason}</td><td className="sub">{fmt(x.created_at)}</td></tr>} />
      {(me.roles.includes("reviewer") || me.roles.includes("campaign_manager")) && <div className="row" style={{ marginTop: 8 }}>{detail.data.entry.status === "active" ? <Btn danger small onClick={() => { const reason = prompt("Disqualification reason?"); if (!reason) return; const approved_by = prompt("Approver user id (required if the entry is in a frozen draw)") || undefined; a.run(() => api(`/api/entries/${sel}/disqualify`, { method: "POST", body: { reason, approved_by } })).then(() => { reload(); setSel(null); }); }}>Disqualify (audited)</Btn> : <Btn ghost small onClick={() => { const reason = prompt("Reinstatement reason?"); if (!reason) return; const approved_by = prompt("Approver user id (required if the disqualification was itself dual-controlled)") || undefined; a.run(() => api(`/api/entries/${sel}/reinstate`, { method: "POST", body: { reason, approved_by } })).then(() => { reload(); setSel(null); }); }}>Reinstate (audited)</Btn>}</div>}
    </Card>}
  </div>;
}

/* ===================== draws ===================== */
/**
 * Which campaign the Draws view opens on. The old rule — first of
 * active|paused|closed in /api/campaigns order (created_at ascending) — picked
 * the oldest campaign, so the seeded sample campaign captured the whole view and
 * the client's real campaign could never be frozen, executed or published from
 * the console (while Overview, which uses the server's rule, reported the real
 * one). This mirrors admin.mjs activeCampaignId(): newest active-or-paused.
 * Closed campaigns remain selectable — the last period is drawn after close —
 * but never outrank a live campaign.
 */
function defaultDrawCampaignId(campaigns = []) {
  const newest = (statuses) => campaigns.filter((c) => statuses.includes(c.status)).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
  return (newest(["active", "paused"]) || newest(["closed"]))?.id || null;
}
function Draws({ me }) {
  const [camps] = useApi("/api/campaigns"); const all = camps.data?.campaigns || []; const [picked, setPicked] = useState("");
  const cid = (all.some((c) => c.id === picked) ? picked : null) || defaultDrawCampaignId(all);
  const [periods] = useApi(cid ? `/api/campaigns/${cid}/periods` : "/api/whoami", [cid]); const [draws, reload] = useApi(cid ? `/api/campaigns/${cid}/draws` : "/api/whoami", [cid]); const [pid, setPid] = useState(""); const [barrier, setBarrier] = useState(null); const [sel, setSel] = useState(null); const a = useAction();
  // A failed barrier check (403/404/500) must not render as "barrier clear": the
  // envelope is kept as an error instead of being shown as an empty-but-green result.
  const check = async () => { const r = await api(`/api/campaigns/${cid}/periods/${pid}/barrier`); setBarrier(r.ok ? r.data : { error: r.data?.error?.message || `HTTP ${r.status}` }); };
  const act = (id, action, body = {}, c) => a.run(() => api(`/api/draws/${id}/${action}`, { method: "POST", body }), c ? { confirm: c } : {}).then(reload);
  const can = (r) => me.roles.includes(r);
  return <div className="promo-page"><a.Msg />
    <Card title="Prepare a draw (cutoff barrier → freeze → execute → independent approval → publish)">
      <div className="row"><Field label="Campaign"><select className="field" value={cid || ""} onChange={(e) => { setPicked(e.target.value); setPid(""); setBarrier(null); }}>{all.length ? null : <option value="">— none —</option>}{all.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name} ({c.status})</option>)}</select></Field><Field label="Period"><select className="field" value={pid} onChange={(e) => { setPid(e.target.value); setBarrier(null); }}><option value="">— choose —</option>{(periods.data?.periods || []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.label} ({p.status})</option>)}</select></Field><Btn ghost disabled={!pid} onClick={check}>Check barrier</Btn>{can("draw_officer") && <Btn disabled={!barrier?.ok || a.busy} onClick={() => a.run(() => api("/api/draws", { method: "POST", body: { campaign_id: cid, period_id: pid } }), { confirm: "Freeze the candidate pool and commit randomness for this period?" }).then(() => { setBarrier(null); reload(); })}>Freeze candidates</Btn>}</div>
      {barrier?.error && <Err e={`Barrier check failed: ${barrier.error}`} />}
      {barrier && !barrier.error && <div style={{ marginTop: 10 }}><div className="row"><Field label="Eligible entries">{barrier.eligible}</Field><Field label="Distinct participants">{barrier.distinctParticipants}</Field><Field label="Excluded">{barrier.exclusions}</Field><Field label="Prize plan">{barrier.plan?.tiers?.map((t) => `${t.count} × ${t.label}`).join(", ")} · alternates {barrier.plan?.totalAlternates} · {barrier.plan?.onePrizePerParticipant ? "one prize per participant" : "multiple prizes allowed"}</Field></div>{barrier.blockers?.length ? <Table cols={["Blocker", "Detail"]} rows={barrier.blockers} render={(b, i) => <tr key={i}><td className="mono">{b.code}</td><td className="sub mono">{b.detail ? JSON.stringify(b.detail) : ""}</td></tr>} /> : <div className="note">Barrier clear — the period can be frozen.</div>}</div>}
    </Card>
    <Card title="Draws">
      <Table cols={["Period", "Status", "Snapshot", "Output", "Officer", "Approver", "Created", ""]} rows={draws.data?.draws} render={(d) => <tr key={d.id}><td className="mono">{d.period_code || d.draw_period}{d.supersedes ? " (rerun)" : ""}</td><td><Chip s={d.status} /></td><td className="mono sub">{short(d.snapshot_hash, 10)}</td><td className="mono sub">{d.output_hash ? short(d.output_hash, 10) : "—"}</td><td className="sub">{short(d.operator_id, 10)}</td><td className="sub">{d.approver_id ? short(d.approver_id, 10) : "—"}</td><td className="sub">{fmt(d.created_at)}</td><td className="actions">
        <Btn ghost small onClick={() => setSel(d.id)}>Detail</Btn>
        {d.status === "frozen" && can("draw_officer") && <Btn small onClick={() => act(d.id, "execute", {}, "Execute the draw now? The result is derived from the committed seed and cannot be re-rolled.")}>Execute</Btn>}
        {d.status === "executed" && can("draw_approver") && <><Btn small onClick={() => act(d.id, "approve", { expected_output_hash: d.output_hash, note: prompt("Approval note (optional)") || "" }, `Approve result ${short(d.output_hash, 12)}? You confirm you reviewed the frozen candidates and the integrity check.`)}>Approve</Btn> <Btn ghost small onClick={() => act(d.id, "reject", { reason: prompt("Rejection reason?") || "" })}>Reject</Btn></>}
        {d.status === "approved" && can("winner_ops") && <Btn small onClick={() => act(d.id, "publish", {}, "Publish the draw and create winner records? Winners are not visible publicly until verified and individually published.")}>Publish</Btn>}
        {["approved", "published"].includes(d.status) && can("draw_officer") && <Btn danger small onClick={() => { const reason = prompt("Reason for rerun (void + new linked draw)?"); const approved_by = prompt("Second approver user id?"); if (reason && approved_by) act(d.id, "rerun", { reason, approved_by }); }}>Void + rerun</Btn>}
      </td></tr>} />
    </Card>
    {sel && <DrawDetail id={sel} me={me} onClose={() => setSel(null)} />}
  </div>;
}
function DrawDetail({ id, me, onClose }) {
  const [d] = useApi(`/api/draws/${id}`); if (d.loading) return <Loading />; const x = d.data?.draw; if (!x) return null;
  return <Card title={`Draw ${x.period} — ${x.status}`} right={<div className="row">{(me.roles.includes("auditor") || me.roles.includes("draw_approver")) && <Btn ghost small onClick={async () => {
      // The bundle route needs the bearer header; window.open sends none, and
      // the old "?token=" was always empty. Fetch it and save it properly.
      const r = await api(`/api/draws/${id}/bundle`);
      if (!r.ok) return alert(`Bundle unavailable (HTTP ${r.status})`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }));
      a.download = `draw-${id}-bundle.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }}>Download bundle</Btn>}<Btn ghost small onClick={onClose}>Close</Btn></div>}>
    <div className="row"><Field label="Snapshot hash"><span className="mono">{x.snapshot_hash}</span></Field><Field label="Output hash"><span className="mono">{x.output_hash || "—"}</span></Field><Field label="Candidates">{d.data.candidates}</Field><Field label="Integrity">{x.integrity?.ok ? <Chip s="verified" /> : <Chip s="critical" />} {x.integrity?.problems?.join("; ")}</Field><Field label="Barrier at freeze"><span className="sub mono">{JSON.stringify(x.barrier?.blockers || [])}</span></Field></div>
    {x.output && <Table cols={["Rank", "Entry", "Participant", "Prize"]} rows={x.output.winners} render={(w) => <tr key={w.entryId}><td>{w.position}</td><td className="mono">{short(w.entryId, 14)}</td><td className="mono">{short(w.participantId, 14)}</td><td>{w.prize_code}</td></tr>} />}
    <Table cols={["Attempt", "Actor", "Outcome", "At"]} rows={d.data.attempts} render={(t, i) => <tr key={i}><td>{i + 1}</td><td className="sub">{short(t.actor_id, 10)}</td><td>{t.outcome}</td><td className="sub">{fmt(t.created_at)}</td></tr>} />
    <div className="sub">Independent verification: download the bundle via GET /api/draws/{id}/bundle (auditor) and run <span className="mono">npm run verify:draw -- bundle.json</span>.</div>
  </Card>;
}

/* ===================== winners ===================== */
function Winners({ me }) {
  const [l, reload] = useApi("/api/winners"); const [sel, setSel] = useState(null); const a = useAction(); const [outlets] = useApi("/api/outlets");
  const [detail, reloadDetail] = useApi(sel ? `/api/winners/${sel}` : "/api/whoami", [sel]);
  // Publish/unpublish are granted to winner_ops AND campaign_manager server-side
  // (admin.mjs), so gating them on winner_ops alone hid the button from the role
  // that is meant to maintain the published winners list.
  const can = me.roles.includes("winner_ops"); const canPublish = hasRole(me, "winner_ops", "campaign_manager"); const both = () => { reload(); reloadDetail(); };
  // Claim-step inputs. They used to be prompt() dialogs: pressing Escape on the
  // evidence prompt recorded a verified winner with an empty ID-check note, and
  // the collection outlet was an internal id typed by hand from five of ~80
  // branches — accepted unvalidated, only failing days later at collection.
  const [claim, setClaim] = useState({});
  const tr = (id, status, extra = {}, c) => a.run(() => api(`/api/winners/${id}/transition`, { method: "POST", body: { status, ...extra } }), c ? { confirm: c } : {}).then((r) => { both(); return r; });
  return <div className="promo-page"><a.Msg />
    <Card title="Winners, claims and publication"><Table cols={["Period", "Rank", "Name", "Phone", "Prize", "Status", "Published", "Claim by", ""]} rows={l.data?.winners} render={(w) => <tr key={w.id}><td className="mono">{w.draw_period}</td><td>{w.rank}</td><td>{w.display_name}</td><td className="mono">{w.wa_phone_uid}</td><td>{w.published_fields?.prize}</td><td><Chip s={w.status} /></td><td><Chip s={w.publication_state} /></td><td className="sub">{fmt(w.claim_expires_at)}</td><td><Btn ghost small onClick={() => setSel(w.id)}>Open</Btn></td></tr>} /></Card>
    {sel && detail.data?.winner && (() => { const w = detail.data.winner; const collect = (outlets.data?.outlets || []).filter((o) => o.collection_enabled && o.active); const outletPick = () => <Field label="Assign collection point"><select className="field" value={claim.outlet || ""} onChange={(e) => setClaim({ ...claim, outlet: e.target.value })}><option value="">— choose a collection point —</option>{collect.map((o) => <option key={o.id} value={o.id}>{o.retailer} — {o.branch}, {o.town}</option>)}</select></Field>; return <Card title={`Winner ${w.display_name} — ${w.status}`} right={<Btn ghost small onClick={() => setSel(null)}>Close</Btn>}>
      <div className="row"><Field label="Prize">{w.published_fields?.prize}</Field><Field label="Participant">{w.participant?.first_name} {w.participant?.surname} · {w.participant?.phone} · ID {w.participant?.identity_masked || "—"}</Field><Field label="Collection outlet">{w.collection_outlet ? `${w.collection_outlet.retailer} — ${w.collection_outlet.branch}` : "—"}</Field><Field label="Claim deadline">{fmt(w.claim_expires_at)}</Field><Field label="Fulfilled">{w.fulfilled_at ? `${fmt(w.fulfilled_at)} (${w.fulfilment_ref || "no ref"})` : "—"}</Field></div>
      {can && <div className="row" style={{ marginTop: 10 }}>
        {["selected", "unreachable"].includes(w.status) && <Btn onClick={() => a.run(() => api(`/api/winners/${w.id}/notify`, { method: "POST" }), { confirm: "Send the approved winner message on WhatsApp to this participant?" }).then(both)}>Notify on WhatsApp</Btn>}
        {w.status === "notified" && <><Field label="Verification evidence (required)"><Input value={claim.note || ""} onChange={(e) => setClaim({ ...claim, note: e.target.value })} placeholder="e.g. ID 63-… checked by J. Moyo on a call" /></Field><Btn disabled={a.busy || !(claim.note || "").trim()} onClick={() => tr(w.id, "verified", { expected_version: w.row_version, note: claim.note.trim() }).then((r) => { if (r?.ok) setClaim({}); })}>Mark verified</Btn></>}
        {w.status === "verified" && <>{outletPick()}<Btn disabled={a.busy || !claim.outlet} onClick={() => tr(w.id, "accepted", { expected_version: w.row_version, collection_outlet_id: claim.outlet }).then((r) => { if (r?.ok) setClaim({}); })}>Accepted (assign collection)</Btn></>}
        {w.status === "accepted" && <><Field label="Fulfilment reference / slip number"><Input value={claim.ref || ""} onChange={(e) => setClaim({ ...claim, ref: e.target.value })} /></Field>{!w.collection_outlet_id && outletPick()}<Btn disabled={a.busy || !(w.collection_outlet_id || claim.outlet)} onClick={() => tr(w.id, "collected", { expected_version: w.row_version, fulfilment_ref: (claim.ref || "").trim() || undefined, collection_outlet_id: w.collection_outlet_id || claim.outlet }, "Record prize collection? This is recorded once and cannot be undone.").then((r) => { if (r?.ok) setClaim({}); })}>Record collection</Btn></>}
        {!["collected", "replaced"].includes(w.status) && <><Btn ghost onClick={() => tr(w.id, "unreachable", { expected_version: w.row_version })}>Unreachable</Btn><Btn ghost onClick={() => tr(w.id, "declined", { expected_version: w.row_version })}>Declined</Btn><Btn ghost onClick={() => tr(w.id, "disputed", { expected_version: w.row_version, note: prompt("Dispute note") || "" })}>Disputed</Btn><Btn danger onClick={() => tr(w.id, "ineligible", { expected_version: w.row_version, reason: prompt("Ineligibility reason") || "" }, "Mark ineligible?")}>Ineligible</Btn><Btn danger onClick={() => tr(w.id, "replaced", { expected_version: w.row_version, reason: prompt("Replacement reason") || "" }, "Replace with the next approved alternate? This is audited and cannot be undone.")}>Replace with alternate</Btn></>}
      </div>}
      {canPublish && <div className="row" style={{ marginTop: 10 }}>
        {["verified", "accepted", "collected"].includes(w.status) && w.publication_state !== "published" && <Btn onClick={() => a.run(() => api(`/api/winners/${w.id}/publish`, { method: "POST" }), { confirm: "Publish this winner (name initial, town, prize, week) to the public winners list?" }).then(both)}>Publish</Btn>}
        {w.publication_state === "published" && <Btn ghost onClick={() => a.run(() => api(`/api/winners/${w.id}/unpublish`, { method: "POST", body: { reason: prompt("Reason?") || "" } })).then(both)}>Withdraw publication</Btn>}
      </div>}
      <Table cols={["Claim state", "Detail", "At"]} rows={detail.data.claims} render={(c) => <tr key={c.id}><td><Chip s={c.state} /></td><td className="sub mono">{c.detail_json}</td><td className="sub">{fmt(c.transitioned_at)}</td></tr>} />
      <Table cols={["Message", "Status", "Attempts", "Error", "Sent", "Delivered", "Read"]} rows={detail.data.messages} empty="No messages yet." render={(m) => <tr key={m.id}><td>{m.purpose}</td><td><Chip s={m.status} /></td><td>{m.attempts}</td><td className="sub">{m.error_code || m.last_error || ""}</td><td className="sub">{fmt(m.sent_at)}</td><td className="sub">{fmt(m.delivered_at)}</td><td className="sub">{fmt(m.read_at)}</td></tr>} />
    </Card>; })()}
  </div>;
}

/* ===================== integrations ===================== */
function Integrations({ me }) {
  const [i, reload] = useApi("/api/integrations"); const [ob, reloadOb] = useApi("/api/outbound"); const [crm, reloadCrm] = useApi("/api/crm/events"); const [q, reloadQ] = useApi("/api/queue"); const [mp] = useApi("/api/crm/mapping-preview?type=entry"); const a = useAction();
  if (i.loading) return <Loading />; const d = i.data; if (!d) return <Err e={i.error} />;
  const Health = ({ label, h }) => <Field label={label}><Chip s={h?.mode || (h?.ok ? "ok" : "x")} /> <span className="sub">{h?.provider || ""} {h?.note || h?.error || ""}</span></Field>;
  return <div className="promo-page"><a.Msg />
    <Card title="Provider status" right={<Btn ghost small onClick={reload}>Refresh</Btn>}><div className="row"><Health label="WhatsApp transport" h={d.transport} /><Health label="Receipt extractor" h={d.extractor} /><Health label="CRM" h={d.crm} /><Field label="Database">{d.database.ok ? <Chip s="ok" /> : <Chip s="x" />} <span className="sub">{d.database.file}</span></Field><Field label="Storage">{d.storage.assets} assets · {d.storage.dir}</Field><Field label="Worker">{d.worker?.running ? <Chip s="ok" /> : <Chip s="x" />} last tick {fmt(d.worker?.lastTick)}</Field><Field label="Last outbound success">{fmt(d.last_outbound_success)}</Field><Field label="Last inbound">{fmt(d.last_inbound)}</Field></div>
      <div className="sub" style={{ marginTop: 8 }}>Environment: <b>{d.environment}</b>. Simulated or unconfigured providers are labelled; "configured" means credentials present, not proven delivery.</div></Card>
    <Card title={`Outbound messages (${JSON.stringify(d.outbound.byStatus)})`} right={<Btn ghost small onClick={reloadOb}>Refresh</Btn>}><Table cols={["Purpose", "To", "Status", "Attempts", "Error", "Created", ""]} rows={(ob.data?.messages || []).slice(0, 50)} render={(m) => <tr key={m.id}><td>{m.purpose}</td><td className="mono">{m.wa_phone_uid}</td><td><Chip s={m.status} /></td><td>{m.attempts}</td><td className="sub">{m.error_code || m.last_error || ""}</td><td className="sub">{fmt(m.created_at)}</td><td>{["retryable_failure", "permanent_failure", "unknown_outcome"].includes(m.status) && <Btn ghost small onClick={() => a.run(() => api(`/api/outbound/${m.id}/retry`, { method: "POST" }), { confirm: "Retry this message? For unknown outcomes, confirm with the provider first to avoid a duplicate." }).then(reloadOb)}>Retry</Btn>}</td></tr>} /></Card>
    <Card title={`CRM outbox — ${d.crm_queue.provider} (${["pending", "delivered", "retryable_failure", "permanent_failure", "unknown_outcome", "reconciled"].map((k) => `${k} ${d.crm_queue[k]}`).join(" · ")})`} right={<div className="row"><Btn ghost small onClick={() => a.run(() => api("/api/crm/reconcile", { method: "POST" })).then(reloadCrm)}>Reconcile</Btn><Btn ghost small onClick={reloadCrm}>Refresh</Btn></div>}>
      <Table cols={["Entity", "Version", "Status", "Attempts", "Error", "Read-back", ""]} rows={(crm.data?.events || []).slice(0, 50)} render={(e) => <tr key={e.id}><td className="mono">{e.entity_type}:{short(e.entity_id, 10)}</td><td>{e.entity_version}</td><td><Chip s={e.status} /></td><td>{e.attempts}</td><td className="sub">{e.last_error || ""}</td><td className="sub">{fmt(e.readback_at)}</td><td>{["retryable_failure", "permanent_failure", "unknown_outcome"].includes(e.status) && <Btn ghost small onClick={() => a.run(() => api(`/api/crm/events/${e.id}/retry`, { method: "POST" })).then(reloadCrm)}>Retry</Btn>}</td></tr>} />
      {mp.data && <div className="sub" style={{ marginTop: 8 }}>Mapping preview ({mp.data.mapping_version}; excluded by default: {mp.data.excluded_by_default.join(", ")}): <span className="mono">{JSON.stringify(mp.data.record)}</span></div>}
    </Card>
    <Card title="Queues (inbound events + jobs)" right={<Btn ghost small onClick={reloadQ}>Refresh</Btn>}><div className="row"><Field label="Events">{JSON.stringify(q.data?.events || {})}</Field><Field label="Jobs">{JSON.stringify(q.data?.jobs || {})}</Field><Field label="Oldest event">{fmt(q.data?.oldestEvent)}</Field><Field label="Oldest job">{fmt(q.data?.oldestJob)}</Field></div>
      <Table cols={["Dead/failed event", "Kind", "Error", "Attempts", ""]} rows={q.data?.dead_events} empty="No dead-lettered events." render={(e) => <tr key={e.id}><td className="mono">{short(e.id, 12)}</td><td>{e.event_kind}</td><td className="sub">{e.error}</td><td>{e.attempts}</td><td><Btn ghost small onClick={() => a.run(() => api(`/api/queue/events/${e.id}/replay`, { method: "POST" })).then(reloadQ)}>Replay</Btn></td></tr>} />
      <Table cols={["Dead/failed job", "Kind", "Error", "Attempts", ""]} rows={q.data?.dead_jobs} empty="No dead-lettered jobs." render={(j) => <tr key={j.id}><td className="mono">{short(j.id, 12)}</td><td>{j.kind}</td><td className="sub">{j.last_error}</td><td>{j.attempts}</td><td><Btn ghost small onClick={() => a.run(() => api(`/api/queue/jobs/${j.id}/retry`, { method: "POST" })).then(reloadQ)}>Retry</Btn></td></tr>} /></Card>
  </div>;
}

/* ===================== access ===================== */
function Access({ me }) {
  const [l, reload] = useApi("/api/users"); const [f, setF] = useState({ roles: [] }); const a = useAction(); const [temp, setTemp] = useState(null); const [mfa, setMfa] = useState(null); const [code, setCode] = useState("");
  const roles = l.data?.roles || [];
  return <div className="promo-page"><a.Msg />
    {me.roles.includes("platform_admin") && <Card title="Create staff account (temporary password shown once; must be changed at first sign-in)"><div className="row"><Field label="Email"><Input value={f.email || ""} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field><Field label="Name"><Input value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Roles"><div className="row">{roles.map((r) => <label key={r} className="check"><input type="checkbox" checked={f.roles.includes(r)} onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r] : f.roles.filter((x) => x !== r) })} /> {r}</label>)}</div></Field><Btn disabled={a.busy} onClick={async () => { const r = await a.run(() => api("/api/users", { method: "POST", body: f })); if (r?.ok) { setTemp(r.data); setF({ roles: [] }); reload(); } }}>Create</Btn></div>{temp && <div className="notice-ok">Created {temp.user.email}. Temporary password (share securely, shown once): <span className="mono">{temp.temporaryPassword}</span></div>}</Card>}
    {/* a 403/500 here used to render as the empty-state "Nothing here yet.", i.e. "no staff accounts exist" */}
    <Card title="Staff accounts">{l.error ? <Err e={l.error} /> : null}<Table cols={["Email", "Name", "Roles", "MFA", "Status", "Temp pw", "Last login", ""]} rows={l.data?.users} render={(u) => <tr key={u.id}><td>{u.email}</td><td>{u.name}</td><td className="sub">{u.roles.join(", ")}</td><td>{u.mfa_enabled ? <Chip s="ok" /> : <Chip s="warning" />}</td><td><Chip s={u.status} /></td><td>{u.must_change_password ? "yes" : ""}</td><td className="sub">{fmt(u.last_login_at)}</td><td>{me.roles.includes("platform_admin") && u.id !== me.id && <><Btn ghost small onClick={() => { const r = prompt("Roles (comma separated)", u.roles.join(",")); if (r != null) a.run(() => api(`/api/users/${u.id}`, { method: "PATCH", body: { roles: r.split(",").map((x) => x.trim()).filter(Boolean) } })).then(reload); }}>Roles</Btn> <Btn ghost small onClick={() => a.run(() => api(`/api/users/${u.id}`, { method: "PATCH", body: { status: u.status === "active" ? "disabled" : "active" } }), { confirm: `${u.status === "active" ? "Disable" : "Enable"} ${u.email}? Sessions are revoked.` }).then(reload)}>{u.status === "active" ? "Disable" : "Enable"}</Btn> <Btn ghost small onClick={async () => { const r = await a.run(() => api(`/api/users/${u.id}/reset-password`, { method: "POST" }), { confirm: `Reset password for ${u.email}?` }); if (r?.ok) setTemp({ user: u, temporaryPassword: r.data.temporaryPassword }); }}>Reset pw</Btn></>}</td></tr>} /></Card>
    <Card title="My security"><div className="row"><Field label="MFA">{me.mfa ? <Chip s="ok" /> : <Chip s="warning" />}</Field>{!me.mfa && <Btn ghost onClick={async () => { const r = await api("/api/mfa/enroll", { method: "POST" }); setMfa(r.data); }}>Enrol authenticator app</Btn>}{mfa && <><Field label="Secret (add to your authenticator app)"><span className="mono">{mfa.secret}</span><div className="sub mono">{mfa.otpauth}</div></Field><Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field><Btn onClick={() => a.run(() => api("/api/mfa/enable", { method: "POST", body: { code } })).then(() => location.reload())}>Enable MFA</Btn></>}</div></Card>
  </div>;
}

/* ===================== audit + readiness ===================== */
function AuditView() { const [f, setF] = useState({}); const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); const [l] = useApi(`/api/audit-events?${qs}`, [qs]); const [v] = useApi("/api/audit/verify"); const a = useAction(); return <div className="promo-page"><Card title="Audit chain" right={<Btn ghost small onClick={() => a.run(() => api("/api/audit/checkpoint", { method: "POST" })).then(() => alert("Checkpoint signed"))}>Sign checkpoint</Btn>}>
  {/* The tab is offered to every role but the route is auditor/platform_admin
      only. Reading the verdict off absent data told a campaign manager (403) or
      an auditor mid-request that the tamper-evident chain was BROKEN, while
      simultaneously giving a green "every event signs who acted" that was never
      computed. No verdict is rendered unless the check actually answered. */}
  {v.loading ? <Loading /> : !v.data ? <Err e={v.error || "chain verification unavailable"} /> : <div className="row"><Field label="Chain">{v.data.ok ? <Chip s="verified" /> : <Chip s="critical" />} {v.data.total} events{v.data.brokenCount ? ` · ${v.data.brokenCount} broken` : ""}</Field><Field label="Attribution">{v.data.unattributed ? <Chip s="warning" /> : <Chip s="ok" />} {v.data.unattributed ? `${v.data.unattributed} event(s) written before attribution was signed — who acted on those is not tamper-evident` : "every event signs who acted"}</Field></div>}<a.Msg /></Card><Card title="Events" right={<div className="row"><Input placeholder="target type" value={f.target_type || ""} onChange={(e) => setF({ ...f, target_type: e.target.value })} style={{ maxWidth: 140 }} /><Input placeholder="target id" value={f.target_id || ""} onChange={(e) => setF({ ...f, target_id: e.target.value })} style={{ maxWidth: 200 }} /><Input placeholder="action" value={f.action || ""} onChange={(e) => setF({ ...f, action: e.target.value })} style={{ maxWidth: 160 }} /></div>}>{l.error ? <Err e={l.error} /> : null}<Table cols={["#", "Actor", "Action", "Target", "Reason", "Hash", "At"]} rows={l.data?.events} render={(e) => <tr key={e.id}><td>{e.id}</td><td className="sub">{e.actor_type}:{short(e.actor_id, 10)}</td><td className="mono">{e.action}</td><td className="mono sub">{e.target_type}:{short(e.target_id, 12)}</td><td className="sub">{e.reason}</td><td className="mono sub">{short(e.entry_hash, 10)}</td><td className="sub">{fmt(e.created_at)}</td></tr>} /></Card><Card title="Exports (auditor; watermarked, formula-safe CSV)"><div className="row">{["receipts", "entries", "winners", "participants", "audit", "outlets"].map((s) => <Btn key={s} ghost small onClick={() => api(`/api/reports/export?scope=${s}&format=json`).then((r) => { /* without this, a 403 envelope was written to disk as e.g. receipts.json and looked like an export */ if (!r.ok) return alert(`Export failed: ${r.data?.error?.message || `HTTP ${r.status}`}`); const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(blob); const el = document.createElement("a"); el.href = u; el.download = `${s}.json`; el.click(); })}>Export {s}</Btn>)}</div></Card></div>; }
/**
 * One row of the readiness evidence table, with the control that records it.
 *
 * activation.mjs makes BENCHMARK_ACCEPTANCE, RESTORE_REHEARSAL and CLIENT_UAT
 * blocking gates for production activation, but the console only displayed
 * "not recorded": clearing a documented go-live gate needed a hand-written
 * POST /api/evidence/:kind. Recording is audited and campaign_manager-only,
 * which is why the control carries the note and reference into the payload.
 */
function EvidenceRow({ kind, value, me, onRecorded }) {
  const [note, setNote] = useState(""); const [ref, setRef] = useState(""); const a = useAction();
  const can = hasRole(me, "campaign_manager");
  return <tr>
    <td className="mono">{kind}</td>
    <td className="sub">{value ? `${fmt(value.at)} by ${value.recordedBy}${value.note ? ` — ${value.note}` : ""}${value.reference ? ` (${value.reference})` : ""}` : "not recorded"}</td>
    <td>{can ? <div className="row"><Input placeholder="what was accepted, by whom" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 240 }} /><Input placeholder="reference (email/doc)" value={ref} onChange={(e) => setRef(e.target.value)} style={{ maxWidth: 160 }} /><Btn small disabled={a.busy || !note.trim()} onClick={() => a.run(() => api(`/api/evidence/${kind}`, { method: "POST", body: { note: note.trim(), reference: ref.trim() || undefined } }), { confirm: `Record ${kind}? This is audited and clears the matching production activation blocker.` }).then((x) => { if (x?.ok) { setNote(""); setRef(""); onRecorded(); } })}>{value ? "Re-record" : "Record"}</Btn><a.Msg /></div> : <span className="sub">campaign manager records this</span>}</td>
  </tr>;
}
function Readiness({ me }) { const [r, reload] = useApi("/api/readiness"); if (r.loading) return <Loading />; const d = r.data; if (!d) return <Err e={r.error} />; const L = ({ ok, label, note }) => <div className="row" style={{ alignItems: "center" }}><Chip s={ok ? "ok" : "warning"} /><b>{label}</b><span className="sub">{note}</span></div>; return <div className="promo-page">
  <Card title="Readiness levels (evidence-backed)"><L ok={d.levels.locally_testable} label="Locally testable" note="app, database, storage, worker, console, sample campaign and automated tests from documented commands" /><L ok={d.levels.integrated_client_testing} label="Ready for integrated client testing" note={`requires WhatsApp transport = configured Cloud API (now: ${d.providers.transport?.provider} / ${d.providers.transport?.mode}) and a real extractor (now: ${d.providers.extractor?.provider} / ${d.providers.extractor?.mode})`} /><L ok={false} label="Approved for production launch" note="requires approved decisions, live assets, client UAT sign-off, ownership and production gates (see Activation)" /></Card>
  <Card title="Providers"><div className="row"><Field label="WhatsApp"><Chip s={d.providers.transport?.mode} /> {d.providers.transport?.provider} {d.providers.transport?.note}</Field><Field label="Extractor"><Chip s={d.providers.extractor?.mode} /> {d.providers.extractor?.provider} {d.providers.extractor?.model || ""} {d.providers.extractor?.note || ""}</Field><Field label="CRM"><Chip s={d.providers.crm?.mode} /> {d.providers.crm?.provider} {d.providers.crm?.note || ""}</Field><Field label="Environment"><b>{d.environment}</b></Field><Field label="Sample data">{d.sample_data ? <Chip s="warning" /> : <Chip s="ok" />} {d.sample_data?.note || "none"}</Field></div></Card>
  <Card title={`Open client decisions (${d.open_decisions.length})`}><Table cols={["ID", "Question", "Test-only value in use"]} rows={d.open_decisions} empty="All decisions approved." render={(x) => <tr key={x.id}><td className="mono">{x.id}</td><td>{x.question}</td><td className="sub">{x.test_value}</td></tr>} /></Card>
  <Card title="Evidence recorded" right={<Btn ghost small onClick={reload}>Refresh</Btn>}><Table cols={["Kind", "Recorded", "Record"]} rows={d.evidence} render={(e) => <EvidenceRow key={e.kind} kind={e.kind} value={e.value} me={me} onRecorded={reload} />} /></Card>
  <Card title="Activation blockers"><Table cols={["Code", "Message"]} rows={d.activation?.failures || []} empty="none" render={(f) => <tr key={f.code}><td className="mono">{f.code}</td><td>{f.message}</td></tr>} /></Card>
  <Card title="Staff"><Table cols={["Email", "Roles", "MFA", "Temp password"]} rows={d.staff} render={(s) => <tr key={s.email}><td>{s.email}</td><td className="sub">{s.roles.join(", ")}</td><td>{s.mfa ? "yes" : "no"}</td><td>{s.temp_password ? "yes" : ""}</td></tr>} /></Card>
</div>; }

/* ===================== support / conversations ===================== */
/**
 * Support handoff console.
 *
 * A participant who types "support" (or agent/human/help me) is pinned to
 * handoff_owner='queue' by conversation.mjs and every later message — including
 * "2" to enter a receipt — is answered only with "our team is handling your
 * conversation". Nothing expires it. The four endpoints that unpin it existed
 * but no console component called them, so the documented Claim/Send/Release
 * runbook could only be followed with curl and the participant stayed locked out
 * of registration and entry. Acknowledging the alert does NOT release the
 * conversation; only Release does.
 */
function Support({ me }) {
  const [q, setQ] = useState(""); const [phone, setPhone] = useState(""); const [c, setC] = useState(null); const [text, setText] = useState(""); const a = useAction();
  const load = async (p) => { const ph = String(p || "").replace(/\D/g, ""); if (!ph) return; setPhone(ph); const r = await api(`/api/conversations/${encodeURIComponent(ph)}`); setC(r.ok ? r.data : { error: r.data?.error?.message || `HTTP ${r.status}` }); };
  const act = (path, body, confirm) => a.run(() => api(`/api/conversations/${encodeURIComponent(phone)}/${path}`, { method: "POST", body }), confirm ? { confirm } : {}).then((r) => { if (r?.ok) load(phone); return r; });
  const s = c?.session; const canAct = hasRole(me, "support");
  return <div className="promo-page"><a.Msg />
    <Card title="Conversation" right={<div className="row"><Input placeholder="Participant number, e.g. 263771234567" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(q)} style={{ maxWidth: 240 }} /><Btn small onClick={() => load(q)}>Open</Btn>{phone && <Btn ghost small onClick={() => load(phone)}>Refresh</Btn>}</div>}>
      <div className="sub">Open alerts name the participant by masked number only — take the full number from the WhatsApp thread. Automation stays paused for this participant until you Release.</div>
      {c?.error && <Err e={c.error} />}
      {c && !c.error && <>
        <div className="row" style={{ marginTop: 8 }}><Field label="Participant">{c.participant ? `${c.participant.first_name} ${c.participant.surname} · ${c.participant.phone}` : "not registered"}</Field><Field label="Session state">{s ? <Chip s={s.state} /> : "no session"}</Field><Field label="Handoff">{s?.handoff_owner ? <><Chip s="warning" /> {s.handoff_owner === "queue" ? "waiting for an operator" : `claimed by ${short(s.handoff_owner, 10)}`} since {fmt(s.handoff_since)}</> : "automation running"}</Field></div>
        {canAct && <div className="row" style={{ marginTop: 10 }}>
          {s?.handoff_owner && s.handoff_owner !== me.id && <Btn disabled={a.busy} onClick={() => act("claim")}>Claim</Btn>}
          {s?.handoff_owner && <Btn danger disabled={a.busy} onClick={() => act("release", undefined, "Release this conversation? Automatic replies resume and the participant is returned to the menu.")}>Release</Btn>}
          <Field label="Reply (sent on WhatsApp, logged)"><Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && act("send", { text: text.trim() }).then(() => setText(""))} /></Field>
          <Btn ghost disabled={a.busy || !text.trim()} onClick={() => act("send", { text: text.trim() }).then(() => setText(""))}>Send</Btn>
        </div>}
        {!canAct && <div className="sub">Claim, reply and release require the support role.</div>}
        <div className="phone" style={{ marginTop: 10, minHeight: 120 }}>{(c.transcript || []).map((t, i) => <div key={i} className={`bubble ${t.dir}`}><span className="sub">{fmt(t.at)} · {t.dir === "out" ? `${t.purpose} · ${t.status}` : t.kind}</span><div>{t.text}</div></div>)}{!(c.transcript || []).length && <div className="sub">No messages for this number.</div>}</div>
      </>}
      {!c && <Empty>Enter the participant's WhatsApp number to open the conversation.</Empty>}
    </Card>
  </div>;
}

/* ===================== simulator ===================== */
function Simulator() {
  const [phone, setPhone] = useState("263770000099"); const [text, setText] = useState("hi"); const [log, setLog] = useState([]); const [busy, setBusy] = useState(false); const [transcript, setTranscript] = useState([]);
  const push = (l) => setLog((p) => [...p, l].slice(-60));
  const send = async (body) => { setBusy(true); try { const r = await api("/api/simulator/inbound", { method: "POST", body: { phone, ...body }, timeout: 120000 }); if (!r.ok) push({ dir: "err", text: r.data?.error?.message || `HTTP ${r.status}` }); else { push({ dir: "in", text: body.text || "[image]" }); for (const m of r.data.replies || []) push({ dir: "out", text: m.text }); if (r.data.result?.receiptId) push({ dir: "sys", text: `receipt ${r.data.result.receiptId} submitted → the result message arrives from the worker (refresh transcript)` }); } } finally { setBusy(false); } };
  const refresh = async () => { const r = await api(`/api/simulator/transcript/${phone}`); setTranscript(r.data?.transcript || []); };
  const onFile = async (e) => { const f = e.target.files?.[0]; if (!f) return; const b64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(",")[1]); rd.readAsDataURL(f); }); await send({ image_b64: b64, mime: f.type }); e.target.value = ""; };
  return <div className="promo-page"><div className="split2">
    <Card title="Conversation simulator — TEST ONLY (same intake, state machine, real OCR pipeline and outbox as WhatsApp; not WhatsApp evidence)">
      <div className="row"><Field label="Phone (test)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field><Field label="Message"><Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send({ text }).then(() => setText(""))} /></Field><Btn disabled={busy} onClick={() => send({ text }).then(() => setText(""))}>Send</Btn><label className="btn ghost">Upload receipt image<input type="file" accept="image/*" hidden onChange={onFile} /></label><Btn ghost onClick={refresh}>Refresh transcript</Btn></div>
      <div className="phone" style={{ marginTop: 10, minHeight: 200 }}>{log.map((l, i) => <div key={i} className={`bubble ${l.dir}`}>{l.text.split("\n").map((x, j) => <div key={j}>{x || " "}</div>)}</div>)}{!log.length && <div className="sub">Say "hi" to start. Quick keys: 1 register · 2 enter · 3 how it works · 6 winners · 7 my entries. Fixture images: fixtures/receipts/*.jpg</div>}</div>
    </Card>
    <Card title="Server transcript (inbound events + outbound ledger, with delivery states)">{transcript.length ? transcript.map((t, i) => <div key={i} className={`bubble ${t.dir}`}><span className="sub">{fmt(t.at)} · {t.dir === "out" ? `${t.purpose} · ${t.status}` : t.kind}</span><div>{t.text}</div></div>) : <Empty>Refresh to load.</Empty>}</Card>
  </div></div>;
}

/* ===================== shell ===================== */
const TABS = [["overview", "Overview", null], ["campaigns", "Campaigns", null], ["receipts", "Receipts", null], ["entries", "Entries", null], ["draws", "Draws", null], ["winners", "Winners", null], ["participants", "Participants", null], ["support", "Support", null], ["outlets", "Outlets", null], ["products", "Products", null], ["integrations", "Integrations", null], ["access", "Access", null], ["audit", "Audit", null], ["readiness", "Readiness", null], ["simulator", "Test a customer", null], ["desk", "Desk (legacy)", null]];
const VIEWS = { overview: Overview, campaigns: Campaigns, receipts: Receipts, entries: Entries, draws: Draws, winners: Winners, participants: Participants, support: Support, outlets: Outlets, products: Products, integrations: Integrations, access: Access, audit: AuditView, readiness: Readiness, simulator: Simulator };
export function App() {
  const [me, setMe] = useState(null); const [tab, setTab] = useState(() => { try { return localStorage.getItem("wpp_tab") || "overview"; } catch { return "overview"; } }); const [cfg, setCfg] = useState(null);
  const authed = () => api("/api/whoami").then((r) => { if (r.ok) setMe(r.data); else setToken(""); });
  useEffect(() => { api("/api/config", { auth: false }).then((r) => r.ok && setCfg(r.data)); if (getToken()) authed(); }, []);
  useEffect(() => { try { localStorage.setItem("wpp_tab", tab); } catch { /* */ } }, [tab]);
  if (!me) return <Login onAuthed={authed} />;
  if (me.mustChangePassword) return <ChangePassword onDone={() => setMe(null)} />;
  const View = VIEWS[tab] || Overview;
  return <div className="promo">
    {cfg?.sample_data && <div className="banner">TEST ONLY — sample promotion data is loaded in environment "{me.environment}". Nothing here is client sign-off. Transport: {cfg.transport}.</div>}
    <div className="promo-tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}<span style={{ flex: 1 }} /><span className="sub">{me.email} · {me.roles.join(", ")}</span><button onClick={() => { api("/api/logout", { method: "POST" }); setToken(""); setMe(null); }}>Sign out</button></div>
    {tab === "desk" ? <Desk /> : <View me={me} />}
  </div>;
}
