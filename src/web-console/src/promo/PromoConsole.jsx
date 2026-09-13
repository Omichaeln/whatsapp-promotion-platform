import { useState, useEffect, useCallback } from "react";
import { api, getToken } from "../api.js";

/**
 * The promotion team's console.
 *
 * A separate surface from the technical one, not a trimmed-down copy of it. The
 * difference that matters is not "fewer tabs": it is that nothing here asks the
 * reader to know how the system works. There are no dispositions, no reason
 * codes, no version hashes and no identifiers presented as an answer — the
 * server does that translation (src/routes/promo.mjs) so there is exactly one
 * copy of the wording, next to the codes the pipeline actually writes.
 *
 * Four screens, in the order the work happens: what arrived today, the entries
 * that count, every submission and why it landed where it did, and the people
 * waiting for a reply.
 */

/* ------------------------------------------------------------- primitives */

function useLoad(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    api(path).then((r) => {
      if (!live) return;
      setState({ loading: false, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.error?.message || r.data?.error || `Could not load (${r.status})`) });
    });
    return () => { live = false; };
  }, [path]);
  useEffect(() => reload(), deps.concat(path));
  return [state, reload];
}

/** An action with a confirmation, a busy state and a message the user can read. */
function useAction() {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, { confirm } = {}) => {
    if (confirm && !window.confirm(confirm)) return null;
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (r?.ok) setMsg({ tone: "good", text: "Done." });
    else setMsg({ tone: "bad", text: r?.data?.error?.message || r?.data?.error || `That did not work (${r?.status ?? "no reply"}).` });
    return r;
  };
  const Msg = () => (msg ? <div className={`pc-msg ${msg.tone}`}>{msg.text}</div> : null);
  return { run, busy, Msg, clear: () => setMsg(null) };
}

const PcStat = ({ label, value, tone, hint }) => (
  <div className={`pc-stat${tone ? ` ${tone}` : ""}`}>
    <div className="pc-stat-value">{value ?? "—"}</div>
    <div className="pc-stat-label">{label}</div>
    {hint ? <div className="pc-stat-hint">{hint}</div> : null}
  </div>
);

const PcPanel = ({ title, note, right, children }) => (
  <section className="pc-panel">
    {(title || right) && <header className="pc-panel-head">
      <div><h2>{title}</h2>{note ? <p className="pc-note">{note}</p> : null}</div>
      {right ? <div className="pc-panel-actions">{right}</div> : null}
    </header>}
    {children}
  </section>
);

const PcField = ({ label, children }) => (
  <label className="pc-field"><span>{label}</span>{children}</label>
);

const PcSelect = ({ value, onChange, options, anyLabel }) => (
  <select value={value || ""} onChange={(e) => onChange(e.target.value || "")}>
    <option value="">{anyLabel}</option>
    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

const PcPill = ({ kind, children }) => <span className={`pc-pill ${kind || ""}`}>{children}</span>;

const CATEGORY_TONE = { qualified: "good", needs_look: "warn", rejected: "bad", duplicate: "bad", unreadable: "warn", in_progress: "" };
const when = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ` ${time}`;
};
const packsText = (n) => (n == null ? "not read" : n === 1 ? "1 pack" : `${n} packs`);

/**
 * The receipt photo. Fetched with the session and rendered from an object URL,
 * because an <img src> sends no Authorization header — a plain src would 401 and
 * show a broken picture, which is the defect the audit found in the technical
 * console. A purged photo is an expected end state, not an error.
 */
function PcPhoto({ receiptId }) {
  const [src, setSrc] = useState(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let url = null, live = true;
    fetch(`/api/promo/submissions/${receiptId}/photo`, { headers: { authorization: `Bearer ${getToken()}` } })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) { setGone(true); return; }
        url = URL.createObjectURL(await r.blob());
        setSrc(url);
      })
      .catch(() => live && setGone(true));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [receiptId]);
  if (gone) return <p className="pc-sub">The photo is no longer stored — receipt images are deleted after the retention period.</p>;
  if (!src) return <p className="pc-sub">Loading the photo…</p>;
  return <a href={src} target="_blank" rel="noreferrer"><img className="pc-photo" src={src} alt="The receipt as it was sent" /></a>;
}

