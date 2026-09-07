import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate } from "../src/db.mjs";
import { createDeskStore } from "../src/desk.mjs";
import { createAi } from "../src/ai.mjs";

function ctx() {
  const db = openDb(":memory:");
  migrate(db, undefined, () => {});
  const desk = createDeskStore(db);
  const ai = createAi({ cfg: { ai: { openaiKey: "", openaiModel: "gpt-4o-mini" } }, store: desk, usage: null });
  return { db, desk, ai };
}

describe("desk workflow (restored)", () => {
  it("files messages, triages them, writes threads + brief, marks processed", async () => {
    const { db, desk, ai } = ctx();
    const now = new Date().toISOString();
    desk.upsertMessage({ message_sid: "a", chat_id: "c1", chat_name: "Tapiwa", sender_name: "Tapiwa", message_text: "Hi, how do I enter the promo?", timestamp: now });
    desk.upsertMessage({ message_sid: "b", chat_id: "c1", chat_name: "Tapiwa", sender_name: "Tapiwa", message_text: "Please help, my receipt failed", timestamp: now });
    desk.upsertMessage({ message_sid: "c", chat_id: "g1", chat_type: "group", chat_name: "Store Team", sender_name: "Blessing", message_text: "Daily figures: 14 packs sold", timestamp: now });

    const rows = desk.unprocessed({ cutoffIso: new Date(Date.now() - 86400_000).toISOString(), limit: 800 });
    assert.equal(rows.length, 3);
    const result = await ai.summarise(rows);
    assert.equal(result.chats.length, 2, "two unique chats");
    assert.ok(result.pulse.length > 0);
    assert.ok(result.brief_md.includes("Tapiwa"));

    // a chat asking a question gets needs_reply + a draft
    const tapiwa = result.chats.find((c) => c.chat_name === "Tapiwa");
    assert.equal(tapiwa.needs_reply, true);
    assert.ok(tapiwa.draft.length > 0);
    const team = result.chats.find((c) => c.chat_name === "Store Team");
    assert.equal(team.routine_report, true);

    // persist threads + brief
    for (const c of result.chats) desk.upsertThread({ chat_id: c.chat_id, chat_type: c.chat_type, chat_name: c.chat_name, category: c.category, priority: c.priority, needs_reply: c.needs_reply, confidence: c.confidence, summary: c.summary, draft: c.draft, status: c.routine_report && !c.needs_reply ? "filed" : "open", last_message_at: rows.find((r) => r.chat_id === c.chat_id).timestamp, updated_at: now });
    desk.insertBrief({ brief_md: result.brief_md, pulse: result.pulse, message_count: rows.length, direct_count: 2, group_count: 1, model: "fallback", made_by: "fallback" });

    const stats = desk.threadStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.open, 1, "customer thread is open");
    assert.equal(stats.byCategory.Customers, 1);
    assert.ok(stats.needsReply >= 1);
    assert.equal(desk.briefs().length, 1);
    assert.equal(desk.countMessages(), 3);

    // mark handled
    desk.upsertThread({ chat_id: tapiwa.chat_id, chat_type: "direct", chat_name: "Tapiwa", category: tapiwa.category, priority: tapiwa.priority, needs_reply: false, confidence: 3, summary: tapiwa.summary, draft: tapiwa.draft, status: "handled", last_message_at: now, updated_at: now });
    assert.equal(desk.threads({ status: "handled" }).length, 1);
  });

  it("usage metering records trailing costs", async () => {
    const { db } = ctx();
    const desk = createDeskStore(db);
    await desk.logUsage({ kind: "triage", model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 500, usd: 0.00045 });
    const m = await desk.monthUsage();
    assert.ok(m > 0);
    assert.equal(desk.usageSummary().length, 1);
  });
});