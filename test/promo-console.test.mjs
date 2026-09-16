// The promotion team's console (src/routes/promo.mjs + the PromoConsole surface).
//
// The client's own staff run the promotion; they are not engineers. These tests
// hold the two properties that make that surface usable and safe: every filter
// they were promised actually narrows the list against real submissions, and an
// assistant cannot take a shopper's entry away.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web-console", "src");
const componentNames = (file) => new Set([...fs.readFileSync(path.join(WEB, file), "utf8")
  .matchAll(/^(?:function|const) ([A-Z][A-Za-z0-9]*)/gm)].map((m) => m[1]));

describe("the two consoles keep their component names apart", () => {
  it("no component name is shared with the technical console", () => {
    // Both consoles are bundled into one file. esbuild renames one of two
    // same-named functions, and the console test harness identifies a component
    // by Function.name — so a collision silently detaches whichever set of tests
    // loses the name, with no error anywhere. That is exactly what happened when
    // this file first shipped a component called Entries and another called
    // Field: sixteen tests of the TECHNICAL console started failing.
    const shared = [...componentNames("promo/PromoConsole.jsx")].filter((n) => componentNames("App.jsx").has(n));
    assert.deepEqual(shared, [], `these component names exist in both consoles: ${shared.join(", ")}`);
  });
});

