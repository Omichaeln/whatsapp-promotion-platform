import fs from "node:fs";
import path from "node:path";
import { E } from "../http.mjs";
import { ROOT } from "../config.mjs";
import { nowIso } from "../db.mjs";
import { parseCommand, HELP_TEXT } from "../nlp.mjs";
import { LinkedDeviceTransport } from "../transport/linked-device.mjs";

/**
 * Legacy "WhatsApp Desk" routes retained from the original project (message
 * triage, briefs, drafting, linked-device QR, natural-language commands).
 * Preserved as the user's prior work; quarantined behind roles and NOT part of
 * the promotion journeys. linked-device is dev only (validateConfig).
 */
export function registerDeskRoutes(r, S) {
  const { db, domain, auth, desk, ai, usage, transport, outbox, drawService, cfg, activity, metricsPayload } = S;
  const PA = ["platform_admin"], SU = ["support", "platform_admin"];
  r.add("GET", "/api/config", { roles: "public", tag: "public" }, () => { const brand = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "brand.json"), "utf8")); return { ...brand, name: brand.name || "WhatsApp Promotion Platform", locked: !cfg.adminPassword, features: { ai: ai.hasKey, promotion: true }, transport: cfg.whatsappTransport, environment: domain.environment(), sample_data: !!domain.getSetting("sample_data", null) }; });
  r.add("GET", "/api/qr", { roles: PA, allowTokenQuery: true, tag: "desk" }, ({ res }) => { const raw = typeof transport.currentQr === "function" ? transport.currentQr() : null; if (!raw) throw E.notFound("no QR pending"); const svg = transport.qrSvg?.(); res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }); res.end(svg); });
  r.add("GET", "/api/qr/raw", { roles: PA, tag: "desk" }, () => { const raw = transport.currentQr?.(); if (!raw) throw E.notFound("no QR pending"); return { qr: raw, ttl: 30 }; });
  r.add("GET", "/api/status", { roles: "any", tag: "desk" }, () => ({ ...(transport.health?.() || {}), provider: cfg.whatsappTransport }));
  r.add("GET", "/api/metrics", { roles: "any", tag: "desk" }, () => metricsPayload());
  r.add("GET", "/api/activity", { roles: "any", tag: "desk" }, ({ url }) => ({ events: desk.recentActivity(Number(url.searchParams.get("limit") || 30)) }));
  r.add("GET", "/api/data", { roles: SU, tag: "desk" }, ({ url }) => { const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 14))); const sinceIso = new Date(Date.now() - days * 86400_000).toISOString(); return { messages: desk.messages({ where: "where timestamp >= ?", params: [sinceIso], limit: 3000 }).map((m) => ({ ...m, processed: m.processed === 1 })), threads: desk.threads().map((t) => ({ ...t, needs_reply: t.needs_reply === 1 })), briefs: desk.briefs(12) }; });
  r.add("GET", "/api/usage", { roles: "any", tag: "desk" }, () => usage.snapshot());
  const brief = async (hours) => { const cutoffIso = new Date(Date.now() - hours * 3600_000).toISOString(); const rows = await desk.unprocessed({ cutoffIso, limit: 800 }); if (!rows.length) return { brief: null, message: "Nothing new since the last brief." }; const result = await ai.summarise(rows); const b = desk.insertBrief({ brief_md: result.brief_md, pulse: result.pulse, message_count: rows.length, direct_count: rows.filter((x) => x.chat_type === "direct").length, group_count: rows.filter((x) => x.chat_type === "group").length, model: result.model, made_by: result.made_by }); for (const c of result.chats) { const last = rows.filter((x) => x.chat_id === c.chat_id).sort((a, b2) => (String(b2.timestamp) < String(a.timestamp) ? -1 : 1))[0]; if (last) desk.upsertThread({ chat_id: c.chat_id, chat_type: c.chat_type, chat_name: c.chat_name, category: c.category, priority: c.priority, needs_reply: c.needs_reply, confidence: c.confidence, summary: c.summary, draft: c.draft, status: c.routine_report && !c.needs_reply ? "filed" : "open", last_message_at: last.timestamp, updated_at: nowIso() }); } desk.markProcessed(rows.map((x) => x.id)); activity("brief", `Brief: ${rows.length} messages across ${result.chats.length} chats`, { hours }); return { brief: b, pulse: result.pulse, chats: result.chats, made_by: result.made_by }; };
  r.add("POST", "/api/refresh", { roles: SU, tag: "desk" }, async ({ body }) => brief(Math.min(24 * 14, Math.max(1, Number((await body()).hours || 48)))));
  r.add("POST", "/api/desk/brief", { roles: SU, tag: "desk" }, async ({ body }) => brief(Math.min(24 * 14, Math.max(1, Number((await body()).hours || 48)))));
  const draft = async ({ body }) => { const b = await body(); const out = await ai.draft({ context: b.context, instruction: b.instruction, current: b.current }); if (out.status) return { __status: out.status, body: out }; return out; };
  r.add("POST", "/api/draft", { roles: SU, tag: "desk" }, draft);
  r.add("POST", "/api/desk/draft", { roles: SU, tag: "desk" }, draft);
  const patchThread = async ({ params, body }) => { const b = await body(); const chatId = decodeURIComponent(params.id); const t = desk.thread(chatId); if (!t) throw E.notFound("thread not found"); desk.upsertThread({ chat_id: chatId, chat_type: t.chat_type || "direct", chat_name: t.chat_name, category: b.category || t.category || "Other", priority: b.priority || t.priority, needs_reply: b.needs_reply ?? t.needs_reply, confidence: b.confidence ?? t.confidence, summary: b.summary ?? t.summary, draft: b.draft !== undefined ? b.draft : t.draft, status: b.status || t.status, last_message_at: t.last_message_at, updated_at: nowIso() }); return { ...desk.thread(chatId), needs_reply: desk.thread(chatId).needs_reply === 1 }; };
  r.add("PATCH", "/api/threads/:id", { roles: SU, tag: "desk" }, patchThread);
  r.add("PATCH", "/api/desk/threads/:id", { roles: SU, tag: "desk" }, patchThread);
  r.add("POST", "/api/send", { roles: SU, tag: "desk" }, async ({ user, body }) => { const b = await body(); const target = String(b.chat_id || b.target || ""); if (!b.text) throw E.badRequest("text is required"); if (target.endsWith("@g.us")) throw E.badRequest("cannot send to a group"); const phone = target.split("@")[0].replace(/[^\d]/g, ""); outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "support", payload: String(b.text).slice(0, 4000), idempotencyKey: `send:${nowIso()}:${phone}:${String(b.text).slice(0, 16)}` }); activity("send", `Queued message to ${domain.maskPhone(phone)}`, { len: String(b.text).length }); domain.audit({ actorType: "admin", actorId: user.id, action: "support.message", targetType: "conversation", targetId: domain.maskPhone(phone) }); return { ok: true, queued: true }; });
  r.add("POST", "/api/unlink", { roles: PA, tag: "desk" }, async () => { if (typeof transport.unlink === "function") await transport.unlink(); return { ok: true }; });
  r.add("GET", "/api/desk/qr", { roles: PA, tag: "desk" }, () => { const health = transport.health?.() || {}; return { svg: transport.qrSvg?.() || null, ready: health.ready || false, me: health.me, qr: health.qr, lastError: health.lastError }; });
  r.add("POST", "/api/desk/link", { roles: PA, tag: "desk" }, async () => { if (!(transport instanceof LinkedDeviceTransport)) throw E.badRequest("linked-device transport is not active"); await transport.start(); return { ok: true, message: "Scan the QR code with WhatsApp > Linked devices > Link a device" }; });
  r.add("POST", "/api/desk/unlink", { roles: PA, tag: "desk" }, async () => { if (typeof transport.unlink === "function") await transport.unlink(); return { ok: true }; });
  r.add("GET", "/api/desk/status", { roles: "any", tag: "desk" }, async () => ({ transport: transport.health?.() || {}, desk: { threads: desk.threadStats(), messages: desk.countMessages() }, usage: await usage.snapshot(), ai: { provider: ai.hasKey ? (cfg.ai?.openaiModel || "gpt-4o-mini") : "deterministic-fallback" } }));
  r.add("GET", "/api/desk/messages", { roles: SU, tag: "desk" }, ({ url }) => ({ messages: desk.messages({ limit: Number(url.searchParams.get("limit") || 100) }) }));
  r.add("GET", "/api/desk/threads", { roles: SU, tag: "desk" }, ({ url }) => { const q = url.searchParams; return { threads: desk.threads({ status: q.get("status") || undefined, priority: q.get("priority") || undefined, category: q.get("category") || undefined, limit: Number(q.get("limit") || 300) }) }; });
  r.add("GET", "/api/desk/briefs", { roles: SU, tag: "desk" }, ({ url }) => ({ briefs: desk.briefs(Number(url.searchParams.get("limit") || 12)) }));
  const transcribe = async ({ req, raw }) => {
    const m = (req.headers["content-type"] || "").match(/multipart\/form-data;\s*boundary=([^;]+)/); if (!m) throw E.badRequest("multipart audio required");
    const bodyBuf = await raw(); const boundary = Buffer.from(`--${m[1]}`);
    const first = bodyBuf.indexOf(boundary); const partStart = first + boundary.length + 2; const headerEnd = bodyBuf.indexOf(Buffer.from("\r\n\r\n"), partStart); if (headerEnd < 0) throw E.badRequest("malformed multipart");
    const payloadStart = headerEnd + 4; const next = bodyBuf.indexOf(boundary, payloadStart); const audioBytes = next > 0 ? bodyBuf.subarray(payloadStart, next - 2) : bodyBuf.subarray(payloadStart);
    const mimeMatch = bodyBuf.subarray(partStart, headerEnd).toString("latin1").match(/content-type:\s*([^\r\n;]+)/i);
    const out = await ai.transcribe(audioBytes, mimeMatch ? mimeMatch[1].trim() : "audio/webm"); if (out.status) return { __status: out.status, body: out }; activity("voice", "Transcribed a voice note", {}); return { text: out.text, usage: out.usage };
  };
  r.add("POST", "/api/desk/transcribe", { roles: SU, tag: "desk", bodyLimit: 25 * 1024 * 1024 }, transcribe);
  r.add("POST", "/api/transcribe", { roles: SU, tag: "desk", bodyLimit: 25 * 1024 * 1024 }, transcribe);
  r.add("POST", "/api/nl", { roles: "any", tag: "desk" }, async ({ user, body }) => {
    const b = await body(); const parsed = parseCommand(b.text || "");
    if (parsed.action === "help" || !parsed.action) return { action: "help", reply: HELP_TEXT, available: true };
    let data = null, reply = parsed.reply;
    try {
      const requireRole = (role, what) => { if (!auth.hasRole(user, role)) throw new Error(`${what} requires role "${role}"`); };
      switch (parsed.action) {
        case "dashboard": data = await metricsPayload(); break;
        case "status": { const h = transport.health?.() || {}; data = { transport: h, usage: await usage.snapshot() }; reply = `System ${h.ok ? "ready" : "waiting"} (${h.provider}, ${h.mode || ""}).`; break; }
        case "review": requireRole("reviewer", "listing reviews"); data = { receipts: db.prepare(`select id, status, reason_code, created_at from receipts where status=? order by created_at desc limit ?`).all(parsed.params.status || "REVIEW_REQUIRED", parsed.params.limit || 20) }; reply = `${data.receipts.length} receipt(s) in review.`; break;
        case "entries": requireRole("auditor", "listing entries"); data = { entries: db.prepare(`select id, period_code, status, created_at from entries order by created_at desc limit 50`).all() }; reply = `${data.entries.length} entry(ies).`; break;
        case "participants": requireRole("support", "listing participants"); data = { participants: domain.searchParticipants({ limit: 50 }) }; reply = `${data.participants.length} participant(s).`; break;
        case "campaigns": data = { campaigns: domain.listCampaigns() }; break;
        case "winners": requireRole("winner_ops", "listing winners"); data = { winners: db.prepare(`select id, rank, prize_code, status from winners order by rank limit 50`).all() }; reply = `${data.winners.length} winner(s) recorded.`; break;
        case "draw": requireRole("draw_officer", "running a draw"); reply = "Draws run from the Draws page: choose a period, check the barrier, freeze, execute; a different approver approves."; break;
        case "send": { requireRole("support", "sending outbound messages"); if (!parsed.params?.phone) reply = "Who should I message? e.g. \"send: thanks to 263771234567\""; else { const msgId = outbox.enqueueWhatsApp({ waPhoneUid: parsed.params.phone, kind: "text", purpose: "support", payload: parsed.params.text, idempotencyKey: `nl:${Date.now()}:${parsed.params.phone}` }); data = { queued: msgId }; reply = `Queued: "${parsed.params.text.slice(0, 60)}" to ${domain.maskPhone(parsed.params.phone)}.`; } break; }
        case "draft": { const out = await ai.draft({ context: parsed.params.text || "", instruction: b.text, current: null }); data = out; reply = out.text || "Draft ready (set an AI key for model drafts)."; break; }
        case "classify": { const out = await ai.summarise([{ chat_id: "nl", chat_type: "direct", chat_name: "Natural language", sender_name: "operator", message_text: parsed.params.text || "", timestamp: nowIso() }]); data = { classification: out.chats[0] }; reply = `Category: ${out.chats[0].category} · priority ${out.chats[0].priority}.`; break; }
        case "brief": { const out = await brief(48); data = out; reply = out.pulse || out.message; break; }
        case "link": { requireRole("platform_admin", "linking a device"); const svg = transport.qrSvg?.() || null; data = { svg, ready: transport.health?.().ready }; reply = svg ? "Scan the QR code to link your phone." : "No QR pending."; break; }
        case "unlink": { requireRole("platform_admin", "unlinking a device"); if (typeof transport.unlink === "function") await transport.unlink(); reply = "Device unlinked."; break; }
        default: reply = "I didn't catch that. Type \"help\".";
      }
    } catch (e) { reply = `That didn't work: ${e.message}`; }
    return { action: parsed.action, confidence: parsed.confidence, reply, data };
  });
  r.add("GET", "/api/diag", { roles: PA, tag: "desk" }, async () => { const out = { node: process.version, cwd: process.cwd(), env: { railway: !!process.env.RAILWAY_PROJECT_ID, region: process.env.RAILWAY_REGION || null }, transport: cfg.whatsappTransport, transportState: transport.health?.() }; for (const [name, url] of [["graph.facebook.com", "https://graph.facebook.com/"]]) { const s = Date.now(); try { const x = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "manual" }); out[`reach_${name}`] = { status: x.status, ms: Date.now() - s }; } catch (e) { out[`reach_${name}`] = { error: e.message.slice(0, 120), ms: Date.now() - s }; } } return out; });
  void drawService;
}
