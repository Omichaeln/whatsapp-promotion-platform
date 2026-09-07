import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, HELP_TEXT } from "../src/nlp.mjs";

describe("natural-language commands (nlp.mjs)", () => {
  it("parses dashboard/status/review/entries intents", () => {
    assert.equal(parseCommand("show the dashboard").action, "dashboard");
    assert.equal(parseCommand("how are we doing").action, "dashboard");
    assert.equal(parseCommand("status").action, "status");
    assert.equal(parseCommand("anything needing review").action, "review");
    assert.equal(parseCommand("list entries").action, "entries");
    assert.equal(parseCommand("show participants").action, "participants");
    assert.equal(parseCommand("who won").action, "winners");
  });

  it("extracts a draw period from plain English", () => {
    const d = parseCommand("run the draw for 2026-W40");
    assert.equal(d.action, "draw");
    assert.equal(d.params.period, "2026-W40");
  });

  it("parses send with a phone and message body", () => {
    const s = parseCommand("send: thanks for entering to 263770001111");
    assert.equal(s.action, "send");
    assert.equal(s.params.phone, "770001111");
    assert.equal(s.params.text, "thanks for entering");
    const s2 = parseCommand("send 'hi there' to 263771111111");
    assert.equal(s2.params.text, "hi there");
  });

  it("classify and help", () => {
    assert.equal(parseCommand("classify this: customer asking price").action, "classify");
    assert.equal(parseCommand("help").action, "help");
    assert.ok(HELP_TEXT.includes("review"));
  });
});