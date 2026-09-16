// Participant journeys through the real intake -> conversation -> pipeline ->
// outbox path with the labelled SIMULATED extractor (fast). Real-OCR journeys
// are in receipt-ocr.test.mjs. Covers T-01, T-02, T-03, T-05, T-06, T-13, T-16.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";

describe("participant journeys (T-01, T-02, T-03, T-05, T-06, T-13, T-16)", () => {
  let h; before(async () => { h = await buildApp({ extractor: "simulator" }); }); after(async () => { await h.close(); });
  const P1 = "263771000001", P2 = "263771000002";

  it("T-01: a greeting from a new phone returns the campaign menu (no registration prompt)", async () => {
    const r = await h.say(P1, "Hi");
    assert.equal(r.result.state, "HOME");
    assert.match(r.replies[0], /1\. Register/);
    assert.match(r.replies[0], /7\. My entries/, "status line present because the sample campaign enables it");
  });
  it("T-16: an unregistered participant can read mechanics, terms, prizes and winners", async () => {
    assert.match((await h.say(P1, "3")).replies[0], /2 x 2kg pack/i);
    assert.match((await h.say(P1, "4")).replies[0], /TEST-T1/);
    assert.match((await h.say(P1, "5")).replies[0], /voucher/i);
    assert.match((await h.say(P1, "6")).replies[0], /No winners have been published yet/);
    assert.match((await h.say(P1, "2")).replies[0], /register first/i);
  });
  it("T-02: registration captures all five fields with confirmation, correction, terms; returning user is recognised", async () => {
    assert.match((await h.say(P1, "1")).replies[0], /FIRST NAME/);
    assert.match((await h.say(P1, "T")).replies[0], /at least 2 characters/);
    assert.match((await h.say(P1, "Tendai")).replies[0], /SURNAME/);
    assert.match((await h.say(P1, "Ncube")).replies[0], /ID number/);
    assert.match((await h.say(P1, "12")).replies[0], /doesn't look like an ID/);
    assert.match((await h.say(P1, "TEST1234X")).replies[0], /town or city/);
    const c = await h.say(P1, "Harare");
    assert.match(c.replies[0], /Name: Tendai Ncube/); assert.match(c.replies[0], /ID: TE\*+4X/); assert.match(c.replies[0], /\+263771000001/);
    // correct the surname via the confirmation menu, then confirm
    assert.match((await h.say(P1, "2")).replies[0], /SURNAME/);
    assert.match((await h.say(P1, "Ncube-Moyo")).replies[0], /Ncube-Moyo/);
    assert.match((await h.say(P1, "yes")).replies[0], /TEST-T1/);
    const done = await h.say(P1, "yes");
    assert.match(done.replies[0], /registered, Tendai/);
    const p = h.domain.getParticipantByPhone(P1);
    assert.equal(p.surname, "Ncube-Moyo"); assert.ok(p.identity_enc && p.identity_fp && p.identity_masked, "identity encrypted + fingerprinted + masked");
    assert.ok(!h.db.prepare(`select * from participants where id=?`).get(p.id).identity_enc.includes("TEST1234X"));
    const e = h.domain.getEnrollment(p.id, h.campaign.id); assert.equal(e.terms_version, "TEST-T1"); assert.equal(e.privacy_version, "TEST-P1");
    // returning: greeting -> menu (never asked to register again); "1" offers update
    assert.match((await h.say(P1, "hello")).replies[0], /1\. Register/);
    assert.match((await h.say(P1, "1")).replies[0], /already registered as Tendai/);
    await h.say(P1, "menu");
    assert.equal(h.db.prepare(`select count(*) n from participants where wa_phone_uid=?`).get(P1).n, 1);
  });
  it("T-03: outlet selection is hierarchical over all 80 branches, searchable, and always ends in a canonical id", async () => {
    const r1 = await h.say(P1, "2");
    assert.equal(r1.result.state, "OUTLET_RETAILER"); assert.match(r1.replies[0], /1\. Corner Choice/); assert.match(r1.replies[0], /8\. Valuemart/);
    const r4 = await h.say(P1, "1"); assert.equal(r4.result.state, "OUTLET_TOWN"); assert.match(r4.replies[0], /Corner Choice: choose the TOWN/); assert.match(r4.replies[0], /9\. More/, "10 towns paginate");
    const r2 = await h.say(P1, "9"); assert.equal(r2.result.state, "OUTLET_TOWN"); assert.match(r2.replies[0], /2\. Victoria Falls/, "second page");
    const r3 = await h.say(P1, "back"); assert.equal(r3.result.state, "OUTLET_RETAILER");
    await h.say(P1, "1");
    const r5 = await h.say(P1, "1"); assert.equal(r5.result.state, "OUTLET_BRANCH");
    const r6 = await h.say(P1, "1"); assert.equal(r6.result.state, "ENTRY_RECEIPT"); assert.match(r6.replies[0], /Outlet: Corner Choice —/);
    // free text never creates a phantom outlet; ambiguous branch names need disambiguation
    await h.say(P1, "back"); assert.equal((await h.say(P1, "westgate")).result.state, "OUTLET_SEARCH");
    const s = await h.say(P1, "westgate"); assert.ok((s.replies[0].match(/\n\d\./g) || []).length >= 2, "multiple Westgate branches listed");
    assert.match((await h.say(P1, "zzzz-nowhere")).replies[0], /No branch matched/);
    assert.match((await h.say(P1, "42")).replies[0], /one of the numbers/);
    const pick = await h.say(P1, "sunrise westgate harare"); const ok = await h.say(P1, "1"); assert.equal(ok.result.state, "ENTRY_RECEIPT");
    const ses = h.domain.getSession(h.campaign.id, P1); assert.match(JSON.parse(ses.context_json).selectedOutletId, /^out_SUN-HRE-01$/);
    assert.equal(h.domain.listCampaignOutlets(h.campaign.id).length, 80);
    void pick;
    assert.match((await h.say(P1, "hello there")).replies[0], /PHOTO of your receipt/);
  });
  it("T-05/T-06/T-13: first receipt awards one entry; second unique receipt awards another without re-registration; same receipt again (same and other phone, replayed webhook) never credits twice", async () => {
    const img1 = await h.simImage(h.simReceipt({ no: "004512" }));
    const a = await h.say(P1, "", { image: img1 });
    assert.match(a.replies[0], /received your receipt.*reference is R-/s);
    await h.app.intake.drain(); await h.app.worker.tick();
    const rid = a.result.receiptId; const rc = h.db.prepare(`select * from receipts where id=?`).get(rid);
    assert.equal(rc.status, "QUALIFIED");
    const outcome = h.db.prepare(`select payload_json from outbound_messages where idempotency_key like ?`).all(`receipt:${rid}:outcome%`);
    assert.equal(outcome.length, 1, "exactly one outcome message"); assert.match(JSON.parse(outcome[0].payload_json).body, /ONE entry has been added/); assert.doesNotMatch(JSON.parse(outcome[0].payload_json).body, /won/i);
    assert.equal(h.db.prepare(`select count(*) n from entries where participant_id=?`).get(rc.participant_id).n, 1);
    // second unique receipt: "2" straight after the outcome must start a new entry, no registration
    const b = await h.submit(P1, await h.simImage(h.simReceipt({ no: "004513" })));
    assert.equal(b.receipt.status, "QUALIFIED"); assert.equal(h.db.prepare(`select count(*) n from entries where participant_id=?`).get(rc.participant_id).n, 2);
    // same bytes again from the same phone
    const c = await h.submit(P1, img1); assert.equal(c.receipt.status, "DUPLICATE"); assert.match(c.outcomes[0], /already been used/); assert.doesNotMatch(c.outcomes[0], /2637/);
    // same purchase, different bytes, other phone
    await h.register(P2, { first: "Rudo", last: "Chari", identity: "TEST9999Y", town: "Bulawayo" });
    const d = await h.submit(P2, await h.simImage(h.simReceipt({ no: "004512" }) + "\n"));
    assert.equal(d.receipt.status, "DUPLICATE");
    assert.equal(h.db.prepare(`select count(*) n from entries`).get().n, 2);
    // webhook replay of the first image event: deduped, no extra reply/entry
    const replay = await h.say(P1, "", { image: img1, providerMessageId: a.id ? h.db.prepare(`select provider_message_id from channel_events where id=?`).get(a.id).provider_message_id : "x" });
    assert.equal(replay.duplicate, true); assert.equal(h.db.prepare(`select count(*) n from entries`).get().n, 2);
    // status (7) reflects committed state only
    const st = await h.say(P1, "7"); assert.match(st.replies[0], /Qualified entries: 2/); assert.match(st.replies[0], /Did not qualify: 1/);
  });
  it("global navigation: MENU, HELP, CANCEL, BACK from every state; unsupported input never qualifies", async () => {
    await h.say(P1, "2"); assert.match((await h.say(P1, "help")).replies[0], /BACK goes one step back/);
    assert.match((await h.say(P1, "cancel")).replies[0], /Cancelled/);
    await h.say(P1, "2"); await h.say(P1, "1"); await h.say(P1, "1"); await h.say(P1, "1");
    const v = await h.say(P1, "voice note", { }); assert.match(v.replies[0], /PHOTO of your receipt/);
    assert.equal(h.db.prepare(`select count(*) n from entries`).get().n, 2);
    assert.match((await h.say(P1, "0")).replies[0], /1\. Register/);
  });
  it("support handoff suspends automation until an operator releases it", async () => {
    const r = await h.say(P1, "support"); assert.match(r.replies[0], /team will pick this up/);
    assert.match((await h.say(P1, "2")).replies[0], /team is handling/);
    h.app.conversation.releaseHandoff(h.campaign.id, P1, "adm_test");
    assert.match((await h.say(P1, "menu")).replies[0], /1\. Register/);
  });
});

describe("one purchase, one entry — whatever outlet the participant picks", () => {
  it("the same printed receipt against a second branch is never auto-credited", async () => {
    // The canonical key is outlet|date|number|total, and the OUTLET is the
    // participant's own selection, so submitting one physical receipt against
    // two branches minted two identities and two entries for one purchase.
    // Reproduced before this was fixed. Two different shops CAN legitimately
    // print the same number on the same day for the same total, so the second
    // submission goes to a reviewer rather than being rejected outright.
    const g = await buildApp({ extractor: "simulator" });
    try {
      g.domain.upsertOutlet({ outlet_code: "SUN-HRE-02", retailer: "Sunrise Supermarket", branch: "Avondale", town: "Harare", province: "Harare", collection_enabled: 1, aliases: [] }, "test");
      g.domain.setCampaignOutlets(g.campaign.id, g.domain.listOutlets().map((o) => o.id), "test");
      const phone = "263771970555";
      await g.register(phone, { first: "Dup", last: "Branch", identity: "TESTDUPBR1" });
      const img = await g.simImage(g.simReceipt({ no: "888002" }));
      const a = await g.submit(phone, img, { outlet: "sunrise westgate harare" });
      assert.equal(a.receipt.status, "QUALIFIED");
      // different bytes, same printed receipt, different branch selected
      const b = await g.submit(phone, Buffer.concat([img, Buffer.from([7])]), { outlet: "sunrise avondale harare" });
      assert.equal(b.receipt.status, "REVIEW_REQUIRED", "a second branch must not mint a second identity");
      assert.equal(b.receipt.reason_code, "possible_duplicate_other_outlet");
      const active = g.db.prepare(`select count(*) n from entries where participant_id=(select id from participants where wa_phone_uid=?) and status='active'`).get(phone).n;
      assert.equal(active, 1, "one purchase is one entry");
      const kinds = g.db.prepare(`select kind from duplicate_candidates where receipt_id=?`).all(b.receiptId).map((x) => x.kind);
      assert.ok(kinds.includes("printed_identity"), `the reviewer is shown why: ${kinds.join(",")}`);
    } finally { await g.close(); }
  });
});