/* ------------------------------------------------------------- the filters */

/**
 * The four filters the promotion team asked for, plus period and a name search.
 * `store` and `retailer` are separate on purpose: "every Sunrise branch" and
 * "the Westgate branch" are different questions and both get asked.
 */
function PcFilters({ f, setF, opts, showCategory }) {
  const set = (k) => (v) => setF({ ...f, [k]: v });
  const stores = (opts?.stores || []).filter((s) => !f.retailer || s.retailer === f.retailer).filter((s) => !f.town || s.town === f.town);
  return <div className="pc-filters">
    <PcField label="Period">
      <PcSelect value={f.period} onChange={set("period")} anyLabel="All weeks" options={(opts?.periods || []).map((p) => ({ value: p.code, label: p.label }))} />
    </PcField>
    <PcField label="Shop">
      <PcSelect value={f.retailer} onChange={(v) => setF({ ...f, retailer: v, store: "" })} anyLabel="All shops" options={(opts?.retailers || []).map((x) => ({ value: x, label: x }))} />
    </PcField>
    <PcField label="Branch">
      <PcSelect value={f.store} onChange={set("store")} anyLabel="All branches" options={stores.map((s) => ({ value: s.id, label: `${s.branch}, ${s.town}` }))} />
    </PcField>
    <PcField label="Town">
      <PcSelect value={f.town} onChange={(v) => setF({ ...f, town: v, store: "" })} anyLabel="Anywhere" options={(opts?.towns || []).map((x) => ({ value: x, label: x }))} />
    </PcField>
    <PcField label="Province">
      <PcSelect value={f.province} onChange={set("province")} anyLabel="Anywhere" options={(opts?.provinces || []).map((x) => ({ value: x, label: x }))} />
    </PcField>
    <PcField label="Packs bought">
      <span className="pc-range">
        <input type="number" min="0" placeholder="any" value={f.packs_min || ""} onChange={(e) => set("packs_min")(e.target.value)} aria-label="Fewest packs" />
        <em>to</em>
        <input type="number" min="0" placeholder="any" value={f.packs_max || ""} onChange={(e) => set("packs_max")(e.target.value)} aria-label="Most packs" />
      </span>
    </PcField>
    <PcField label="Receipts sent by that person">
      <span className="pc-range">
        <input type="number" min="0" placeholder="any" value={f.receipts_min || ""} onChange={(e) => set("receipts_min")(e.target.value)} aria-label="Fewest receipts" />
        <em>to</em>
        <input type="number" min="0" placeholder="any" value={f.receipts_max || ""} onChange={(e) => set("receipts_max")(e.target.value)} aria-label="Most receipts" />
      </span>
    </PcField>
    {showCategory && <PcField label="Outcome">
      <PcSelect value={f.category} onChange={set("category")} anyLabel="Everything" options={(opts?.categories || []).map((c) => ({ value: c.key, label: c.label }))} />
    </PcField>}
    <PcField label="Name or number">
      <input placeholder="search" value={f.q || ""} onChange={(e) => set("q")(e.target.value)} />
    </PcField>
    <button className="pc-btn ghost" onClick={() => setF({})}>Clear filters</button>
  </div>;
}

const qs = (f, extra = {}) => Object.entries({ ...f, ...extra })
  .filter(([, v]) => v !== "" && v != null)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

/* --------------------------------------------------------------- today */

