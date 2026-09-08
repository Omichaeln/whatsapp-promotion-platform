import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiUrl, getToken, setToken, onUnauthorised } from "../api.js";
import { Ring, Legend } from "./components/Ring.jsx";
import VoiceInput from "./components/VoiceInput.jsx";

const GROUPS = {
  Team:      { dot: "#0d9488", tint: "rgba(13,148,136,0.06)" },
  Reports:   { dot: "#2563eb", tint: "rgba(37,99,235,0.06)" },
  Customers: { dot: "#b42318", tint: "rgba(180,35,24,0.055)" },
  Direct:    { dot: "#7c3aed", tint: "rgba(124,58,237,0.065)" },
};
const GROUP_ORDER = ["Team", "Reports", "Customers", "Direct"];
const groupTone = (name) => GROUPS[name] || GROUPS.Direct;

const PRIORITY_CHIP = {
  high:   { fg: "#b42318", bg: "rgba(180,35,24,0.10)" },
  normal: { fg: "#475569", bg: "rgba(100,116,139,0.10)" },
  low:    { fg: "#94a3b8", bg: "rgba(100,116,139,0.06)" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function stampLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function agoLabel(iso, today) {
  if (!iso) return "";
  const days = Math.round((new Date(today) - new Date(iso.slice(0, 10))) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function makeGrouper(config) {
  const customerKey = config?.categories?.[0] || "Customers";
  const teamGroups = (config?.team_groups || []).map(g => {
    try { return { label: g.label, re: new RegExp(g.match, "i") }; } catch { return null; }
  }).filter(Boolean);
  const teamSub = (name) => teamGroups.find(g => g.re.test(String(name || "")))?.label || "Other groups";
  return (t) => {
    if (t.status === "filed") return { group: "Reports", sub: t.chat_type === "group" ? teamSub(t.chat_name) : "Direct" };
    if (t.category === customerKey) return { group: "Customers", sub: "" };
    if (t.chat_type === "group") return { group: "Team", sub: teamSub(t.chat_name) };
    return { group: "Direct", sub: t.category || "Other" };
  };
}

function Metric({ value, label, tone, onClick, active }) {
  return (
    <div onClick={onClick} style={{
      padding: "8px 18px 8px 12px", minWidth: 0, borderRadius: 10,
      cursor: onClick ? "pointer" : "default",
      background: active ? "var(--accent-dim)" : "transparent", transition: "background 0.15s",
    }}
      onMouseEnter={e => { if (onClick && !active) e.currentTarget.style.background = "rgba(0,0,0,0.03)"; }}
      onMouseLeave={e => { if (onClick && !active) e.currentTarget.style.background = "transparent"; }}
    >
      <div className="mono" style={{ fontSize: 24, fontWeight: 500, letterSpacing: -0.5, color: tone || "var(--text-primary)" }}>{value}</div>
      <div className="one-line" style={{ fontSize: 9.5, fontWeight: 500, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-tertiary)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SectionHead({ title, count, action }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: -0.2 }}>{title}</span>
      {count != null && <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{count}</span>}
      <span style={{ flex: 1 }} />
      {action}
    </div>
  );
}

function Chevron({ open, color }) {
  return (
    <span style={{ color: color || "#ccc", display: "inline-flex", flexShrink: 0, transform: open ? "rotate(0)" : "rotate(-90deg)", transition: "transform 0.2s, color 0.15s" }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
    </span>
  );
}

function Fold({ title, count, tone, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--hairline)" }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", cursor: "pointer", userSelect: "none" }}>
        <span className="one-line" style={{ flex: 1, fontSize: 12.5, color: tone || "var(--text-primary)" }}>{title}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{count}</span>
        <Chevron open={open} />
      </div>
      {open && <div style={{ padding: "0 2px 12px" }}>{children}</div>}
    </div>
  );
}

function SubFold({ label, count, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 2px 2px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ fontSize: 9.5, fontWeight: 500, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-tertiary)" }}>{label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{count}</span>
        <Chevron open={open} />
      </div>
      {open && children}
    </div>
  );
}

function BriefBody({ md }) {
  const lines = String(md || "").split("\n");
  return (
    <div style={{ lineHeight: 1.6 }}>
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return <div key={i} style={{ height: 6 }} />;
        const heading = line.match(/^#{1,4}\s+(.*)$|^\*\*(.+)\*\*$/);
        if (heading) return <div key={i} className="overline" style={{ margin: "12px 0 4px" }}>{heading[1] || heading[2]}</div>;
        const bullet = line.match(/^[-*]\s+(.*)$/);
        const text = (bullet ? bullet[1] : line).replace(/\*\*(.+?)\*\*/g, "$1");
        return (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, color: "var(--text-secondary)", padding: "1px 0" }}>
            {bullet && <span style={{ color: "var(--accent)", flexShrink: 0 }}>·</span>}
            <span>{text}</span>
          </div>
        );
      })}
    </div>
  );
}

