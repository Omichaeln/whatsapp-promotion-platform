import { buildApp, describe, it, before, after, assert } from "./helpers.mjs";
import { createAi } from "../src/ai.mjs";
import { LinkedDeviceTransport } from "../src/transport/linked-device.mjs";

/**
 * Fixes for the "legacy" desk surface: /api/nl authorization + error typing,
 * the desk store's where-clause guard, numeric query parameters, and the
 * linked-device transport's inbound text / media paths.
 */
describe("legacy desk fixes", () => {
  let h, auditor, reviewer, support;
  before(async () => {
    h = await buildApp();
    auditor = await h.staffToken("auditor@example.test");
    reviewer = await h.staffToken("reviewer@example.test");
    support = await h.staffToken("support@example.test");
  });
  after(async () => { await h.close(); });

  const deskMessage = (sid, text) => h.db.prepare(
    `insert into desk_messages (message_sid, chat_type, chat_id, chat_name, sender_name, message_text, processed, timestamp) values (?,?,?,?,?,?,0,?)`,
  ).run(sid, "direct", "263771234567@s.whatsapp.net", "Tendai", "Tendai", text, new Date().toISOString());
  const unprocessed = () => h.db.prepare(`select count(*) n from desk_messages where processed=0`).get().n;

  it("refuses the support-only NL branches with 403 and does not touch the desk queue", async () => {
    deskMessage("m1", "Hi, can you help me enter?");
    deskMessage("m2", "My receipt failed, please help");
    const before = unprocessed();
    assert.equal(before, 2);

    for (const text of ["brief me", "draft a reply about prizes", "classify this: my receipt failed"]) {
      const r = await h.api("/api/nl", { method: "POST", body: { text }, token: auditor });
      assert.equal(r.status, 403, `${text} -> ${JSON.stringify(r.data)}`);
      assert.equal(r.data?.error?.code, "FORBIDDEN");
    }
    // the brief marks every message it consumes processed; a refused brief must not
    assert.equal(unprocessed(), before, "an auditor's refused brief drained the support queue");

    // support still gets the real thing
    const ok = await h.api("/api/nl", { method: "POST", body: { text: "brief me" }, token: support });
    assert.equal(ok.status, 200);
    assert.equal(unprocessed(), 0, "support's brief should consume the queue");
  });

  it("answers an unauthorised NL command with 403 rather than 200 and an apology", async () => {
    const r = await h.api("/api/nl", { method: "POST", body: { text: "show participants" }, token: reviewer });
    assert.equal(r.status, 403);
    assert.equal(r.data?.error?.code, "FORBIDDEN");
    assert.equal(r.data?.reply, undefined, "a refusal must not be dressed up as a result");
  });

  it("leaves the branches that mirror roles:any routes open", async () => {
    for (const text of ["show the dashboard", "status", "list campaigns"]) {
      const r = await h.api("/api/nl", { method: "POST", body: { text }, token: auditor });
      assert.equal(r.status, 200, `${text} -> ${JSON.stringify(r.data)}`);
    }
  });

  it("GET /api/desk/messages returns the message list instead of 500", async () => {
    const r = await h.api("/api/desk/messages", { token: support });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(Array.isArray(r.data.messages));
    const limited = await h.api("/api/desk/messages?limit=1", { token: support });
    assert.equal(limited.status, 200);
    assert.ok(limited.data.messages.length <= 1);
  });

  it("treats a non-numeric limit as a 400, not a 500", async () => {
    const a = await h.api("/api/activity?limit=abc", { token: support });
    assert.equal(a.status, 400, JSON.stringify(a.data));
    assert.equal(a.data?.error?.code, "VALIDATION");
    const d = await h.api("/api/data?days=abc", { token: support });
    assert.equal(d.status, 400, JSON.stringify(d.data));
    // Seed past the cap first: with a fresh app there are far fewer than 200
    // activity rows, so this assertion held with or without a clamp.
    const at = new Date().toISOString();
    const insAct = h.db.prepare(`insert into activity_events (kind, summary, detail_json, created_at) values (?,?,?,?)`);
    for (let i = 0; i < 250; i += 1) insAct.run("probe", `clamp probe ${i}`, "{}", at);
    const capped = await h.api("/api/activity?limit=1000000", { token: support });
    assert.equal(capped.status, 200);
    assert.equal(capped.data.events.length, 200, "an absurd limit must be clamped to the maximum");
  });

  it("the NL review shortcut finds receipts in the real review disposition", async () => {
    const now = new Date().toISOString();
    h.db.prepare(`insert into participants (id, wa_phone_uid, first_name, surname, created_at, updated_at) values (?,?,?,?,?,?)`)
      .run("p_legacy", "263770000001", "Tendai", "Ncube", now, now);
    const version = h.db.prepare(`select id from campaign_versions where campaign_id=? order by version_no desc limit 1`).get(h.campaign.id);
    h.db.prepare(`insert into receipts (id, provider_message_id, participant_id, campaign_id, campaign_version_id, status, reason_code, created_at) values (?,?,?,?,?,?,?,?)`)
      .run("rcpt_legacy", "pm_legacy", "p_legacy", h.campaign.id, version.id, "REVIEW_REQUIRED", "uncertain", now);

    const r = await h.api("/api/nl", { method: "POST", body: { text: "anything needing review" }, token: reviewer });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.action, "review");
    assert.equal(r.data.data.receipts.length, 1, "the review queue must not read back empty");
    assert.equal(r.data.data.receipts[0].id, "rcpt_legacy");
  });

  it("attributes an NL send in the audit chain and keys it by message body", async () => {
    const count = () => h.db.prepare(`select count(*) n from audit_events where action='support.message'`).get().n;
    const before = count();
    const a = await h.api("/api/nl", { method: "POST", body: { text: "send: your entry is confirmed to 263771234567" }, token: support });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.ok(a.data.data?.queued, "the message should be queued");
    const b = await h.api("/api/nl", { method: "POST", body: { text: "send: sorry, that receipt was a duplicate to 263771234567" }, token: support });
    assert.equal(b.status, 200);

    assert.equal(count(), before + 2, "each NL send must write its own audit row");
    const actor = h.db.prepare(`select actor_id, actor_type from audit_events where action='support.message' order by rowid desc limit 1`).get();
    assert.equal(actor.actor_type, "admin");
    assert.ok(actor.actor_id, "the staff account must be recorded");
    assert.ok(h.db.prepare(`select count(*) n from activity_events where kind='send'`).get().n >= 2);

    // two different bodies must not collapse into one enqueue: the key has to
    // carry the body, not just the recipient and the current millisecond.
    const keys = h.db.prepare(`select idempotency_key k from outbound_messages where idempotency_key like 'nl:%' order by created_at`).all().map((r) => r.k);
    assert.equal(keys.length, 2);
    const withoutTimestamp = keys.map((k) => { const p = k.split(":"); p.splice(1, 1); return p.join(":"); });
    assert.notEqual(withoutTimestamp[0], withoutTimestamp[1], "the idempotency key ignores the message body");
  });

  it("rate limits the AI-spending NL commands per account", async () => {
    const app2 = await buildApp();
    try {
      const token = await app2.staffToken("support@example.test");
      let last = null;
      for (let i = 0; i < 14; i++) {
        last = await app2.api("/api/nl", { method: "POST", body: { text: `classify this: hello ${i}` }, token });
        if (last.status !== 200) break;
      }
      assert.equal(last.status, 429, "an unbounded loop of model calls should be refused");
      assert.equal(last.data?.error?.code, "RATE_LIMITED");
    } finally { await app2.close(); }
  });
});