function PcToday({ onGo }) {
  const [s] = useLoad("/api/promo/summary");
  if (s.loading) return <p className="pc-loading">Loading…</p>;
  if (s.error) return <p className="pc-error">{s.error}</p>;
  const d = s.data;
  const sub = d.submissions || {};
  const attention = d.needs_attention || {};
  return <>
    <PcPanel title={d.campaign?.name || "Promotion"} note={`${d.campaign?.status === "active" ? "Running" : d.campaign?.status === "paused" ? "Paused" : d.campaign?.status} · ${d.people} people have taken part`}>
      <div className="pc-stats">
        <PcStat label="Entries in the draw" value={d.entries?.counting} tone="good" />
        <PcStat label="Receipts sent in" value={sub.total} />
        <PcStat label="Earned an entry" value={sub.qualified} tone="good" />
        <PcStat label="Need a look" value={sub.needs_look} tone={sub.needs_look ? "warn" : ""} />
        <PcStat label="Did not qualify" value={sub.rejected} />
        <PcStat label="Already claimed" value={sub.duplicate} />
      </div>
    </PcPanel>

    <PcPanel title="Waiting for someone" note="These do not resolve on their own.">
      <div className="pc-todo">
        <button className="pc-todo-item" onClick={() => onGo("submissions", { category: "needs_look" })}>
          <strong>{attention.receipts_to_check ?? 0}</strong>
          <span>receipt{attention.receipts_to_check === 1 ? "" : "s"} waiting on a decision
            <em className="pc-sub"> — open to see them; the platform team decides</em></span>
        </button>
        <button className="pc-todo-item" onClick={() => onGo("queries")}>
          <strong>{attention.queries_waiting ?? 0}</strong>
          <span>{attention.queries_waiting === 1 ? "person is" : "people are"} waiting for a reply</span>
        </button>
      </div>
    </PcPanel>

    <PcPanel title="The last day" note="Since this time yesterday.">
      <div className="pc-stats">
        <PcStat label="Receipts sent in" value={d.last_24h?.submissions} />
        <PcStat label="Entries earned" value={d.last_24h?.entries} />
        <PcStat label="Disqualified so far" value={d.entries?.disqualified} tone={d.entries?.disqualified ? "warn" : ""} />
        <PcStat label="Withdrawn by the person" value={d.entries?.withdrawn} />
      </div>
    </PcPanel>
  </>;
}

/* -------------------------------------------------------------- entries */

