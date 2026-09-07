// Generates src/web-console/src/desk/Desk.jsx from the ORIGINAL WhatsApp Desk
// App.jsx with faithful, minimal adaptations:
//   1. export default App -> export function Desk
//   2. Gate becomes an email/password sign-in (server-side auth)
//   3. gate shows whenever there is no token (server login is the lock)
//   4. a natural-language command bar renders at the top of the desk
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const originalPath = path.join(SRC, "src", "web-console", "src", "desk", "App.original.jsx");
const outPath = path.join(SRC, "src", "web-console", "src", "desk", "Desk.jsx");

let src = fs.readFileSync(originalPath, "utf8");

// 1. named export
src = src.replace("export default function App() {", "export function Desk() {");

const nlBar = `
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
`;

const newGate = `
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
`;

// Boundaries: everything before old Gate stays; Gate..App is replaced with NlBar+new Gate+Desk.
const gateStart = src.indexOf("function Gate({ brand, onDone }) {");
const appLine = "export function Desk() {";
const appStart = src.indexOf(appLine);
if (gateStart < 0 || appStart < 0) throw new Error("boundaries not found");
const head = src.slice(0, gateStart);
const tail = src.slice(appStart); // begins with "export function Desk() {"
src = head + nlBar + newGate + "\n" + tail;

// 3. gate on missing token
src = src.replace("if (out.data.locked && !getToken()) setGate(true);", "if (!getToken()) setGate(true);");

// 4. NL bar renders at the top of the desk body
src = src.replace('return (\n    <div className="desk">', 'return (\n    <div className="desk">\n      <NlBar />');

fs.writeFileSync(outPath, src);
console.log("wrote", outPath, src.length, "chars");