describe("linked-device transport fixes", () => {
  const makeTransport = () => {
    const filed = [], activity = [], logs = [];
    const t = new LinkedDeviceTransport({
      authDir: "/tmp/does-not-exist-legacy-test",
      deskStore: { upsertMessage: (m) => { filed.push(m); return true; } },
      onActivity: (kind, summary, detail) => activity.push({ kind, summary, detail }),
      log: (m) => logs.push(m),
    });
    return { t, filed, activity, logs };
  };
  const textEnvelope = (jid = "263771234567@s.whatsapp.net") => ({
    key: { remoteJid: jid, id: "MSG1", fromMe: false },
    pushName: "Tendai",
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: "hi" },
  });
  const imageEnvelope = () => ({
    key: { remoteJid: "263771234567@s.whatsapp.net", id: "IMG1", fromMe: false },
    pushName: "Tendai",
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { imageMessage: { mimetype: "image/jpeg" } },
  });

  it("files an inbound text and hands it to the conversation", async () => {
    const { t, filed } = makeTransport();
    const seen = [];
    t.onTextMessage = (ev) => { seen.push(ev); };
    await t.fileMessage(textEnvelope(), {});
    assert.equal(filed.length, 1, "the message was never filed");
    assert.equal(filed[0].chat_name, "Tendai");
    assert.equal(seen.length, 1, "onTextMessage never fired, so registration is impossible");
    assert.equal(seen[0].phoneUid, "263771234567");
    assert.equal(seen[0].text, "hi");
  });

  it("resolves a group chat name from the socket", async () => {
    const { t, filed } = makeTransport();
    t.onTextMessage = () => {};
    const jid = "12345-67890@g.us";
    const m = textEnvelope(jid);
    m.key.participant = "263771234567@s.whatsapp.net";
    await t.fileMessage(m, { groupMetadata: async () => ({ subject: "Store Team" }) });
    assert.equal(filed[0].chat_name, "Store Team");
    assert.equal(filed[0].chat_type, "group");
  });

  it("downloads receipt image bytes with the real baileys API", async () => {
    const { t } = makeTransport();
    t.baileys = { downloadMediaMessage: async (msg, type) => { assert.equal(type, "buffer"); return Buffer.from("JPEGBYTES"); } };
    const images = [];
    t.onImageMessage = (ev) => { images.push(ev); };
    await t.fileMessage(imageEnvelope(), {});
    assert.equal(images.length, 1);
    assert.ok(images[0].inlineMediaB64, "the receipt reached the pipeline with no image bytes");
    assert.equal(Buffer.from(images[0].inlineMediaB64, "base64").toString(), "JPEGBYTES");
  });

  it("still prompts for a re-upload when the download fails, and says so", async () => {
    const { t, activity } = makeTransport();
    t.baileys = { downloadMediaMessage: async () => { throw new Error("boom"); } };
    const images = [];
    t.onImageMessage = (ev) => { images.push(ev); };
    await t.fileMessage(imageEnvelope(), {});
    assert.equal(images.length, 1, "the participant must still get the re-upload prompt");
    assert.equal(images[0].inlineMediaB64, null);
    assert.ok(activity.some((a) => a.kind === "error"), "a failed download must be visible to the operator");
    assert.equal(t.health().lastError, null, "a media failure is not a link failure");
    assert.ok(t.health().lastMediaError?.includes("media download failed"));
  });
});

describe("ai draft prompt bounds", () => {
  it("does not forward an unbounded caller-supplied instruction to the model", async () => {
    const original = globalThis.fetch;
    let sent = null;
    globalThis.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }; };
    try {
      const ai = createAi({ cfg: { ai: { openaiKey: "test-key", openaiModel: "gpt-4o-mini" } }, store: null, usage: null });
      await ai.draft({ context: "", instruction: "x".repeat(50_000), current: null });
      const userMsg = sent.messages.find((m) => m.role === "user");
      assert.ok(userMsg.content.length <= 2000, `instruction forwarded at ${userMsg.content.length} chars`);
    } finally { globalThis.fetch = original; }
  });
});
