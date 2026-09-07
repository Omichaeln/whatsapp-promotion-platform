import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function VoiceInput({ onTranscript, onNotice, disabled, size = 15 }) {
  const [state, setState] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const tickRef = useRef(null);
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  useEffect(() => () => { clearInterval(tickRef.current); recRef.current?.stream?.getTracks?.().forEach(t => t.stop()); }, []);

  if (!supported) return null;

  const start = async () => {
    if (disabled || state !== "idle") return;
    const mime = pickMime();
    if (!mime) { onNotice?.("This browser cannot record audio."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = e => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(tickRef.current);
        setState("working");
        const blob = new Blob(chunksRef.current, { type: mime });
        const out = await api("/api/transcribe", { method: "POST", body: blob, raw: true, timeout: 60000 });
        setState("idle");
        setElapsed(0);
        if (!out.ok) { onNotice?.(out.data?.message || out.data?.error || "Dictation failed."); return; }
        if (out.data?.text) onTranscript?.(out.data.text);
      };
      recRef.current = rec;
      rec.start(250);
      setElapsed(0);
      tickRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
      setState("recording");
    } catch {
      onNotice?.("Microphone access was refused.");
    }
  };

  const stop = () => { if (state === "recording") recRef.current?.stop(); };

  const tone = state === "recording" ? "#b42318" : state === "working" ? "var(--text-tertiary)" : "var(--text-tertiary)";
  return (
    <button
      onClick={state === "recording" ? stop : start}
      disabled={disabled || state === "working"}
      title={state === "recording" ? "Stop and transcribe" : "Dictate"}
      style={{ border: "none", background: "transparent", padding: "4px 6px", display: "inline-flex", alignItems: "center", gap: 6, color: tone }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      {state === "recording" && <span className="mono" style={{ fontSize: 10 }}>{clock(elapsed)}</span>}
      {state === "working" && <span style={{ fontSize: 10 }}>Transcribing</span>}
    </button>
  );
}