function PcEntries({ me, initial }) {
  const [f, setF] = useState(initial || {});
  const [opts] = useLoad("/api/promo/filters");
  const [sel, setSel] = useState(null);
  const [list, reload] = useLoad(`/api/promo/entries?${qs(f, { limit: 100 })}`, [JSON.stringify(f)]);
  const a = useAction();

  const decide = (row, kind) => {
    const verb = kind === "disqualify" ? "disqualify" : "put back";
    const reason = window.prompt(`Why are you ${kind === "disqualify" ? "disqualifying" : "putting back"} ${row.person.name}'s entry?\n\nThis is recorded permanently and shown to auditors.`);
    if (!reason) return;
    const approver = window.prompt("If this entry is in a draw that has already been locked, a second person must approve.\n\nTheir user id, or leave blank:") || undefined;
    a.run(() => api(`/api/promo/entries/${row.entry_id}/${kind}`, { method: "POST", body: { reason, approved_by: approver } }))
      .then((r) => { if (r?.ok) { reload(); setSel(null); } });
    return verb;
  };

  return <>
    <PcPanel title="Entries" note="Every entry that has been earned. An entry is one purchase that met the rules.">
      <PcFilters f={f} setF={setF} opts={opts.data} />
      <a.Msg />
      <div className="pc-count">
        {list.loading ? "Counting…" : list.error ? list.error : `${list.data?.total ?? 0} entr${(list.data?.total ?? 0) === 1 ? "y" : "ies"}`}
        {(list.data?.rows?.length ?? 0) < (list.data?.total ?? 0) ? ` · showing the first ${list.data.rows.length}` : ""}
      </div>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr>
            <th>Person</th><th>Shop</th><th>Where</th><th>Packs</th><th>Their receipts</th><th>Week</th><th>Standing</th><th>Earned</th><th />
          </tr></thead>
          <tbody>
            {(list.data?.rows || []).map((row) => <tr key={row.entry_id} className={row.standing !== "active" ? "muted" : ""}>
              <td><strong>{row.person.name}</strong><div className="pc-sub">{row.person.phone}</div></td>
              <td>{row.store ? <>{row.store.retailer}<div className="pc-sub">{row.store.branch}</div></> : "—"}</td>
              <td>{row.store ? <>{row.store.town}<div className="pc-sub">{row.store.province}</div></> : "—"}</td>
              <td>{packsText(row.packs)}</td>
              <td>{row.person.receipts_submitted}</td>
              <td>{row.period || "—"}</td>
              <td><PcPill kind={row.standing === "active" ? "good" : "bad"}>{row.standing_label}</PcPill></td>
              <td>{when(row.awarded_at)}</td>
              <td><button className="pc-btn ghost small" onClick={() => setSel(row)}>Open</button></td>
            </tr>)}
            {!list.loading && !(list.data?.rows || []).length && <tr><td colSpan={9} className="pc-empty">Nothing matches those filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </PcPanel>

    {sel && <PcPanel title={`${sel.person.name} · ${sel.reference}`} right={<button className="pc-btn ghost small" onClick={() => setSel(null)}>Close</button>}>
      <dl className="pc-detail">
        <div><dt>Standing</dt><dd><PcPill kind={sel.standing === "active" ? "good" : "bad"}>{sel.standing_label}</PcPill></dd></div>
        <div><dt>Bought</dt><dd>{packsText(sel.packs)}{sel.grams ? ` (${sel.grams} g)` : ""}</dd></div>
        <div><dt>Shop</dt><dd>{sel.store ? `${sel.store.retailer} — ${sel.store.branch}, ${sel.store.town}` : "—"}</dd></div>
        <div><dt>Photo quality</dt><dd>{sel.quality.band}{sel.quality.flags.length ? ` · ${sel.quality.flags.join(", ")}` : ""}</dd></div>
        <div><dt>Decided by</dt><dd>{sel.quality.decided_by}</dd></div>
        <div><dt>Why</dt><dd>{sel.reason_label}</dd></div>
        <div><dt>This person has sent</dt><dd>{sel.person.receipts_submitted} receipt{sel.person.receipts_submitted === 1 ? "" : "s"}</dd></div>
      </dl>
      {me?.can_decide_entries
        ? <div className="pc-actions">
          {sel.standing === "active"
            ? <button className="pc-btn danger" disabled={a.busy} onClick={() => decide(sel, "disqualify")}>Disqualify this entry</button>
            : <button className="pc-btn" disabled={a.busy} onClick={() => decide(sel, "reinstate")}>Put this entry back</button>}
          <p className="pc-note">Every change is recorded with your name and the reason you give.</p>
        </div>
        : <p className="pc-note">Only a promotion administrator can change an entry. Ask them if this one needs a decision.</p>}
    </PcPanel>}
  </>;
}

/* ---------------------------------------------------------- submissions */

function PcSubmissions({ initial }) {
  const [f, setF] = useState(initial || {});
  const [opts] = useLoad("/api/promo/filters");
  const [sel, setSel] = useState(null);
  const [list] = useLoad(`/api/promo/submissions?${qs(f, { limit: 100 })}`, [JSON.stringify(f)]);
  const [detail] = useLoad(sel ? `/api/promo/submissions/${sel}` : "/api/promo/me", [sel]);

  const counts = opts.data?.categories || [];
  return <>
    <PcPanel title="Submissions" note="Every receipt that was sent in, and what happened to it. An entry only exists for the ones that qualified, so this is where you see why the others did not.">
      <div className="pc-chips">
        <button className={`pc-chip${!f.category ? " on" : ""}`} onClick={() => setF({ ...f, category: "" })}>Everything</button>
        {counts.map((c) => <button key={c.key} className={`pc-chip${f.category === c.key ? " on" : ""} ${CATEGORY_TONE[c.key] || ""}`} onClick={() => setF({ ...f, category: c.key })}>{c.label}</button>)}
      </div>
      <PcFilters f={f} setF={setF} opts={opts.data} />
      <div className="pc-count">{list.loading ? "Counting…" : list.error ? list.error : `${list.data?.total ?? 0} receipt${(list.data?.total ?? 0) === 1 ? "" : "s"}`}</div>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Person</th><th>Shop</th><th>Where</th><th>Packs</th><th>Their receipts</th><th>Outcome</th><th>Why</th><th>Sent</th><th /></tr></thead>
          <tbody>
            {(list.data?.rows || []).map((row) => <tr key={row.receipt_id}>
              <td><strong>{row.person.name}</strong><div className="pc-sub">{row.person.phone}</div></td>
              <td>{row.store ? <>{row.store.retailer}<div className="pc-sub">{row.store.branch}</div></> : "—"}</td>
              <td>{row.store ? row.store.town : "—"}</td>
              <td>{packsText(row.packs)}</td>
              <td>{row.person.receipts_submitted}</td>
              <td><PcPill kind={CATEGORY_TONE[row.category]}>{row.outcome}</PcPill></td>
              <td className="pc-why">{row.reason_label}</td>
              <td>{when(row.sent_at)}</td>
              <td><button className="pc-btn ghost small" onClick={() => setSel(row.receipt_id)}>Open</button></td>
            </tr>)}
            {!list.loading && !(list.data?.rows || []).length && <tr><td colSpan={9} className="pc-empty">Nothing matches those filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </PcPanel>

    {sel && detail.data?.submission && <PcPanel title={`${detail.data.submission.person.name} · ${detail.data.submission.reference}`} right={<button className="pc-btn ghost small" onClick={() => setSel(null)}>Close</button>}>
      <dl className="pc-detail">
        <div><dt>Outcome</dt><dd><PcPill kind={CATEGORY_TONE[detail.data.submission.category]}>{detail.data.submission.outcome}</PcPill></dd></div>
        <div><dt>Why</dt><dd>{detail.data.submission.reason_label}</dd></div>
        <div><dt>Bought</dt><dd>{packsText(detail.data.submission.packs)}</dd></div>
        <div><dt>Shop</dt><dd>{detail.data.submission.store ? `${detail.data.submission.store.retailer} — ${detail.data.submission.store.branch}, ${detail.data.submission.store.town}` : "—"}</dd></div>
        <div><dt>Photo quality</dt><dd>{detail.data.submission.quality.band}</dd></div>
        <div><dt>Entry</dt><dd>{detail.data.entry ? detail.data.entry.standing_label : "No entry from this receipt"}</dd></div>
      </dl>
      <h3 className="pc-h3">The receipt as it was sent</h3>
      <PcPhoto receiptId={sel} />
      {!!(detail.data.checks || []).length && <>
        <h3 className="pc-h3">What was checked</h3>
        <table className="pc-table compact">
          <thead><tr><th>Check</th><th>Result</th><th>Note</th></tr></thead>
          <tbody>{detail.data.checks.map((c, i) => <tr key={i}>
            <td>{c.check}</td>
            <td><PcPill kind={c.outcome === "Met" ? "good" : c.outcome === "Not met" ? "bad" : "warn"}>{c.outcome}</PcPill></td>
            <td className="pc-why">{c.why || "—"}</td>
          </tr>)}</tbody>
        </table>
      </>}
      {!!(detail.data.items || []).length && <>
        <h3 className="pc-h3">What was on the receipt</h3>
        <table className="pc-table compact">
          <thead><tr><th>Item</th><th>Quantity</th><th>Pack size</th><th>Amount</th></tr></thead>
          <tbody>{detail.data.items.map((it, i) => <tr key={i}>
            <td>{it.description}{it.sku ? <PcPill kind="good">qualifying</PcPill> : null}</td>
            <td>{it.quantity}</td><td>{it.unit_weight_kg ? `${it.unit_weight_kg} kg` : "—"}</td><td>{it.amount ?? "—"}</td>
          </tr>)}</tbody>
        </table>
      </>}
    </PcPanel>}
  </>;
}

/* -------------------------------------------------------------- queries */

function PcQueries({ me }) {
  const [showAll, setShowAll] = useState(false);
  const [list, reload] = useLoad(`/api/promo/queries?state=${showAll ? "all" : "open"}`, [showAll]);
  const [open, setOpen] = useState(null);
  const [text, setText] = useState("");
  const a = useAction();

  const act = (phone, what, body) => a.run(() => api(`/api/promo/queries/${encodeURIComponent(phone)}/${what}`, { method: "POST", body }))
    .then((r) => { if (r?.ok) { reload(); if (what === "send") setText(""); } });

  return <PcPanel
    title="Participant queries"
    note="People who asked for a person. While a query is open the automatic replies stop, so it needs an answer and then releasing."
    right={<button className="pc-btn ghost small" onClick={() => setShowAll(!showAll)}>{showAll ? "Show only those waiting" : "Show every conversation"}</button>}>
    <a.Msg />
    {list.loading ? <p className="pc-loading">Loading…</p> : list.error ? <p className="pc-error">{list.error}</p> : null}
    <div className="pc-queries">
      {(list.data?.rows || []).map((row) => <div key={row.phone_uid} className={`pc-query${row.waiting ? " waiting" : ""}`}>
        <div className="pc-query-head">
          <div>
            <strong>{row.name}</strong> <span className="pc-sub">{row.phone}</span>
            {row.waiting && <PcPill kind="warn">{row.claimed ? `With ${row.owner}` : "Waiting"}</PcPill>}
          </div>
          <span className="pc-sub">{when(row.last_message_at || row.waiting_since)}</span>
        </div>
        {row.last_message ? <p className="pc-query-msg">“{row.last_message}”</p> : <p className="pc-sub">No message yet.</p>}
        <div className="pc-actions">
          {row.waiting && !row.claimed && <button className="pc-btn" disabled={a.busy} onClick={() => act(row.phone_uid, "claim")}>I will take this</button>}
          <button className="pc-btn ghost small" onClick={() => setOpen(open === row.phone_uid ? null : row.phone_uid)}>{open === row.phone_uid ? "Cancel" : "Reply"}</button>
          {row.waiting && <button className="pc-btn ghost small" disabled={a.busy}
            onClick={() => a.run(() => api(`/api/promo/queries/${encodeURIComponent(row.phone_uid)}/release`, { method: "POST" }), { confirm: "Hand this conversation back to the automatic replies?\n\nDo this once the person's question is answered." }).then((r) => r?.ok && reload())}>Done — hand back</button>}
        </div>
        {open === row.phone_uid && <div className="pc-reply">
          <textarea rows={3} placeholder="Type your reply to this person…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="pc-btn" disabled={a.busy || !text.trim()} onClick={() => act(row.phone_uid, "send", { text })}>Send reply</button>
        </div>}
      </div>)}
      {!list.loading && !(list.data?.rows || []).length && <p className="pc-empty">Nobody is waiting. </p>}
    </div>
  </PcPanel>;
}

/* ---------------------------------------------------------------- shell */

const SCREENS = [
  ["today", "Today", PcToday],
  ["entries", "Entries", PcEntries],
  ["submissions", "Submissions", PcSubmissions],
  ["queries", "Queries", PcQueries],
];

export function PromoConsole({ me, onSwitchToFull }) {
  const [screen, setScreen] = useState(() => { try { return localStorage.getItem("wpp_promo_screen") || "today"; } catch { return "today"; } });
  const [preset, setPreset] = useState(null);
  const [who] = useLoad("/api/promo/me");
  useEffect(() => { try { localStorage.setItem("wpp_promo_screen", screen); } catch { /* private mode */ } }, [screen]);

  const go = (to, filters = null) => { setPreset(filters); setScreen(to); };
  const Screen = (SCREENS.find(([k]) => k === screen) || SCREENS[0])[2];

  return <div className="pc">
    <header className="pc-top">
      <div className="pc-brand">Promotion desk</div>
      <nav className="pc-nav">{SCREENS.map(([k, label]) => (
        <button key={k} className={screen === k ? "on" : ""} onClick={() => go(k)}>{label}</button>
      ))}</nav>
      <div className="pc-who">
        {who.data?.name || me?.email}
        {who.data && !who.data.can_decide_entries ? <span className="pc-sub"> · assistant</span> : null}
        {onSwitchToFull ? <button className="pc-btn ghost small" onClick={onSwitchToFull}>Technical view</button> : null}
      </div>
    </header>
    <main className="pc-main">
      <Screen me={who.data} initial={screen === "entries" || screen === "submissions" ? preset : null} onGo={go} />
    </main>
  </div>;
}

export default PromoConsole;
