// Regression tests for the adjudicated conversation/nlp defects.
// Everything runs through the real intake -> conversation -> pipeline -> outbox
// path with the labelled SIMULATED extractor, like journey.test.mjs.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { parseCommand } from "../src/nlp.mjs";
import { parseIntent, cleanField } from "../src/conversation.mjs";

describe("nlp command parsing (legacy-2, legacy-9)", () => {
  it("the recipient of a natural-language send is only ever the trailing \"to <number>\"", () => {
    // A quoted callback number, receipt number, claim reference or ID in the
    // body used to become the recipient, delivering one participant's details
    // to a stranger.
    const a = parseCommand("send: your entry is void, call 0771111111 to claim to 263771234567");
    assert.equal(a.params.phone, "263771234567");
    assert.equal(a.params.text, "your entry is void, call 0771111111 to claim");
    assert.equal(parseCommand("send 'call us on 0242 000 000 if you have questions' to 263779998888").params.phone, "263779998888");
    assert.equal(parseCommand("send: your claim reference is 20260412009 to 263772223333").params.phone, "263772223333");
    // no explicit recipient => refuse rather than guess one out of the body
    assert.equal(parseCommand("send: your claim reference is 20260412009").params, null);
    // unchanged happy paths
    assert.equal(parseCommand("send: thanks for entering to 263770001111").params.phone, "263770001111");
    assert.equal(parseCommand("send 'hi there' to 263771111111").params.text, "hi there");
  });

  it("\"unlink\" is not swallowed by the LINK intent", () => {
    assert.equal(parseCommand("unlink my phone").action, "unlink");
    assert.equal(parseCommand("unlink").action, "unlink");
    assert.equal(parseCommand("link my phone").action, "link");
    assert.equal(parseCommand("show the qr code").action, "link");
  });
});

