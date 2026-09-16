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

  it("legacy-9: word boundaries do not throw away inflected keywords", () => {
    // The boundary matcher that fixed "unlink" also stopped every plural and
    // gerund from routing: /api/nl answers a null action with the generic help
    // text, so these console command-bar phrases silently stopped working.
    assert.equal(parseCommand("reports").action, "dashboard");
    assert.equal(parseCommand("show me the reports").action, "dashboard");
    assert.equal(parseCommand("run the draws").action, "draw");
    assert.equal(parseCommand("reviewing the queue").action, "review");
    assert.equal(parseCommand("linking my phone").action, "link");
    // …and the suffix is outside the keyword, so the boundary fix still holds
    assert.equal(parseCommand("unlinking my phone").action, "unlink");
    assert.equal(parseCommand("unlink my phone").action, "unlink");
  });
});

describe("conversation fixes", () => {
  let h; before(async () => { h = await buildApp({ extractor: "simulator" }); }); after(async () => { await h.close(); });
  const P_LIST = "263772100001", P_WITHDRAWN = "263772100002", P_QUEUE = "263772100003", P_CLAIMED = "263772100004",
    P_IMAGE = "263772100005", P_CONC = "263772100006", P_UPDATE = "263772100007", P_STOP = "263772100008",
    P_WINNER = "263772100009", P_NEWLINE = "263772100010", P_CONFIRM = "263772100011",
    P_QUEUE2 = "263772100012", P_QUEUE3 = "263772100013", P_REGCLAIM = "263772100014",
    P_HOLD = "263772100015", P_STAGE = "263772100016", P_ERR = "263772100017";

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
    assert.ok(alert, "the first requester raises the handoff alert");

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

  it("conversation-5: a second and third requester are not swallowed by the hourly kind-dedup", async () => {
    // domain.alert() de-duplicates on `kind` alone for an hour and returns the
    // FIRST alert's id without touching its message, so putting the queue size
    // into the support.handoff message reported "1 waiting" for ever however
    // many people were locked out. The backlog must therefore raise its own
    // alert row.
    const before = h.db.prepare(`select count(*) n from alerts where kind='support.handoff'`).get().n;
    await h.register(P_QUEUE2, { first: "Quetwo", last: "Ncube", identity: "TESTQUE21" });
    await h.register(P_QUEUE3, { first: "Quethree", last: "Ncube", identity: "TESTQUE31" });
    await h.say(P_QUEUE2, "support");
    await h.say(P_QUEUE3, "support");
    const waiting = h.db.prepare(`select count(*) n from conversation_sessions where campaign_id=? and handoff_owner='queue'`).get(h.campaign.id).n;
    assert.equal(waiting, 2, "two conversations are parked in the queue");
    assert.equal(h.db.prepare(`select count(*) n from alerts where kind='support.handoff'`).get().n, before,
      "the per-requester alert really is swallowed by the hourly kind-dedup — which is why the depth cannot live in its message");
    const depth = h.db.prepare(`select message, severity, detail_json from alerts where kind='support.queue_depth_2' order by created_at desc limit 1`).get();
    assert.ok(depth, "a distinct alert reports the backlog the dedup would otherwise hide");
    assert.match(depth.message, /^2 support conversations are waiting for an operator/, "it states the depth actually reached, not 1");
    assert.equal(JSON.parse(depth.detail_json).waiting, 2);
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

    // …and after a round-trip through the menu, which is exactly what someone
    // who greets the bot, taps MENU or presses BACK between two purchases does.
    // home() used to rewrite the context as { lastReceiptId } only, dropping
    // the lastOutletId homeImage() depends on, so the very next photo fell back
    // to "first tell us where you shopped".
    await h.say(P_IMAGE, "menu");
    assert.ok(JSON.parse(h.domain.getSession(h.campaign.id, P_IMAGE).context_json).lastOutletId, "the remembered outlet survives MENU");
    const third = await h.say(P_IMAGE, "", { image: await h.simImage(h.simReceipt({ no: "990004" })) });
    assert.match(third.replies[0], /received your receipt/i, "a photo after a MENU round-trip is still submitted");
    await h.app.intake.drain(); await h.app.worker.tick();
    assert.equal(h.db.prepare(`select count(*) n from receipts where participant_id=?`).get(pid).n, 3, "the third photo created a receipt too");
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
    // withdrawParticipant closes EVERY consent and enrolment for the number and
    // sets the profile to 'withdrawn' globally, so the consent record the
    // participant reads must not claim only one promotion ended.
    assert.ok(!r.replies[0].includes(h.campaign.name), `opt-out copy must not scope the withdrawal to one campaign: ${r.replies[0]}`);
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

    // An 8-character all-hex reply is NOT a claim reference: the reference is
    // always quoted (and sent) hyphenated. Reading any 8 hex characters as one
    // answered a receipt/till number with the main menu instead of "Sorry, I
    // didn't understand that", and wrote a winner.claim_rejected audit row
    // against an open winner for every such typo.
    const rejectedBefore = h.db.prepare(`select count(*) n from audit_events where target_id='win_claimtest' and action='winner.claim_rejected'`).get().n;
    const digits = await h.say(P_WINNER, "12345678");
    assert.match(digits.replies[0], /didn't understand that/i, "an 8-digit reply is ordinary unrecognised input");
    assert.equal(h.db.prepare(`select count(*) n from audit_events where target_id='win_claimtest' and action='winner.claim_rejected'`).get().n, rejectedBefore,
      "a receipt/till number must not be audited as a rejected claim");
  });

  it("conversation-5(claim): the bare word CLAIM is only consumed at HOME/SUPPORT, never mid-registration", async () => {
    // `!claimRef` made the bare word a global intent, so a first-time
    // registrant at REG_FIRST who typed it got "We could not match a prize
    // claim…" and was left at REG_FIRST with no re-prompt at all.
    await h.say(P_REGCLAIM, "hi");
    await h.say(P_REGCLAIM, "1");
    const mid = await h.say(P_REGCLAIM, "claim");
    assert.doesNotMatch(mid.replies[0], /could not match a prize claim/i, "the registration step is not hijacked");
    assert.equal(mid.result.state, "REG_SURNAME", "the answer is taken as the name and registration moves on");
    // …and the same inside an outlet search
    await h.say(P_LIST, "menu");
    await h.say(P_LIST, "2");
    const search = await h.say(P_LIST, "claim");
    assert.doesNotMatch(search.replies[0], /could not match a prize claim/i);
    assert.match(search.replies[0], /No branch matched/i, "it is searched for like any other word");
    await h.say(P_LIST, "menu");
  });

  it("conversation-3(status): a suspended participant is not told they asked to be removed", async () => {
    await h.register(P_HOLD, { first: "Hold", last: "Ncube", identity: "TESTHLD11" });
    h.db.prepare(`update participants set status='suspended' where id=?`).run(h.domain.getParticipantByPhone(P_HOLD).id);
    const r = await h.say(P_HOLD, "2");
    assert.doesNotMatch(r.replies[0], /at your request/i, "staff suspension is not a participant withdrawal");
    assert.match(r.replies[0], /on hold/i);
    assert.match(r.replies[0], /reply SUPPORT/i);
    assert.equal(r.eventStatus, "processed");
    // a genuinely withdrawn profile still gets the withdrawal wording
    assert.match((await h.say(P_WITHDRAWN, "2")).replies[0], /at your request/i);
  });

  it("requirements-5: identity_stage=\"winner\" gives a 3-option confirmation whose \"3\" edits the town", async () => {
    const v = h.domain.getActiveVersion(h.campaign.id);
    const flags = JSON.parse(v.flags_json || "{}");
    h.db.prepare(`update campaign_versions set flags_json=? where id=?`).run(JSON.stringify({ ...flags, registration: { identity_stage: "winner" } }), v.id);
    try {
      await h.say(P_STAGE, "hi");
      await h.say(P_STAGE, "1");
      await h.say(P_STAGE, "Rudo");
      const afterSurname = await h.say(P_STAGE, "Chataika");
      assert.equal(afterSurname.result.state, "REG_LOCATION", "the ID is not asked for at registration");
      const confirm = await h.say(P_STAGE, "Gweru");
      assert.equal(confirm.result.state, "REG_CONFIRM");
      assert.match(confirm.replies[0], /3 town/, "the confirmation offers the options it can actually honour");
      assert.doesNotMatch(confirm.replies[0], /3 ID/, "the dead \"3 ID\" option is gone");
      const edit = await h.say(P_STAGE, "3");
      assert.equal(edit.result.state, "REG_LOCATION", "\"3\" edits the town instead of redisplaying the same screen");
      assert.match(edit.replies[0], /town or city/i);
    } finally {
      h.db.prepare(`update campaign_versions set flags_json=? where id=?`).run(JSON.stringify(flags), v.id);
    }
  });

  it("conversation-3(generic): a domain error is answered and the event settled; a CONFLICT still replays", async () => {
    await h.register(P_ERR, { first: "Erro", last: "Ncube", identity: "TESTERR11" });
    const real = h.domain.versionRules;
    try {
      // mechanics() ("3") is the only conversation path through versionRules.
      h.domain.versionRules = () => { throw new Error("boom"); };
      const r = await h.say(P_ERR, "3");
      assert.ok(r.replies.length > 0, "the participant is told something rather than getting silence");
      assert.match(r.replies[0], /something went wrong/i);
      assert.equal(r.eventStatus, "processed", "the event is settled, not left to dead-letter");

      // A genuinely retryable failure must still escape so intake replays it.
      h.domain.versionRules = () => { throw Object.assign(new Error("busy"), { code: "CONFLICT" }); };
      const c = await h.say(P_ERR, "3");
      assert.equal(c.replies.length, 0, "no false outcome is sent for a retryable failure");
      assert.equal(c.eventStatus, "failed", "the event stays queued for replay");
    } finally { h.domain.versionRules = real; }
  });

  it("parseIntent: CLAIM and STOP are recognised, numbers still ride along", () => {
    assert.equal(parseIntent("CLAIM").intent, "CLAIM");
    assert.equal(parseIntent("7F2F-6807").claimRef, "7F2F-6807");
    // The notification always quotes the reference hyphenated, but a winner who
    // retypes it without the hyphen must still be able to claim — winner-service
    // normalises exactly that form. What must NOT be read as a claim is an
    // all-digit reply: a receipt number, a date or a till number. Requiring a
    // hex LETTER separates the two, which is why this test asserts the letter
    // rule rather than rejecting every unhyphenated reference: doing that turned
    // real winners away (about 98% of references carry a letter; the rest have
    // to be typed with the hyphen).
    assert.equal(parseIntent("12345678").intent, null, "an 8-digit reply is not a claim reference");
    assert.equal(parseIntent("78B1BE72").claimRef, "78B1-BE72", "a winner who drops the hyphen must still claim");
    assert.equal(parseIntent("deadbeef").claimRef, "DEAD-BEEF");
    assert.equal(parseIntent("stop").intent, "OPTOUT");
    assert.equal(parseIntent("cancel").intent, "CANCEL");
    assert.equal(parseIntent("8").number, 8);
    assert.equal(parseIntent("westgate").intent, null, "an ordinary search term is never a claim reference");
  });
});