function Messages({ rows, limit }) {
  return rows.slice(-limit).map(r => (
    <div key={r.id} style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 12, alignItems: "baseline", padding: "4px 0", borderBottom: "1px solid rgba(0,0,0,0.03)" }}>
      <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>{stampLabel(r.timestamp)}</span>
      <span style={{ fontSize: 12, lineHeight: 1.5 }}>
        <span style={{ color: "var(--text-tertiary)" }}>{r.sender_name}: </span>
        {r.message_text}
      </span>
    </div>
  ));
}

function UsageLine() {
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = async () => { const out = await api("/api/usage"); if (alive && out.ok) setSnap(out.data); };
    pull();
    const t = setInterval(pull, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!snap) return null;
  const monthUsd = Number(snap.month_usd || 0);
  const capUsd = Number(snap.cap_usd || 0);
  const tone = snap.pct >= 100 ? "#b42318" : snap.pct >= 75 ? "#d97706" : "var(--text-tertiary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 2px 0" }}>
      <span style={{ fontSize: 9.5, fontWeight: 500, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-tertiary)" }}>Model spend this month</span>
      <span className="mono" style={{ fontSize: 10.5, color: tone }}>
        ${monthUsd.toFixed(2)}{capUsd ? ` of $${capUsd.toFixed(2)} (${snap.pct}%)` : ""}
      </span>
    </div>
  );
}

const CONNECTION = {
  live:     { label: "WhatsApp linked",  fg: "#0d9488", bg: "rgba(13,148,136,0.10)" },
  unlinked: { label: "Scan to link",     fg: "#b45309", bg: "rgba(180,83,9,0.10)" },
  offline:  { label: "Desk offline",     fg: "var(--text-tertiary)", bg: "rgba(100,116,139,0.08)" },
};

function ConnectionControl({ link, me, onUnlink }) {
  const [confirm, setConfirm] = useState(false);
  const chip = CONNECTION[link] || CONNECTION.offline;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {link === "live" && me && <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{me}</span>}
      {link === "live" && !confirm && <button className="link-btn" onClick={() => setConfirm(true)}>Unlink</button>}
      {link === "live" && confirm && (
        <>
          <button className="link-btn" style={{ color: "#b42318" }} onClick={() => { setConfirm(false); onUnlink(); }}>Confirm unlink</button>
          <button className="link-btn" style={{ color: "var(--text-tertiary)" }} onClick={() => setConfirm(false)}>Keep</button>
        </>
      )}
      <span className="chip" style={{ color: chip.fg, background: chip.bg }}>{chip.label}</span>
    </span>
  );
}

