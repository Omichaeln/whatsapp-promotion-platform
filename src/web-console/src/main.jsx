import { createRoot } from "react-dom/client";
import { Component } from "react";
import { App } from "./App.jsx";

// Error boundary: a render crash must never leave a silent white screen —
// show the error so it is visible and reportable.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: "28px", maxWidth: 560, margin: "48px auto", background: "#fff", border: "1px solid #b42318", borderRadius: 12, color: "#111" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#b42318" }}>The console hit an error</div>
          <div style={{ fontSize: 12.5, color: "#444", marginTop: 10, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {String(this.state.err?.message || this.state.err)}
            {this.state.err?.stack ? `\n\n${this.state.err.stack}` : ""}
          </div>
          <button style={{ marginTop: 14, padding: "8px 16px", border: "1px solid #999", background: "#fff", borderRadius: 8, cursor: "pointer" }} onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Last-resort safety net for uncaught exceptions and rejected promises.
window.addEventListener("error", (e) => renderFatal(e.message || "uncaught error"));
window.addEventListener("unhandledrejection", (e) => renderFatal(String(e.reason || "unhandled rejection")));
let fatalShown = false;
let fatalEl = null;
function renderFatal(msg) {
  if (fatalShown || !document.getElementById("root")) return;
  fatalShown = true;
  fatalEl = document.createElement("div");
  fatalEl.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999;padding:36px;font:13px/1.6 sans-serif;color:#111;display:flex;flex-direction:column;gap:14px";
  const h = document.createElement("b");
  h.style.color = "#b42318";
  h.textContent = "The console hit an error";
  const p = document.createElement("div");
  p.style.whiteSpace = "pre-wrap";
  p.style.wordBreak = "break-all";
  p.textContent = msg;
  const btn = document.createElement("button");
  btn.textContent = "Reload";
  btn.style.cssText = "padding:8px 16px;border:1px solid #999;background:#fff;border-radius:8px;cursor:pointer";
  btn.onclick = function () { location.reload(); };
  fatalEl.append(h, p, btn);
  document.getElementById("root").append(fatalEl);
}

createRoot(document.getElementById("root")).render(<ErrorBoundary><App /></ErrorBoundary>);