describe("promotion console", () => {
  let h, adminTok, assistantTok, reviewerTok, store2;
  const get = (path, token) => h.api(path, { token });

  before(async () => {
    h = await buildApp({ extractor: "simulator" });
    // A second branch of the same retailer, in another town, so the shop, branch
    // and location filters have something to discriminate.
    h.domain.upsertOutlet({ outlet_code: "SUN-BYO-09", retailer: "Sunrise Supermarket", branch: "Ascot", town: "Bulawayo", province: "Bulawayo", collection_enabled: 1, aliases: [] }, "test");
    h.domain.setCampaignOutlets(h.campaign.id, h.domain.listOutlets().map((o) => o.id), "test");
    store2 = h.domain.listOutlets().find((o) => o.outlet_code === "SUN-BYO-09").id;

    h.app.auth.createUser({ email: "promo@client.test", name: "Promo Admin", password: "ClientPromoPass123", roles: ["promotion_admin"], mustChangePassword: false });
    h.app.auth.createUser({ email: "assist@client.test", name: "Promo Assistant", password: "ClientPromoPass123", roles: ["promotion_assistant"], mustChangePassword: false });
    adminTok = await h.login("promo@client.test", "ClientPromoPass123");
    assistantTok = await h.login("assist@client.test", "ClientPromoPass123");
    reviewerTok = await h.staffToken("reviewer@example.test");

    // Westgate, two packs — qualifies.
    await h.register("263772000101", { first: "Tariro", last: "Moyo", identity: "TESTPC0001" });
    await h.submit("263772000101", await h.simImage(h.simReceipt({ no: "700101", packs: 2 })), { outlet: "sunrise westgate harare" });
    // Westgate, four packs, and a second receipt from the same person.
    await h.register("263772000102", { first: "Nyasha", last: "Banda", identity: "TESTPC0002" });
    await h.submit("263772000102", await h.simImage(h.simReceipt({ no: "700102", packs: 4 })), { outlet: "sunrise westgate harare" });
    await h.submit("263772000102", await h.simImage(h.simReceipt({ no: "700103", packs: 3 })), { outlet: "sunrise westgate harare" });
    // One pack — below the minimum, so a submission with no entry.
    await h.register("263772000103", { first: "Rudo", last: "Chikwava", identity: "TESTPC0003" });
    await h.submit("263772000103", await h.simImage(h.simReceipt({ no: "700104", packs: 1 })), { outlet: "sunrise westgate harare" });
  });
  after(async () => { await h.close(); });

  it("the overview answers 'is anything waiting for me' without a single code", async () => {
    const r = await get("/api/promo/summary", adminTok);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.entries.counting >= 3, `entries counting for the draw: ${r.data.entries.counting}`);
    assert.ok(r.data.submissions.total >= 4);
    assert.ok(r.data.submissions.rejected >= 1, "the one-pack receipt is counted as not qualifying");
    assert.equal(typeof r.data.needs_attention.queries_waiting, "number");
    // Nothing in the payload may leak a raw disposition or reason code: the whole
    // point of this surface is that the reader never meets one.
    const blob = JSON.stringify(r.data);
    for (const code of ["REVIEW_REQUIRED", "NOT_QUALIFIED", "below_minimum_quantity"]) {
      assert.ok(!blob.includes(code), `the overview must not expose ${code}`);
    }
  });

  it("every entry row names the shop, the town, the packs and how many receipts that person sent", async () => {
    const r = await get("/api/promo/entries", adminTok);
    assert.equal(r.status, 200);
    const row = r.data.rows.find((x) => x.person.name === "Nyasha Banda");
    assert.ok(row, `Nyasha's entry is listed: ${r.data.rows.map((x) => x.person.name).join(", ")}`);
    assert.equal(row.store.retailer, "Sunrise Supermarket");
    assert.equal(row.store.town, "Harare");
    assert.ok(row.packs >= 3, `packs recorded: ${row.packs}`);
    assert.equal(row.person.receipts_submitted, 2, "she sent two receipts");
    assert.equal(row.standing_label, "Counts for the draw");
    assert.match(row.person.phone, /^\*\*\*\d{4}$/, "the number is masked");
  });

  it("the four filters actually narrow the list", async () => {
    const all = await get("/api/promo/entries", adminTok);
    const base = all.data.total;
    assert.ok(base >= 3, `something to filter: ${base}`);

    // Store: the Bulawayo branch has no submissions, so it must return none.
    const byStore = await get(`/api/promo/entries?store=${store2}`, adminTok);
    assert.equal(byStore.data.total, 0, "no entries were earned at the Ascot branch");

    // Location.
    const harare = await get("/api/promo/entries?town=Harare", adminTok);
    assert.equal(harare.data.total, base, "every entry so far was bought in Harare");
    const byo = await get("/api/promo/entries?town=Bulawayo", adminTok);
    assert.equal(byo.data.total, 0);

    // Quantity of product purchased.
    const big = await get("/api/promo/entries?packs_min=3", adminTok);
    assert.ok(big.data.total >= 1 && big.data.total < base, `3+ packs narrows ${base} to ${big.data.total}`);
    assert.ok(big.data.rows.every((x) => x.packs >= 3), "every row really bought 3 or more");
    const exactly2 = await get("/api/promo/entries?packs_min=2&packs_max=2", adminTok);
    assert.ok(exactly2.data.rows.every((x) => x.packs === 2));

    // Number of receipts submitted by that person.
    const repeat = await get("/api/promo/entries?receipts_min=2", adminTok);
    assert.ok(repeat.data.rows.every((x) => x.person.receipts_submitted >= 2), "only repeat senders");
    assert.ok(repeat.data.rows.some((x) => x.person.name === "Nyasha Banda"));
    const once = await get("/api/promo/entries?receipts_max=1", adminTok);
    assert.ok(once.data.rows.every((x) => x.person.receipts_submitted === 1));
  });

  it("a receipt that never became an entry still says why, in plain words", async () => {
    const r = await get("/api/promo/submissions?category=rejected", adminTok);
    assert.equal(r.status, 200);
    const row = r.data.rows.find((x) => x.person.name === "Rudo Chikwava");
    assert.ok(row, "the one-pack receipt is listed under the rejected category");
    assert.equal(row.outcome, "Did not qualify");
    assert.equal(row.reason_label, "Fewer packs than the promotion requires");
    assert.equal(row.entry_id, null, "no entry came from it");
    // and the filters work on this list too
    const filtered = await get(`/api/promo/submissions?category=rejected&town=Bulawayo`, adminTok);
    assert.equal(filtered.data.total, 0);
  });

  it("the detail view explains which checks were met without naming a rule key", async () => {
    const list = await get("/api/promo/submissions?category=rejected", adminTok);
    const id = list.data.rows[0].receipt_id;
    const r = await get(`/api/promo/submissions/${id}`, adminTok);
    assert.equal(r.status, 200);
    assert.ok(r.data.checks.length, "the checks are listed");
    assert.ok(r.data.checks.every((c) => ["Met", "Not met", "Could not tell"].includes(c.outcome)), JSON.stringify(r.data.checks));
    assert.ok(r.data.checks.every((c) => !/_/.test(c.check)), "no snake_case rule keys reach the reader");
  });

  it("an assistant can read and answer, but cannot take an entry away", async () => {
    const entries = await get("/api/promo/entries", assistantTok);
    assert.equal(entries.status, 200, "an assistant reads the same list");
    const id = entries.data.rows[0].entry_id;

    const refused = await h.api(`/api/promo/entries/${id}/disqualify`, { token: assistantTok, method: "POST", body: { reason: "assistant should not be able to" } });
    assert.equal(refused.status, 403, "only a promotion administrator decides entries");
    assert.equal(h.db.prepare(`select status from entries where id=?`).get(id).status, "active", "and nothing changed");

    const me = await get("/api/promo/me", assistantTok);
    assert.equal(me.data.can_decide_entries, false, "so the console renders no decision buttons");
    assert.equal((await get("/api/promo/me", adminTok)).data.can_decide_entries, true);
  });

  it("a disqualification by the promotion administrator goes through the audited path", async () => {
    const entries = await get("/api/promo/entries", adminTok);
    const row = entries.data.rows.find((x) => x.standing === "active");
    const noReason = await h.api(`/api/promo/entries/${row.entry_id}/disqualify`, { token: adminTok, method: "POST", body: {} });
    assert.equal(noReason.status, 400, "a reason is required; it is shown to auditors");

    const ok = await h.api(`/api/promo/entries/${row.entry_id}/disqualify`, { token: adminTok, method: "POST", body: { reason: "receipt was for the wrong product" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(h.db.prepare(`select status from entries where id=?`).get(row.entry_id).status, "excluded");
    const audited = h.db.prepare(`select count(*) n from audit_events where target_id=? and action like 'entry.%'`).get(row.entry_id).n;
    assert.ok(audited >= 1, "the decision is in the hash-chained audit trail");
    const back = await h.api(`/api/promo/entries/${row.entry_id}/reinstate`, { token: adminTok, method: "POST", body: { reason: "checked again, it was right" } });
    assert.equal(back.status, 200, JSON.stringify(back.data));
  });

  it("the technical roles do not reach this surface, and the promotion roles do not reach theirs", async () => {
    assert.equal((await get("/api/promo/entries", reviewerTok)).status, 403, "the promotion desk is the client's, not the platform's");
    assert.equal((await get("/api/audit-events", adminTok)).status, 403, "the promotion team gets no audit console");
    assert.equal((await get("/api/users", adminTok)).status, 403, "nor staff administration");
    assert.equal((await get("/api/receipts", adminTok)).status, 403, "nor the technical receipt list");
    // `roles: "any"` means any signed-in staff member, so the promotion team can
    // read the campaign list. That is deliberate and worth pinning: it is the
    // boundary of what they reach on the technical API, not an oversight.
    assert.equal((await get("/api/campaigns", adminTok)).status, 200, "the campaign list is open to any signed-in user");
  });

  it("queries list the people waiting, so nobody has to know a phone number to find them", async () => {
    await h.say("263772000101", "support");
    const r = await get("/api/promo/queries", adminTok);
    assert.equal(r.status, 200);
    const row = r.data.rows.find((x) => x.name === "Tariro Moyo");
    assert.ok(row, `the waiting person is listed: ${JSON.stringify(r.data.rows)}`);
    assert.equal(row.waiting, true);
    assert.match(row.phone, /^\*\*\*\d{4}$/);

    const claimed = await h.api(`/api/promo/queries/${row.phone_uid}/claim`, { token: assistantTok, method: "POST" });
    assert.equal(claimed.status, 200, "an assistant may take a query");
    const sent = await h.api(`/api/promo/queries/${row.phone_uid}/send`, { token: assistantTok, method: "POST", body: { text: "Hello, we are looking into your receipt now." } });
    assert.equal(sent.status, 200);
    assert.ok(h.db.prepare(`select count(*) n from outbound_messages where wa_phone_uid=? and purpose='support'`).get(row.phone_uid).n >= 1, "the reply went through the durable outbox");
    assert.equal((await h.api(`/api/promo/queries/${row.phone_uid}/release`, { token: assistantTok, method: "POST" })).status, 200);
  });

  it("the promotion team can open the receipt photo with their own session", async () => {
    const list = await get("/api/promo/submissions", adminTok);
    const id = list.data.rows[0].receipt_id;
    const img = await h.api(`/api/promo/submissions/${id}/photo`, { token: adminTok, raw: true });
    assert.equal(img.status, 200, "the photo is served to the promotion administrator");
    assert.match(img.headers.get("content-type") || "", /^image\//);
    assert.match(img.headers.get("cache-control") || "", /no-store/, "a receipt photo must not sit in a cache");
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await h.api(`/api/promo/submissions/${id}/photo`, { token: assistantTok, raw: true })).status, 200, "an assistant needs it too, to judge a reading");
    // No session, no photo — the audit's finding was a link that worked without one.
    assert.equal((await h.api(`/api/promo/submissions/${id}/photo`, { raw: true })).status, 401);
    assert.equal((await h.api(`/api/promo/submissions/${id}/photo`, { token: reviewerTok, raw: true })).status, 403);
  });

  it("the quantity is recorded on the receipt, not recomputed for the console", () => {
    const r = h.db.prepare(`select qualifying_packs, qualifying_grams from receipts where status='QUALIFIED' order by created_at limit 1`).get();
    assert.ok(r.qualifying_packs >= 2, `packs on the receipt row: ${r.qualifying_packs}`);
    assert.ok(r.qualifying_grams > 0, `grams on the receipt row: ${r.qualifying_grams}`);
  });
});