function LinkPanel({ brand }) {
  const [tick, setTick] = useState(0);
  const [dead, setDead] = useState(false);
  useEffect(() => {
    const t = setInterval(() => { setDead(false); setTick(n => n + 1); }, 12000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="frame" style={{ padding: "18px 20px 20px", marginBottom: 18 }}>
      <div className="overline">Link WhatsApp</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 20, alignItems: "center" }}>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: "var(--text-secondary)" }}>
          <li>Open WhatsApp on the phone that will feed {brand}.</li>
          <li>Tap the menu, then <b>Linked devices</b>, then <b>Link a device</b>.</li>
          <li>Point the phone at this code. It refreshes on its own.</li>
          <li>When the chip reads <b>WhatsApp linked</b>, the desk is live. The phone can go back in the pocket.</li>
        </ol>
        <div style={{ width: 220, height: 220, borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {dead
            ? <span style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center", padding: 12 }}>Waiting for a code</span>
            : <img src={apiUrl(`/api/qr?token=${encodeURIComponent(getToken())}&t=${tick}`)} alt="WhatsApp link code" onError={() => setDead(true)} style={{ width: 220, height: 220 }} />}
        </div>
      </div>
    </div>
  );
}

function OfflinePanel() {
  return (
    <div className="frame" style={{ padding: "18px 20px 20px", marginBottom: 18 }}>
      <div className="overline">Desk offline</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-secondary)" }}>
        The desk process is not answering. Start it with <span className="mono">npm start</span> in the desk folder, then reload this page.
      </div>
    </div>
  );
}

async function copyText(text, setNotice) {
  try { await navigator.clipboard.writeText(text); setNotice("Copied."); setTimeout(() => setNotice(""), 1500); }
  catch { setNotice("Could not reach the clipboard."); }
}

function SendControls({ draft, chatId, linked, onSent, setNotice }) {
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (sending || !draft.trim()) return;
    setSending(true);
    const out = await api("/api/send", { method: "POST", body: { chat_id: chatId, text: draft }, timeout: 30000 });
    setSending(false);
    if (!out.ok) { setNotice(out.data?.error || "Could not send."); return; }
    setNotice("Sent.");
    setTimeout(() => setNotice(""), 1500);
    onSent?.();
  };
  return (
    <>
      {chatId && linked && <button className="btn primary" onClick={send} disabled={sending}>{sending ? "Sending" : "Send on WhatsApp"}</button>}
      {chatId && !linked && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Link WhatsApp to send from here</span>}
      <button className="btn" onClick={() => copyText(draft, setNotice)}>Copy</button>
    </>
  );
}