describe("conversation fixes", () => {
  let h; before(async () => { h = await buildApp({ extractor: "simulator" }); }); after(async () => { await h.close(); });
  const P_LIST = "263772100001", P_WITHDRAWN = "263772100002", P_QUEUE = "263772100003", P_CLAIMED = "263772100004",
    P_IMAGE = "263772100005", P_CONC = "263772100006", P_UPDATE = "263772100007", P_STOP = "263772100008",
    P_WINNER = "263772100009", P_NEWLINE = "263772100010", P_CONFIRM = "263772100011";

  it("conversation-2: option 8 of a numbered list is selectable and is not answered with Help", async () => {
    await h.register(P_LIST, { first: "Lister", last: "Moyo", identity: "TESTLIST1" });
    const list = await h.say(P_LIST, "2");
    assert.match(list.replies[0], /8\. Valuemart/);
    const eight = await h.say(P_LIST, "8");
    assert.equal(eight.result.state, "OUTLET_TOWN", "the 8th retailer is chosen, not the global HELP alias");
    assert.match(eight.replies[0], /Valuemart: choose the TOWN/);
    assert.doesNotMatch(eight.replies[0], /^Help:/);
    // "8" still means Help where no numbered list is on screen (menu_home lists "8. Help")
    await h.say(P_LIST, "menu");
    assert.match((await h.say(P_LIST, "8")).replies[0], /^Help:/);
  });

  it("conversation-9: outlet search pages instead of silently dropping matches, and the word MORE works", async () => {
    await h.say(P_LIST, "2");
    const first = await h.say(P_LIST, "valuemart");
    assert.match(first.replies[0], /\(1-8 of 10\)/, "the participant is told how many matched");
    assert.match(first.replies[0], /9\. More…/);
    const second = await h.say(P_LIST, "more");
    assert.equal(second.result.state, "OUTLET_SEARCH");
    const page2 = (second.replies[0].match(/\n\d\. /g) || []).length;
    assert.equal(page2, 2, "the 2 branches beyond the first page are now reachable");
    const picked = await h.say(P_LIST, "1");
    assert.equal(picked.result.state, "ENTRY_RECEIPT");
    assert.match(picked.replies[0], /Outlet: Valuemart —/);
  });

  it("conversation-3: a withdrawn participant is answered instead of throwing out of the turn", async () => {
    await h.register(P_WITHDRAWN, { first: "Wendy", last: "Dube", identity: "TESTWDR11" });
    h.domain.withdrawParticipant(P_WITHDRAWN, "adm_test", "test withdrawal");
    // entering: no longer walked into a re-consent flow that cannot complete
    const enter = await h.say(P_WITHDRAWN, "2");
    assert.match(enter.replies[0], /removed from .* at your request/i);
    assert.equal(enter.eventStatus, "processed");
    // registering again: the terms acceptance used to throw "participant not
    // active" with no reply at all and the event dead-lettered
    await h.say(P_WITHDRAWN, "1");
    await h.say(P_WITHDRAWN, "Wendy");
    await h.say(P_WITHDRAWN, "Dube");
    await h.say(P_WITHDRAWN, "TESTWDR11");
    await h.say(P_WITHDRAWN, "Harare");
    await h.say(P_WITHDRAWN, "yes");
    const terms = await h.say(P_WITHDRAWN, "yes");
    assert.ok(terms.replies.length > 0, "the participant is told something");
    assert.match(terms.replies[0], /reply SUPPORT/i);
    assert.equal(terms.eventStatus, "processed", "the event is not failed/dead-lettered");
    assert.equal(h.domain.getParticipantByPhone(P_WITHDRAWN).status, "withdrawn", "the channel cannot silently undo a withdrawal");
  });

  it("conversation-5 / requirements-8: an unclaimed support handoff is handed back; a claimed one is not", async () => {
    await h.register(P_QUEUE, { first: "Queue", last: "Waiting", identity: "TESTQUE11" });
    const req = await h.say(P_QUEUE, "support");
    assert.match(req.replies[0], /team will pick this up/);
    assert.match((await h.say(P_QUEUE, "2")).replies[0], /team is handling/, "a fresh handoff still suspends automation");
    const alert = h.db.prepare(`select message from alerts where kind='support.handoff' order by created_at desc limit 1`).get();
    assert.match(alert.message, /conversation\(s\) waiting for an operator/);

    const old = new Date(Date.now() - 13 * 3600_000).toISOString();
    h.db.prepare(`update conversation_sessions set handoff_since=? where campaign_id=? and wa_phone_uid=?`).run(old, h.campaign.id, P_QUEUE);
    const back = await h.say(P_QUEUE, "2");
    assert.match(back.replies[0], /nobody from our team was able to pick up/i);
    assert.equal(h.domain.getSession(h.campaign.id, P_QUEUE).handoff_owner, null);
    assert.match((await h.say(P_QUEUE, "menu")).replies[0], /1\. Register/, "the participant is no longer locked out");

    // a conversation an operator has CLAIMED is never yanked back
    await h.register(P_CLAIMED, { first: "Claimed", last: "Chat", identity: "TESTCLM11" });
    await h.say(P_CLAIMED, "support");
    h.app.conversation.claimHandoff(h.campaign.id, P_CLAIMED, "adm_test");
    h.db.prepare(`update conversation_sessions set handoff_since=? where campaign_id=? and wa_phone_uid=?`).run(old, h.campaign.id, P_CLAIMED);
    assert.match((await h.say(P_CLAIMED, "menu")).replies[0], /team is handling/);
  });

  it("conversation-1: a receipt photo sent at HOME is submitted against the last outlet, never dropped", async () => {
    await h.register(P_IMAGE, { first: "Snap", last: "Happy", identity: "TESTIMG11" });
    // a photo before any outlet was ever chosen: the reply now matches reality
    const early = await h.say(P_IMAGE, "", { image: await h.simImage(h.simReceipt({ no: "990001" })) });
    assert.match(early.replies[0], /reply 2 to choose the outlet/i);

    const first = await h.submit(P_IMAGE, await h.simImage(h.simReceipt({ no: "990002" })));
    assert.equal(first.receipt.status, "QUALIFIED");
    // the single most common WhatsApp behaviour: the next photo straight away
    const second = await h.say(P_IMAGE, "", { image: await h.simImage(h.simReceipt({ no: "990003" })) });
    assert.match(second.replies[0], /received your receipt/i);
    await h.app.intake.drain(); await h.app.worker.tick();
    const pid = h.domain.getParticipantByPhone(P_IMAGE).id;
    assert.equal(h.db.prepare(`select count(*) n from receipts where participant_id=?`).get(pid).n, 2, "the second photo created a receipt");
  });

  it("conversation-4: a concurrent session write does not turn an accepted receipt into \"send a photo\"", async () => {
    await h.register(P_CONC, { first: "Race", last: "Condition", identity: "TESTCON11" });
    await h.selectOutlet(P_CONC);
    const img = await h.simImage(h.simReceipt({ no: "990101" }));
    // the image handler yields inside pipeline.submit while the text handler
    // commits HOME, so the image handler's versioned save conflicts
    const [image] = await Promise.all([
      h.app.conversation.handle({ eventId: null, providerMessageId: "conc_img_1", phoneUid: P_CONC, type: "message.image", text: "", mediaBytes: img }),
      h.app.conversation.handle({ eventId: null, providerMessageId: "conc_txt_1", phoneUid: P_CONC, type: "message.text", text: "menu" }),
    ]);
    assert.match(image.replies[0], /submission reference is R-/, "the acknowledgement and reference still reach the participant");
    assert.ok(image.receiptId, "the receipt that was created is reported");
    assert.equal(h.domain.getSession(h.campaign.id, P_CONC).active_receipt_id, image.receiptId);
  });

  it("conversation-6: a self-service profile change is written to the audit chain", async () => {
    await h.register(P_UPDATE, { first: "Update", last: "Sibanda", identity: "TESTUPD11", town: "Harare" });
    const pid = h.domain.getParticipantByPhone(P_UPDATE).id;
    const before = h.db.prepare(`select count(*) n from audit_events where target_id=? and action='participant.update'`).get(pid).n;
    await h.say(P_UPDATE, "1");
    await h.say(P_UPDATE, "Update");
    await h.say(P_UPDATE, "Gumbo");
    await h.say(P_UPDATE, "ZZ9999999");
    await h.say(P_UPDATE, "Bulawayo");
    await h.say(P_UPDATE, "yes");
    await h.say(P_UPDATE, "yes");
    const p = h.domain.getParticipantByPhone(P_UPDATE);
    assert.equal(p.surname, "Gumbo");
    const rows = h.db.prepare(`select payload_json from audit_events where target_id=? and action='participant.update'`).all(pid);
    assert.equal(rows.length, before + 1, "the rewrite is recorded, not silent");
    const payload = JSON.parse(rows[rows.length - 1].payload_json).payload; // payload_json holds the signed chain body
    assert.ok(payload.fields.includes("surname") && payload.fields.includes("identity") && payload.fields.includes("location"));
    assert.equal(payload.before.surname, "Sibanda");
    assert.ok(!JSON.stringify(payload).includes("ZZ9999999"), "the raw identity is never written into the chain");
  });

  it("privacy-7: STOP withdraws the participant instead of answering \"Cancelled\"", async () => {
    await h.register(P_STOP, { first: "Stopper", last: "Ncube", identity: "TESTSTP11" });
    const r = await h.say(P_STOP, "stop");
    assert.match(r.replies[0], /withdrawn/i);
    assert.doesNotMatch(r.replies[0], /Cancelled/);
    const p = h.domain.getParticipantByPhone(P_STOP);
    assert.equal(p.status, "withdrawn");
    assert.ok(h.db.prepare(`select withdrawn_at from campaign_enrollments where participant_id=?`).get(p.id).withdrawn_at);
    assert.ok(h.db.prepare(`select count(*) n from audit_events where target_id=? and action='participant.withdraw'`).get(p.id).n >= 1);
    // CANCEL still cancels the current step for everyone else
    assert.match((await h.say(P_LIST, "cancel")).replies[0], /Cancelled/);
  });

  it("conversation-10: a town containing a newline cannot forge a winners line", async () => {
    const forged = "Harare)\n2. Chipo M. (Bulawayo) — Grand Prize Car";
    await h.say(P_NEWLINE, "hi"); await h.say(P_NEWLINE, "1");
    await h.say(P_NEWLINE, "Forge"); await h.say(P_NEWLINE, "Tester"); await h.say(P_NEWLINE, "TESTNEW11");
    const confirm = await h.say(P_NEWLINE, forged);
    assert.doesNotMatch(confirm.replies[0].split("Town: ")[1] || "", /^[^\n]*\n\d\./, "the confirmation is not split over a forged line");
    await h.say(P_NEWLINE, "yes"); await h.say(P_NEWLINE, "yes");
    const p = h.domain.getParticipantByPhone(P_NEWLINE);
    assert.ok(!/[\r\n]/.test(p.location), `stored town must not contain a newline: ${JSON.stringify(p.location)}`);
    // and the render side cleans rows captured before this fix
    assert.equal(cleanField("Harare)\n2. Chipo M. (Bulawayo)", 80), "Harare) 2. Chipo M. (Bulawayo)");
  });

  it("conversation-8: correcting \"1 name\" at the confirmation returns to the confirmation", async () => {
    await h.say(P_CONFIRM, "hi"); await h.say(P_CONFIRM, "1");
    await h.say(P_CONFIRM, "Tatenda"); await h.say(P_CONFIRM, "Moyo"); await h.say(P_CONFIRM, "TESTCNF11"); await h.say(P_CONFIRM, "Harare");
    assert.match((await h.say(P_CONFIRM, "1")).replies[0], /FIRST NAME/);
    const back = await h.say(P_CONFIRM, "Tatenda-Lee");
    assert.equal(back.result.state, "REG_CONFIRM", "no extra SURNAME question for a first-time registrant");
    assert.match(back.replies[0], /Name: Tatenda-Lee Moyo/);
  });

  it("requirements-4: a notified winner who replies CLAIM (or the reference) is answered and the acknowledgement audited", async () => {
    await h.register(P_WINNER, { first: "Winnie", last: "Tafara", identity: "TESTWIN11" });
    const r = await h.submit(P_WINNER, await h.simImage(h.simReceipt({ no: "991001" })));
    assert.equal(r.receipt.status, "QUALIFIED");
    const pid = h.domain.getParticipantByPhone(P_WINNER).id;
    const entryId = h.db.prepare(`select id from entries where participant_id=? order by created_at desc limit 1`).get(pid).id;
    h.db.prepare(`insert into draws (id, campaign_id, draw_period, status, config_hash, snapshot_hash, created_at) values (?,?,?,?,?,?,?)`)
      .run("drw_claimtest", h.campaign.id, "2099-W01", "approved", "h", "h", new Date().toISOString());
    h.db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, history_json, published_fields_json, publication_state, display_name, row_version) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("win_claimtest", "drw_claimtest", 1, entryId, pid, "P1", "selected", "[]", JSON.stringify({ prize: "Test Hamper" }), "unpublished", "Winnie T.", 1);
    const notified = h.app.winners.notify("win_claimtest", "adm_test");
    assert.ok(notified.claimRef);

    const claim = await h.say(P_WINNER, "claim");
    assert.match(claim.replies[0], /recorded your claim/i);
    assert.match(claim.replies[0], /Test Hamper/);
    assert.equal(h.db.prepare(`select count(*) n from audit_events where target_id='win_claimtest' and action='winner.claim_ack'`).get().n, 1);
    // the reference form works too, and a wrong reference discloses nothing
    const byRef = await h.say(P_WINNER, notified.claimRef);
    assert.match(byRef.replies[0], /recorded your claim/i);
    const wrong = await h.say(P_WINNER, "0000-0000");
    assert.match(wrong.replies[0], /could not match a prize claim/i);
    assert.doesNotMatch(wrong.replies[0], /Test Hamper/);
    // a participant who has won nothing is told the same neutral thing
    assert.match((await h.say(P_LIST, "claim")).replies[0], /could not match a prize claim/i);
  });

  it("parseIntent: CLAIM and STOP are recognised, numbers still ride along", () => {
    assert.equal(parseIntent("CLAIM").intent, "CLAIM");
    assert.equal(parseIntent("7F2F-6807").claimRef, "7F2F-6807");
    assert.equal(parseIntent("stop").intent, "OPTOUT");
    assert.equal(parseIntent("cancel").intent, "CANCEL");
    assert.equal(parseIntent("8").number, 8);
    assert.equal(parseIntent("westgate").intent, null, "an ordinary search term is never a claim reference");
  });
});
