import { nowIso } from "./db.mjs";

/**
 * AI service (restored from the original WhatsApp Desk, server/ai.mjs).
 * Workflow restored: triage/classification of inbound traffic into a pulse +
 * markdown brief + per-chat category/priority/draft; reply drafting; voice
 * transcription; usage metering with a monthly budget cap.
 *
 * Provider: OpenAI-compatible chat completions when OPENAI_API_KEY is set.
 * Fallback: deterministic classifiers so every workflow still runs (and is
 * testable) without a key — the fallback is honest, keyword+rule based.
 */

// ---- deterministic fallbacks -------------------------------------------------
const CATS = [
  { key: "Customers", hint: "people asking about products, orders, prices, complaints", match: ["price", "order", "buy", "cost", "stock", "promo", "entry", "receipt"] },
  { key: "Team", hint: "staff and day-to-day operations", match: ["team", "shift", "report", "stock levels", "opening", "closing", "daily", "figures", "sold", "stock"] },
  { key: "Partners and suppliers", hint: "suppliers, service providers, banks", match: ["supplier", "delivery", "invoice", "bank", "payment"] },
  { key: "Other", hint: "anything else", match: [] },
];
function classifyText(text) {
  const t = String(text || "").toLowerCase();
  for (const c of CATS) if (c.match.some((m) => t.includes(m))) return c.key;
  return "Other";
}
function priorityOf(text) {
  const t = String(text || "").toLowerCase();
  if (["urgent", "problem", "complaint", "refund", "broken", "error", "wow"].some((m) => t.includes(m))) return "high";
  return "normal";
}
function needsReply(text) {
  const t = String(text || "").toLowerCase();
  return ["?", "help", "how do", "can you", "when", "please", "is it"].some((m) => t.includes(m));
}
function draftFor(text, name) {
  const t = String(text || "");
  const trimmed = t.length > 90 ? t.slice(0, 90) + "…" : t;
  return `Thanks for your message${name ? `, ${name}` : ""}. Noted: "${trimmed}". We'll get back to you shortly.`;
}

// ---- usage metering (port of server/usage.mjs) ----------------------------------
const PRICES = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "whisper-1": { audioMinute: 0.006 },
};
function costOf({ model, inputTokens = 0, outputTokens = 0, audioSeconds = 0 }) {
  const p = PRICES[model] || PRICES["gpt-4o-mini"];
  const tokens = ((inputTokens * (p.input || 0)) + (outputTokens * (p.output || 0))) / 1_000_000;
  const audio = (audioSeconds / 60) * (p.audioMinute || 0);
  return Number((tokens + audio).toFixed(6));
}

export function createUsage(store, capUsd) {
  return {
    async snapshot() { const month = await store.monthUsage(); const cap = Number(capUsd) || 0; return { month_usd: Number(month ?? 0).toFixed(4), cap_usd: cap, pct: cap ? Math.min(999, Math.round((Number(month ?? 0) / cap) * 100)) : 0, blocked: cap > 0 && Number(month ?? 0) >= cap }; },
    async block() {
      const snap = await this.snapshot();
      if (!snap.blocked) return null;
      return { status: 429, body: { error: "budget_cap_reached", message: `The monthly model budget of $${snap.cap_usd.toFixed(2)} is spent.`, usage: snap } };
    },
    async log(entry) {
      const usd = costOf(entry);
      await store.logUsage({ ...entry, usd });
      return this.snapshot();
    },
  };
}