function ChatRow({ t, tone, today, messages, linked, ai, onChanged }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(t.draft || "");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const chip = PRIORITY_CHIP[t.priority] || PRIORITY_CHIP.normal;
  const draftRef = useRef(t.draft || "");

  const persistDraft = useCallback(async (text) => {
    if (text === draftRef.current) return;
    draftRef.current = text;
    await api(`/api/threads/${encodeURIComponent(t.chat_id)}`, { method: "PATCH", body: { draft: text || null } });
  }, [t.chat_id]);

  const context = useMemo(() => {
    const lines = messages.slice(-15).map(r => `[${stampLabel(r.timestamp)}] ${r.sender_name}: ${r.message_text}`);
    return lines.length ? `${t.chat_name}\n${lines.join("\n")}` : t.chat_name;
  }, [messages, t.chat_name]);

  const run = async (text) => {
    const ask = (text ?? instruction).trim();
    if (busy) return;
    setBusy(true);
    setNotice("");
    const out = await api("/api/draft", { method: "POST", body: { context, instruction: ask || (draft.trim() ? "" : `Draft the reply this chat is waiting for: ${t.summary || "respond to the latest message"}`), current: draft }, timeout: 60000 });
    setBusy(false);
    if (!out.ok) { setNotice(out.data?.message || out.data?.error || "The draft could not be written."); return; }
    setInstruction("");
    setDraft(out.data.text);
    persistDraft(out.data.text);
  };

  const setStatus = async (status) => {
    const out = await api(`/api/threads/${encodeURIComponent(t.chat_id)}`, { method: "PATCH", body: { status } });
    if (!out.ok) { setNotice(out.data?.error || "Could not update."); return; }
    onChanged(out.data);
  };

  return (
    <div style={{ padding: "9px 0", borderBottom: "1px solid rgba(0,0,0,0.035)" }}>
      <div onClick={() => setOpen(o => !o)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="chip" style={{ flexShrink: 0, width: 52, textAlign: "center", padding: "3px 0", color: chip.fg, background: chip.bg }}>{t.priority}</span>
          <span className="one-line" style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: hover ? tone.dot : "var(--text-primary)", transition: "color 0.15s" }}>{t.chat_name}</span>
          {t.needs_reply && <span className="chip" style={{ flexShrink: 0, color: "#b45309", background: "rgba(180,83,9,0.10)" }}>Reply</span>}
          <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>{agoLabel(t.last_message_at, today)}</span>
          <Chevron open={open} color={hover ? tone.dot : undefined} />
        </div>
      </div>

      {open && (
        <div style={{ marginLeft: 62, marginTop: 8 }}>
          {t.summary && <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.55, background: tone.tint, borderRadius: 8, padding: "8px 11px" }}>{t.summary}</div>}
          {messages.length > 0 && <div style={{ marginBottom: 10 }}><Messages rows={messages} limit={8} /></div>}
          {notice && <div className="notice">{notice}</div>}

          <textarea className="area" value={draft} onChange={e => setDraft(e.target.value)} onBlur={e => persistDraft(e.target.value)}
            placeholder="Write the reply here, or ask for a draft below."
            rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))} />

          {ai && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <input className="field" value={instruction} onChange={e => setInstruction(e.target.value)} onKeyDown={e => { if (e.key === "Enter") run(); }}
                placeholder={busy ? "Working" : draft ? "Say how to change it. Firmer, shorter, offer Tuesday." : "Say what the reply should do, or leave blank and Draft."}
                disabled={busy} />
              <VoiceInput onTranscript={txt => run(txt)} onNotice={setNotice} disabled={busy} size={15} />
              <button className="link-btn" onClick={() => run()} disabled={busy}>{busy ? "Working" : draft ? "Rework" : "Draft"}</button>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {draft.trim() && <SendControls draft={draft} chatId={t.chat_id} linked={linked} setNotice={setNotice} onSent={() => setStatus("handled")} />}
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>confidence {t.confidence ?? 3}/5</span>
            {t.status !== "handled" && <button className="btn" onClick={() => setStatus("handled")}>Mark handled</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftComposer({ chats, messagesByChat, linked, ai }) {
  const [chatId, setChatId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const run = async (text) => {
    const ask = (text ?? instruction).trim();
    if (!ask || busy) return;
    setBusy(true);
    setNotice("");
    const msgs = chatId ? (messagesByChat.get(chatId) || []) : [];
    const chat = chats.find(c => c.chat_id === chatId);
    const context = chat && msgs.length
      ? `${chat.chat_name}\n${msgs.slice(-12).map(r => `[${stampLabel(r.timestamp)}] ${r.sender_name}: ${r.message_text}`).join("\n")}`
      : "";
    const out = await api("/api/draft", { method: "POST", body: { context, instruction: ask, current: draft }, timeout: 60000 });
    setBusy(false);
    if (!out.ok) { setNotice(out.data?.message || out.data?.error || "Nothing was drafted."); return; }
    setInstruction("");
    setDraft(out.data.text);
  };

  return (
    <div className="frame" style={{ padding: "14px 16px 16px" }}>
      <div className="overline">Write a message</div>
      {chats.length > 0 && (
        <select className="select" style={{ width: "100%", marginBottom: 8, padding: "7px 8px", fontSize: 12, color: "var(--text-primary)" }} value={chatId} onChange={e => setChatId(e.target.value)}>
          <option value="">Choose a chat</option>
          {chats.map(c => <option key={c.chat_id} value={c.chat_id}>{c.chat_name}</option>)}
        </select>
      )}
      {ai && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="field" value={instruction} onChange={e => setInstruction(e.target.value)} onKeyDown={e => { if (e.key === "Enter") run(); }}
            placeholder={busy ? "Drafting" : "Say what the message should do. Chase the delivery, confirm Friday."} disabled={busy} />
          <VoiceInput onTranscript={t => run(t)} onNotice={setNotice} disabled={busy} size={15} />
          <button className="link-btn" onClick={() => run()} disabled={busy || !instruction.trim()}>{busy ? "Working" : draft ? "Rework" : "Draft"}</button>
        </div>
      )}
      {notice && <div className="notice" style={{ marginTop: 8 }}>{notice}</div>}
      <textarea className="area" style={{ marginTop: 12 }} value={draft} onChange={e => setDraft(e.target.value)}
        placeholder={ai ? "The draft appears here. You can also just type." : "Type the message."}
        rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))} />
      {draft.trim() && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <SendControls draft={draft} chatId={chatId} linked={linked} setNotice={setNotice} onSent={() => setDraft("")} />
          {!chatId && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Choose a chat to send from here</span>}
        </div>
      )}
    </div>
  );
}

