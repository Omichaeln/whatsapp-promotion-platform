import { id, nowIso } from "./db.mjs";

/**
 * Desk data layer (restored from the original WhatsApp Desk store):
 * filed messages, per-chat threads, briefs, usage metering and an activity
 * feed. SQLite-first, adapter-friendly (same method surface as the original).
 */
export function createDeskStore(db, now = nowIso) {
  // ---- messages ----------------------------------------------------------
  const upsert = db.prepare(`insert or ignore into desk_messages
    (message_sid, chat_type, chat_id, chat_name, sender_name, message_text, processed, timestamp)
    values (?,?,?,?,?,?,0,?)`);
  // ---- threads ------------------------------------------------------------
  const upsertThread = db.prepare(`insert into desk_threads
    (chat_id, chat_type, chat_name, category, priority, needs_reply, confidence, summary, draft, status, last_message_at, updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(chat_id) do update set
      chat_name=excluded.chat_name, category=excluded.category, priority=excluded.priority,
      needs_reply=excluded.needs_reply, confidence=excluded.confidence, summary=excluded.summary,
      draft=case when excluded.draft is null or excluded.draft='' then desk_threads.draft else excluded.draft end,
      status=excluded.status, last_message_at=excluded.last_message_at, updated_at=excluded.updated_at`);
  // ---- briefs --------------------------------------------------------------
  const insertBrief = db.prepare(`insert into desk_briefs
    (brief_md, pulse, message_count, direct_count, group_count, model, made_by, created_at)
    values (?,?,?,?,?,?,?,?)`);
  // ---- usage -----------------------------------------------------------------
  // ---- activity ---------------------------------------------------------------
  const insertActivity = db.prepare(`insert into activity_events (kind, summary, detail_json, created_at) values (?,?,?,?)`);

  return {
    // messages
    upsertMessage(m) {
      const sid = m.message_sid || `${m.chat_id}:${m.id ?? now()}`;
      return upsert.run(sid, m.chat_type || "direct", m.chat_id, m.chat_name || null, m.sender_name || null,
        String(m.message_text || "").slice(0, 4000), m.timestamp || now()).changes > 0;
    },
    messages(query = {}) {
      const sql = `select * from desk_messages ${query.where || ""} order by timestamp desc limit ?`;
      return db.prepare(sql).all(query.limit || 200);
    },
    unprocessed({ cutoffIso, limit = 800 }) {
      return db.prepare(`select * from desk_messages where processed=0 and timestamp >= ? order by timestamp limit ?`).all(cutoffIso, limit);
    },
    markProcessed(ids) {
      if (!ids?.length) return;
      const st = db.prepare(`update desk_messages set processed=1 where id=?`);
      db.exec("begin");
      try { for (const idv of ids) st.run(idv); db.exec("commit"); } catch { db.exec("rollback"); throw new Error("markProcessed failed"); }
    },
    countMessages() { return db.prepare(`select count(*) n from desk_messages`).get().n; },
    recentActivity(limit = 30) {
      return db.prepare(`select * from activity_events order by id desc limit ?`).all(limit);
    },
    // threads
    threads(filters = {}) {
      const where = [];
      const params = [];
      if (filters.status) { where.push("status=?"); params.push(filters.status); }
      if (filters.priority) { where.push("priority=?"); params.push(filters.priority); }
      if (filters.category) { where.push("category=?"); params.push(filters.category); }
      params.push(filters.limit || 300);
      const sql = `select * from desk_threads ${where.length ? "where " + where.join(" and ") : ""} order by updated_at desc limit ?`;
      return db.prepare(sql).all(...params);
    },
    thread(chatId) { return db.prepare(`select * from desk_threads where chat_id=?`).get(chatId); },
    threadDrafts(chatIds) {
      const out = new Map();
      if (!chatIds?.length) return out;
      for (const cid of chatIds) {
        const r = db.prepare(`select draft from desk_threads where chat_id=? and draft is not null and draft<>'' limit 1`).get(cid);
        if (r?.draft) out.set(cid, r.draft);
      }
      return out;
    },
    upsertThread(t) {
      upsertThread.run(t.chat_id, t.chat_type, t.chat_name, t.category, t.priority,
        Number(t.needs_reply ? 1 : 0), Math.min(5, Math.max(1, Number(t.confidence) || 3)),
        String(t.summary || "").slice(0, 500), String(t.draft || "").slice(0, 4000) || null,
        t.status || "open", t.last_message_at, t.updated_at || now());
    },
    threadStats() {
      const rows = db.prepare(`select status, priority, needs_reply, category, count(*) n from desk_threads group by status, priority, needs_reply, category`).all();
      return {
        total: db.prepare(`select count(*) n from desk_threads`).get().n,
        open: rows.filter((r) => r.status === "open").reduce((a, r) => a + r.n, 0),
        needsReply: rows.filter((r) => r.needs_reply === 1).reduce((a, r) => a + r.n, 0),
        byPriority: rows.filter((r) => r.needs_reply === 1).reduce((acc, r) => { acc[r.priority] = (acc[r.priority] || 0) + r.n; return acc; }, {}),
        byCategory: rows.reduce((acc, r) => { acc[r.category] = (acc[r.category] || 0) + r.n; return acc; }, {}),
      };
    },
    // briefs
    briefs(limit = 12) { return db.prepare(`select * from desk_briefs order by id desc limit ?`).all(limit); },
    brief(idv) { return db.prepare(`select * from desk_briefs where id=?`).get(idv); },
    insertBrief(b) {
      const r = insertBrief.run(String(b.brief_md || ""), String(b.pulse || "").slice(0, 1000) || null,
        Number(b.message_count || 0), Number(b.direct_count || 0), Number(b.group_count || 0), b.model || null, b.made_by || "fallback", now());
      return db.prepare(`select * from desk_briefs where id=?`).get(r.lastInsertRowid);
    },
    // usage
    async monthUsage() {
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const row = db.prepare(`select coalesce(sum(usd),0) m from usage where created_at >= ?`).get(start.toISOString());
      return Number(row.m);
    },
    async logUsage(e) {
      db.prepare(`insert into usage (kind, model, route, input_tokens, output_tokens, audio_seconds, usd, created_at) values (?,?,?,?,?,?,?,?)`)
        .run(e.kind, e.model, e.route || null, Number(e.inputTokens || 0), Number(e.outputTokens || 0), Number(e.audioSeconds || 0), Number(e.usd || 0), now());
      return true;
    },
    usageSummary(limit = 50) { return db.prepare(`select * from usage order by id desc limit ?`).all(limit); },
    // activity
    activity(kind, summary, detail = {}) {
      insertActivity.run(kind, String(summary).slice(0, 400), JSON.stringify(detail), now());
    },
  };
}