// ---- the service ----------------------------------------------------------------
export function createAi({ cfg, store, usage }) {
  const model = cfg.ai?.openaiModel || "gpt-4o-mini";
  const key = cfg.ai?.openaiKey || "";
  const baseUrl = (cfg.ai?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const hasKey = !!key;

  async function chat(messages, extra = {}) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, ...extra }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`model call failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Triage/classify a batch of chat rows -> { pulse, brief_md, chats[] }.
   * chats[]: { chat_id, category, priority, needs_reply, confidence, routine_report, summary, draft }.
   * Uses the model when configured; otherwise a deterministic classifier so the
   * workflow is always exercisable end to end.
   */
  async function summarise(rows, opts = {}) {
    const byChat = new Map();
    for (const r of rows) {
      const cur = byChat.get(r.chat_id);
      if (!cur || String(r.timestamp) > String(cur.timestamp)) byChat.set(r.chat_id, r);
    }
    const chats = [];
    for (const [chatId, last] of byChat) {
      const recent = rows.filter((r) => r.chat_id === chatId).slice(-6);
      const text = recent.map((r) => `${r.sender_name}: ${r.message_text}`).join(" | ");
      const cat = classifyText(text);
      const pri = priorityOf(text);
      const reply = needsReply(text);
      chats.push({
        chat_id: chatId,
        chat_name: last.chat_name,
        chat_type: last.chat_type,
        category: cat,
        priority: pri,
        needs_reply: reply,
        confidence: 3,
        routine_report: !reply && (cat === "Team" || /report|daily|figures|sold|inventory|units/i.test(text)),
        summary: String(text).slice(0, 180),
        draft: reply ? draftFor(text, last.chat_name) : "",
      });
    }
    const pulse = `${rows.length} message(s) across ${byChat.size} chat(s). ${
      chats.filter((c) => c.priority === "high").length ? `${chats.filter((c) => c.priority === "high").length} high-priority chat(s) need attention.` : "Nothing needs urgent attention."}`;
    const briefBody = chats.filter((c) => c.category !== "Other" || c.needs_reply).map((c) =>
      `- ${c.category}: ${c.chat_name} — ${c.summary}${c.draft ? ` [draft ready]` : ""}`).join("\n") || "- No business content in this window.";

    // P0-05: when a model key exists, triage ACTUALLY calls the model with a
    // strict JSON schema; the deterministic classifier runs only as an
    // explicitly labelled fallback (missing key, budget cap, or model error).
    // Provenance is always truthful — we never claim model output we did not
    // produce.
    if (hasKey) {
      try {
        if (usage) {
          const blocked = await usage.block();
          if (blocked) throw new Error(blocked.body.message);
        }
        const body = await chat([
          { role: "system", content: `You classify WhatsApp customer messages for a promotion desk. Return STRICT JSON only:
{"chats":[{"chat_id":"...","category":"Customers|Team|Partners and suppliers|Other","priority":"high|normal","needs_reply":true|false,"routine_report":true|false,"summary":"one line","draft":"short draft if needs_reply else empty string"}]}
Rules: category by business intent; "routine_report" only for internal team figures; draft only when customer needs a reply; plain WhatsApp register.` },
          { role: "user", content: JSON.stringify(rows.map((r) => ({ chat_id: r.chat_id, chat_name: r.chat_name, sender: r.sender_name, text: r.message_text, ts: r.timestamp }))) },
        ], { temperature: 0, max_tokens: 1000 });
        const raw = String(body?.choices?.[0]?.message?.content || "");
        const parsed = JSON.parse(raw.replace(/^```[a-z]*\n?|\n?```$/g, "").trim());
        const chats2 = Array.isArray(parsed.chats) ? parsed.chats : [];
        const ppm = await usage?.log({ kind: "triage", model, route: "summarise", inputTokens: body?.usage?.prompt_tokens, outputTokens: body?.usage?.completion_tokens }) ?? null;
        return {
          pulse, brief_md: briefBody, chats: chats2, model, made_by: "openai",
          usage: ppm, provider: "openai-compatible", provenance: "model",
        };
      } catch (e) {
        // fall through to deterministic — labelled honestly
        const out = { pulse, brief_md: briefBody, chats, model: "deterministic-v1", made_by: "fallback", provenance: "fallback", error: e.message };
        return out;
      }
    }
    return {
      pulse,
      brief_md: briefBody,
      chats,
      model: "deterministic-v1",
      made_by: "fallback",
      provenance: "fallback",
    };
  }

  /** Draft a reply (model if key; template otherwise). */
  async function draft({ context, instruction, current }) {
    if (!hasKey) {
      const ask = String(instruction || "").trim() || "Draft the reply this conversation is waiting for.";
      const ctx = String(context || "").trim();
      const text = ctx.length > 160 ? ctx.slice(0, 160) + "…" : ctx;
      return { text: draftFor(text, ""), made_by: "fallback" };
    }
    const ask = String(instruction || "").trim() || (current ? "Rework the draft to be tighter." : "Draft the reply this conversation is waiting for.");
    let body;
    try {
      if (usage) { const b = await usage.block(); if (b) return { status: b.status, error: b.body.message, made_by: "blocked" }; }
      body = await chat([
        { role: "system", content: `You draft WhatsApp messages the owner will send personally. Keep it short, direct, WhatsApp register: no preamble, no quotes, no signature, no em dashes, no emojis.${current ? `\nCurrent draft:\n${current}` : ""}${context ? `\nConversation:\n${String(context).slice(0, 3000)}` : ""}` },
        { role: "user", content: ask },
      ], { temperature: 0.4, max_tokens: 600 });
    } catch (err) { return { status: 502, error: err.message }; }
    const text = String(body?.choices?.[0]?.message?.content || "").replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
    const snap = usage ? await usage.log({ kind: "draft", model, route: "draft", inputTokens: body?.usage?.prompt_tokens, outputTokens: body?.usage?.completion_tokens }) : null;
    return { text, made_by: "openai", usage: snap };
  }

  /** Transcribe voice (whisper if key; otherwise explicit that it requires a key). */
  async function transcribe(buffer, mime) {
    if (!hasKey) return { status: 503, text: null, error: "OPENAI_API_KEY is not set. Set it to enable voice transcription (the desk still links, files and sends without it)." };
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([buffer], { type: mime }), `dictation.${ext}`);
    const res = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) return { status: 502, error: `transcription failed (${res.status})` };
    const out = await res.json();
    const seconds = Number(out?.duration) || Math.max(1, Math.round(buffer.length / 4000));
    const snap = usage ? await usage.log({ kind: "voice", model: "whisper-1", route: "transcribe", audioSeconds: seconds }) : null;
    return { status: 200, text: String(out?.text || "").trim(), usage: snap };
  }

  /** Ask any question against fresh data — powers the natural-language console. */
  async function ask(question, contextRows) {
    if (hasKey) {
      try {
        const body = await chat([
          { role: "system", content: "You are the operations copilot for a WhatsApp promotion platform. Answer concisely from the data provided. Plain text, no markdown headers." },
          { role: "user", content: `DATA:\n${String(contextRows || "").slice(0, 8000)}\n\nQUESTION: ${question}` },
        ], { temperature: 0.2, max_tokens: 500 });
        const text = String(body?.choices?.[0]?.message?.content || "").trim();
        if (usage) await usage.log({ kind: "ask", model, route: "ask", inputTokens: body?.usage?.prompt_tokens, outputTokens: body?.usage?.completion_tokens });
        return text || "No answer.";
      } catch { /* fall through to deterministic */ }
    }
    // deterministic: echo the top facts + the question
    const head = String(contextRows || "").trim().split("\n").slice(0, 8).join("\n");
    return `Copilot (offline mode):\n${head}\n\nAsk again with OPENAI_API_KEY set for a model-written answer. Your question: ${question}`;
  }

  return { summarise, draft, transcribe, ask, hasKey, model, usage };
}