function FeedChat({ c }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--hairline)" }}>
      <div onClick={() => setOpen(o => !o)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 2px", cursor: "pointer", userSelect: "none" }}>
        <span className="one-line" style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: hover ? "var(--accent)" : "var(--text-primary)", transition: "color 0.15s" }}>{c.name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>{c.msgs.length}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>{stampLabel(c.msgs[c.msgs.length - 1].timestamp)}</span>
        <Chevron open={open} color={hover ? "var(--accent)" : undefined} />
      </div>
      {open && <div style={{ padding: "0 2px 12px" }}><Messages rows={c.msgs} limit={40} /></div>}
    </div>
  );
}


function NlBar() {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("");
  const ask = async () => {
    if (!q.trim()) return;
    const r = await api("/api/nl", { method: "POST", body: { text: q }, timeout: 60000 });
    setOut(r.ok ? (r.data?.reply || "Done.") : "Could not reach the command endpoint.");
  };
  const submit = (ev) => { ev.preventDefault(); ask(); };
  return (
    <div className="frame" style={{ padding: "10px 16px 12px", marginBottom: 18 }}>
      <div className="overline">Ask in plain English</div>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input className="field" value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. run the draw for 2026-W40 · anything needing review · brief · send: thanks to 263771234567 · link my phone · help"
          style={{ flex: "1 1 320px", minWidth: 220 }} />
        <button className="btn primary" type="submit" disabled={!q.trim()}>Ask</button>
      </form>
      {out && <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{out}</div>}
    </div>
  );
}

function Gate({ brand, onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bad, setBad] = useState(false);
  const submit = async () => {
    const out = await api("/api/login", { method: "POST", body: { email, password }, auth: false });
    if (out.ok && out.data?.token) { setToken(out.data.token); onDone(); }
    else setBad(true);
  };
  return (
    <div className="gate">
      <div className="gate-card frame">
        <div className="overline">{brand}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.6 }}>Sign in with your operator email and password.</div>
        <input className="field" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" style={{ width: "100%" }} autoFocus />
        <input className="field" type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder="Password" style={{ width: "100%", marginTop: 6 }} />
        {bad && <div className="notice" style={{ marginTop: 8 }}>Sign-in failed. Check your email and password.</div>}
        <div style={{ marginTop: 14 }}><button className="btn primary" onClick={submit} disabled={!email.trim() || !password}>Open the desk</button></div>
      </div>
    </div>
  );
}

export function Desk() {
  const [config, setConfig] = useState(null);
  const [gate, setGate] = useState(false);
  const [rows, setRows] = useState([]);
  const [threads, setThreads] = useState([]);
  const [briefs, setBriefs] = useState([]);
  const [link, setLink] = useState("offline");
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [windowHours, setWindowHours] = useState(48);
  const [group, setGroup] = useState(null);
  const [priority, setPriority] = useState(null);

  const today = isoOf(new Date());
  const brand = config?.name || "WhatsApp Desk";
  const ai = !!config?.features?.ai;

  useEffect(() => {
    api("/api/config").then(out => {
      if (!out.ok) return;
      setConfig(out.data);
      document.title = out.data.name;
      if (out.data.accent) document.documentElement.style.setProperty("--accent", out.data.accent);
      if (!getToken()) setGate(true);
    });
    return onUnauthorised(() => setGate(true));
  }, []);

  const load = useCallback(async () => {
    const out = await api("/api/data?days=14");
    if (!out.ok) return;
    setRows(out.data.messages || []);
    setThreads(out.data.threads || []);
    setBriefs(out.data.briefs || []);
  }, []);

  const ping = useCallback(async () => {
    const out = await api("/api/status", { timeout: 4000 });
    if (!out.ok) { setLink("offline"); return; }
    setLink(out.data.ready ? "live" : "unlinked");
    setMe(out.data.me || null);
  }, []);

  useEffect(() => {
    if (gate) return;
    load(); ping();
    const slow = setInterval(load, 60000);
    const fast = setInterval(ping, link === "live" ? 15000 : 3000);
    return () => { clearInterval(slow); clearInterval(fast); };
  }, [load, ping, gate, link]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const out = await api(`/api/refresh?hours=${windowHours}`, { method: "POST", timeout: 120000 });
    if (!out.ok) setNotice(out.data?.message || out.data?.detail || out.data?.error || "The brief was refused.");
    else if (!out.data?.brief) setNotice(out.data?.message || "Nothing new since the last brief.");
    await load();
    setBusy(false);
  };

  const unlink = async () => {
    const out = await api("/api/unlink", { method: "POST", timeout: 30000 });
    if (!out.ok) setNotice(out.data?.error || "Could not unlink.");
    ping();
  };

  const onThreadChanged = useCallback((next) => {
    setThreads(prev => prev.map(t => t.chat_id === next.chat_id ? { ...t, ...next } : t));
  }, []);

  const groupOf = useMemo(() => makeGrouper(config), [config]);

  const messagesByChat = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.chat_id)) map.set(r.chat_id, []);
      map.get(r.chat_id).push(r);
    }
    return map;
  }, [rows]);

  const rank = { high: 0, normal: 1, low: 2 };
  const urgencyFirst = (a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || String(b.last_message_at || "").localeCompare(String(a.last_message_at || ""));
  const open = useMemo(() => threads.filter(t => t.status === "open").sort(urgencyFirst), [threads]);
  const filed = useMemo(() => threads.filter(t => t.status === "filed").sort(urgencyFirst), [threads]);
  const handled = useMemo(() => threads.filter(t => t.status === "handled").sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || ""))), [threads]);

  const display = useMemo(() => {
    const all = [...open, ...filed].map(t => ({ t, g: groupOf(t) }))
      .filter(({ t, g }) => (!group || g.group === group) && (!priority || t.priority === priority));
    const out = [];
    for (const name of GROUP_ORDER) {
      const mine = all.filter(r => r.g.group === name);
      if (!mine.length) continue;
      const subs = new Map();
      for (const r of mine) {
        if (!subs.has(r.g.sub)) subs.set(r.g.sub, []);
        subs.get(r.g.sub).push(r.t);
      }
      out.push({
        name, total: mine.length,
        subs: [...subs.entries()].map(([sub, list]) => ({
          sub, threads: list.sort((a, b) => (b.needs_reply === true) - (a.needs_reply === true) || urgencyFirst(a, b)),
        })),
      });
    }
    return out;
  }, [open, filed, group, priority, groupOf]);

  const ringData = useMemo(() => {
    const all = [...open, ...filed].filter(t => !priority || t.priority === priority);
    return GROUP_ORDER.map(k => ({ key: k, label: k, color: GROUPS[k].dot, value: all.filter(t => groupOf(t).group === k).length })).filter(d => d.value > 0);
  }, [open, filed, priority, groupOf]);

  const feedChats = useMemo(() => {
    const cutoff = Date.now() - windowHours * 3600000;
    const out = [];
    for (const [id, list] of messagesByChat) {
      const msgs = list.filter(r => new Date(r.timestamp).getTime() >= cutoff);
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      out.push({ id, name: last.chat_name, type: last.chat_type, msgs });
    }
    return out.sort((a, b) => String(b.msgs[b.msgs.length - 1].timestamp).localeCompare(String(a.msgs[a.msgs.length - 1].timestamp)));
  }, [messagesByChat, windowHours]);

  const composerChats = useMemo(() => {
    const seen = new Map();
    for (const t of threads) seen.set(t.chat_id, { chat_id: t.chat_id, chat_name: t.chat_name });
    for (const c of feedChats) if (!seen.has(c.id)) seen.set(c.id, { chat_id: c.id, chat_name: c.name });
    return [...seen.values()].sort((a, b) => String(a.chat_name).localeCompare(String(b.chat_name)));
  }, [threads, feedChats]);

  if (gate) return <Gate brand={brand} onDone={() => setGate(false)} />;

  const unprocessed = rows.filter(r => !r.processed).length;
  const needReply = open.filter(t => t.needs_reply).length;
  const filtered = group || priority;
  const latest = briefs[0];
  const pulse = latest?.pulse || [
    `${feedChats.length} ${feedChats.length === 1 ? "chat" : "chats"} moved in this window.`,
    needReply ? `${needReply} ${needReply === 1 ? "waits" : "wait"} on you.` : "Nothing waits on you.",
    filed.length ? `${filed.length} routine ${filed.length === 1 ? "report is" : "reports are"} filed.` : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="desk">
      <NlBar />
      <div className="desk-head">
        <span className="desk-title">{brand}</span>
        {config?.locked && <button className="link-btn" style={{ color: "var(--text-tertiary)" }} onClick={() => { setToken(""); setGate(true); }}>Lock</button>}
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, flexWrap: "wrap", marginBottom: 24 }}>
        <div className="frame" style={{ display: "flex", flexWrap: "wrap", rowGap: 8, padding: "12px 10px", flex: "1 1 460px", minWidth: 0 }}>
          {["high", "normal", "low"].map(p => (
            <Metric key={p} value={open.filter(t => t.priority === p).length} label={`${p} priority`}
              tone={p === "high" && open.some(t => t.priority === "high") ? "#b42318" : undefined}
              active={priority === p} onClick={() => setPriority(priority === p ? null : p)} />
          ))}
          <Metric value={needReply} label="Need a reply" />
          <Metric value={open.length} label="Chats open" />
          <Metric value={unprocessed} label="Waiting for a brief" tone={unprocessed ? "#b42318" : undefined} />
        </div>
        {ringData.length > 0 && (
          <div style={{ display: "flex", gap: 14, alignItems: "center", padding: "4px 8px 0 0" }}>
            <Ring data={ringData} size={108} selected={group} onSelect={setGroup} centreLabel="chats" />
            <Legend data={ringData} selected={group} onSelect={setGroup} />
          </div>
        )}
      </div>

      <div className="split">
        <div>
          <SectionHead title="Briefs" count={display.reduce((n, g) => n + g.total, 0)}
            action={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {filtered && <button className="chip" style={{ background: "var(--accent-dim)", color: "var(--accent)", padding: "3px 10px", fontSize: 10, textTransform: "none", letterSpacing: 0 }} onClick={() => { setGroup(null); setPriority(null); }}>Clear filters</button>}
                <select className="select" value={windowHours} onChange={e => setWindowHours(Number(e.target.value))}>
                  <option value={48}>Last 48 hours</option>
                  <option value={72}>Last 3 days</option>
                  <option value={96}>Last 4 days</option>
                  <option value={168}>Last 7 days</option>
                </select>
                {ai && <button className="btn primary" onClick={refresh} disabled={busy}>{busy ? "Writing the brief" : "Brief me"}</button>}
              </span>
            } />

          {notice && <div className="notice" style={{ marginBottom: 10 }}>{notice}</div>}
          {!ai && <div className="empty">Briefs and drafts need OPENAI_API_KEY in .env. Messages are still filed and you can reply by hand.</div>}

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div className="overline">Summary</div>
              {latest && <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{stampLabel(latest.created_at)}</span>}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-secondary)" }}>{pulse}</div>
          </div>

          {latest && (
            <Fold title="Latest brief" count={`${latest.message_count} messages`}>
              <BriefBody md={latest.brief_md} />
              <div className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 10 }}>{latest.direct_count} direct · {latest.group_count} group</div>
            </Fold>
          )}

          {display.length === 0 && (
            <div className="empty">{threads.length === 0 ? "Nothing is triaged yet. Brief me sorts whatever has arrived." : "Nothing matches the current selection."}</div>
          )}

          {display.map(g => (
            <Fold key={g.name} count={g.total}
              title={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ width: 7, height: 7, borderRadius: 999, background: groupTone(g.name).dot }} />{g.name}</span>}
              tone={g.subs.some(s => s.threads.some(t => t.priority === "high")) ? "#b42318" : undefined}
              defaultOpen={display.length === 1}>
              {g.subs.map(s => {
                const list = s.threads.map(t => (
                  <ChatRow key={t.chat_id} t={t} tone={groupTone(g.name)} today={today} messages={messagesByChat.get(t.chat_id) || []}
                    linked={link === "live"} ai={ai} onChanged={onThreadChanged} />
                ));
                return s.sub ? <SubFold key={s.sub} label={s.sub} count={s.threads.length}>{list}</SubFold> : <div key="all">{list}</div>;
              })}
            </Fold>
          ))}
        </div>

        <div>
          <SectionHead title="Chats" count={feedChats.length} action={<ConnectionControl link={link} me={me} onUnlink={unlink} />} />
          {link === "unlinked" && <LinkPanel brand={brand} />}
          {link === "offline" && <OfflinePanel />}
          <div style={{ marginBottom: 18 }}>
            <DraftComposer chats={composerChats} messagesByChat={messagesByChat} linked={link === "live"} ai={ai} />
          </div>
          <div style={{ overflowY: "auto", maxHeight: "max(340px, calc(100vh - 380px))", paddingRight: 6 }}>
            {feedChats.length
              ? feedChats.map(c => <FeedChat key={c.id} c={c} />)
              : <div className="empty">{link === "live" ? "No messages in this window yet. New messages appear here as they arrive." : "No messages in this window."}</div>}
          </div>
        </div>
      </div>

      <div style={{ height: 36 }} />
      <SectionHead title="History" />
      <div className="split">
        <div style={{ maxHeight: 320, overflowY: "auto", paddingRight: 6 }}>
          <div className="overline">Earlier briefs</div>
          {briefs.length > 1
            ? briefs.slice(1).map(b => <Fold key={b.id} title={stampLabel(b.created_at)} count={`${b.message_count} messages`}><BriefBody md={b.brief_md} /></Fold>)
            : <div className="empty">No earlier briefs.</div>}
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto", paddingRight: 6 }}>
          <div className="overline">Handled chats</div>
          {handled.length
            ? handled.map(t => (
              <div key={t.chat_id} style={{ padding: "8px 2px", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: groupTone(groupOf(t).group).dot, flexShrink: 0 }} />
                  <span className="one-line" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>{t.chat_name}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>{agoLabel(t.last_message_at, today)}</span>
                </div>
                {t.summary && <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 3, marginLeft: 15, lineHeight: 1.5 }}>{t.summary}</div>}
              </div>
            ))
            : <div className="empty">No handled chats yet.</div>}
        </div>
      </div>

      <div style={{ height: 20 }} />
      {ai && <UsageLine />}
    </div>
  );
}
