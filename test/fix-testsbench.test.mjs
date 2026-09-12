// Tests + benchmark package (audit fixes: tests-1, tests-2, tests-6, tests-8;
// round two: tests-9 and the load-harness reporting/blind-spot follow-ups).
//
// Three of these cover gates that were reported as green while the thing they
// gate was broken (the receipt benchmark's exit code, the load harness's
// double-credit query) and one covers the branch that stands between a
// public MFA route and a password-free staff session. The remote-smoke tests
// read the script as text: it only runs against a live deployment, so the
// properties that can be checked here are structural (every check is named once
// and has a SKIP path) plus the response shapes its matchers now depend on.
import fs from "node:fs";
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { fixturePass, gateExitCode } from "../bench/run.mjs";
import { integrityFindings, loadReceipt, slipNo, RACE_SLIP } from "../bench/load.mjs";
import { createAudit } from "../src/audit.mjs";
import { openDb, migrate, normalizePhone } from "../src/db.mjs";
import { shortRef } from "../src/copy.mjs";
import { totp } from "../src/mfa.mjs";

describe("receipt benchmark gate (bench/run.mjs)", () => {
  it("a total parser regression fails the release gate instead of exiting 0", () => {
    // The exact shape measured on the 40-fixture manifest when every fixture
    // lands NOT_QUALIFIED: nothing is falsely accepted, so the old
    // `exit(false_accepts.length ? 2 : 0)` returned 0 and `npm run ci` was green.
    assert.equal(gateExitCode({ failed: 40, false_accepts: [], false_rejects: ["valid-two-pack-A", "valid-two-pack-B"] }), 1);
    assert.equal(gateExitCode({ failed: 1, false_accepts: [], false_rejects: [] }), 1, "any failed fixture fails the gate");
    assert.equal(gateExitCode({ failed: 0, false_accepts: [], false_rejects: ["dark"] }), 1, "a false reject fails even when the fixture 'passed' an alternation");
    assert.equal(gateExitCode({ failed: 3, false_accepts: ["dup-photo"], false_rejects: [] }), 2, "false accepts keep their own exit code");
    assert.equal(gateExitCode({ failed: 0, false_accepts: [], false_rejects: [] }), 0, "a clean run still passes");
  });

  it("a fixture rejected for the WRONG reason fails, even with the right disposition", () => {
    const f = { id: "date-before-window", expect: { document: "receipt", disposition: "NOT_QUALIFIED", reason: "receipt_date_outside_campaign" } };
    const observed = { disposition: "NOT_QUALIFIED", standalone: "NOT_QUALIFIED", document: "receipt", packs: 2, dupBy: [] };
    assert.equal(fixturePass(f, { ...observed, reason: "receipt_date_outside_campaign" }), true);
    assert.equal(fixturePass(f, { ...observed, reason: "no_qualifying_product" }), false,
      "the participant would be told the wrong thing and the review queue routed wrongly");
    // fixtures that declare no reason are unaffected
    const g = { id: "void-line", expect: { disposition: "NOT_QUALIFIED" } };
    assert.equal(fixturePass(g, { ...observed, reason: "anything" }), true);
  });

  it("still honours the existing expectations (dispositions, duplicates, parsed fields)", () => {
    const dup = { id: "dup-photo", duplicateOf: "valid-two-pack-A", expect: { document: "receipt", disposition: "QUALIFIED|REVIEW_REQUIRED" } };
    assert.equal(fixturePass(dup, { disposition: "DUPLICATE", standalone: "QUALIFIED", document: "receipt", dupBy: ["valid-two-pack-A"] }), true);
    assert.equal(fixturePass(dup, { disposition: "QUALIFIED", standalone: "QUALIFIED", document: "receipt", dupBy: [] }), false, "a credited duplicate is never a pass");
    const blurred = { id: "blurred", expect: { disposition: "REVIEW_REQUIRED|REUPLOAD_REQUIRED|NOT_QUALIFIED", neverQualify: true } };
    assert.equal(fixturePass(blurred, { disposition: "QUALIFIED", standalone: "QUALIFIED", dupBy: [] }), false);
    const valid = { id: "valid-two-pack-A", expect: { document: "receipt", disposition: "QUALIFIED", packs: 2, receiptNo: "004512", date: "2026-10-05" } };
    const read = { disposition: "QUALIFIED", standalone: "QUALIFIED", document: "receipt", packs: 2, receiptNo: "004512", date: "2026-10-05", dupBy: [] };
    assert.equal(fixturePass(valid, read), true);
    assert.equal(fixturePass(valid, { ...read, packs: 1 }), false);
    assert.equal(fixturePass(valid, { ...read, receiptNo: "004513" }), false);
  });
});

const cloner = (db) => (table, row, overrides) => {
  const next = { ...row, ...overrides }; const cols = Object.keys(next);
  db.prepare(`insert into ${table} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => next[c]));
  return next;
};

describe("load benchmark integrity gate (bench/load.mjs)", () => {
  let h; before(async () => { h = await buildApp({ extractor: "simulator" }); }); after(async () => { await h.close(); });

  it("counts ONE purchase credited under two canonical identities (the shape the old query could not see)", async () => {
    const P = "263771009101";
    await h.register(P, { identity: "TESTLOAD1X" });
    const r = await h.submit(P, await h.simImage(h.simReceipt({ no: "550101" })));
    assert.equal(r.receipt.status, "QUALIFIED");

    const entry = h.db.prepare(`select * from entries where receipt_id=?`).get(r.receiptId);
    assert.ok(entry?.canonical_receipt_id, "the awarded entry names the canonical purchase");
    const canonical = h.db.prepare(`select * from canonical_receipts where id=?`).get(entry.canonical_receipt_id);

    // Same physical slip, a SECOND canonical identity: the total read
    // differently by a concurrent worker (620 vs unreadable) mints a second row
    // whose outlet, date and receipt number are the same, and the purchase is
    // credited under each. The pipeline resolves this on the stable identity
    // today; the harness's gate is what must notice if that ever stops working.
    const clone = cloner(h.db);
    const receipt2 = clone("receipts", h.db.prepare(`select * from receipts where id=?`).get(r.receiptId), { id: "rcpt_second_photo", provider_message_id: "sim_second_photo" });
    const canonical2 = clone("canonical_receipts", canonical, { id: "can_second_read", canonical_key: `${canonical.canonical_key}x`, total_minor: (canonical.total_minor || 0) + 1, first_receipt_id: receipt2.id, credited_receipt_id: receipt2.id });
    clone("entries", entry, { id: "ent_second_credit", receipt_id: receipt2.id, canonical_receipt_id: canonical2.id, entry_no: entry.entry_no + 1 });

    const legacy = h.db.prepare(`select count(*) n from (select canonical_receipt_id, count(*) c from entries where status='active' group by canonical_receipt_id having c>1)`).get().n;
    assert.equal(legacy, 0, "two entries can never share ONE canonical id (unique index), which is why the old gate always read 0");

    const found = integrityFindings(h.db);
    assert.equal(found.double_credits, 1, "one purchase, two active entries -> the gate must trip");
    assert.equal(found.detail.purchases[0].c, 2);
  });

  it("reports a clean run as clean", async () => {
    const fresh = await buildApp({ extractor: "simulator" });
    try {
      const P = "263771009102";
      await fresh.register(P, { identity: "TESTLOAD2X" });
      await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550201" })));
      await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550202" })));
      const found = integrityFindings(fresh.db);
      assert.deepEqual({ ...found, detail: undefined }, { double_credits: 0, suspected_double_credits: 0, double_qualified: 0, unidentified_credits: 0, detail: undefined });
      assert.equal(fresh.db.prepare(`select count(*) n from entries where status='active'`).get().n, 2, "two distinct purchases, two entries");
    } finally { await fresh.close(); }
  });

  it("reports — but does not fail the run on — a purchase credited twice when OCR read NO receipt number", async () => {
    const fresh = await buildApp({ extractor: "simulator" });
    try {
      const P = "263771009103";
      await fresh.register(P, { identity: "TESTLOAD3X" });
      const r = await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550301" })));
      assert.equal(r.receipt.status, "QUALIFIED");
      const entry = fresh.db.prepare(`select * from entries where receipt_id=?`).get(r.receiptId);
      const canonical = fresh.db.prepare(`select * from canonical_receipts where id=?`).get(entry.canonical_receipt_id);
      const clone = cloner(fresh.db);
      // One physical slip, photographed twice, and on NEITHER read did OCR
      // recover the printed number (the review path credits such a row: the
      // canonical key comes from the receipt's stored fingerprint, the number
      // column stays null). The round-1 query excluded exactly these rows, so
      // the double credit the load harness exists to catch was invisible.
      fresh.db.prepare(`update canonical_receipts set receipt_no=null, receipt_no_norm=null where id=?`).run(canonical.id);
      const receipt2 = clone("receipts", fresh.db.prepare(`select * from receipts where id=?`).get(r.receiptId), { id: "rcpt_no_number", provider_message_id: "sim_no_number" });
      const canonical2 = clone("canonical_receipts", { ...canonical, receipt_no: null, receipt_no_norm: null }, { id: "can_no_number", canonical_key: `${canonical.canonical_key}x`, first_receipt_id: receipt2.id, credited_receipt_id: receipt2.id });
      clone("entries", entry, { id: "ent_no_number", receipt_id: receipt2.id, canonical_receipt_id: canonical2.id, entry_no: entry.entry_no + 1 });

      const roundOne = fresh.db.prepare(`select count(*) n from (select 1 from entries e join canonical_receipts cr on cr.id = e.canonical_receipt_id
        where e.status = 'active' and cr.txn_date is not null and coalesce(cr.receipt_no_norm, cr.receipt_no) is not null
        group by cr.campaign_id, cr.outlet_id, cr.txn_date, coalesce(cr.receipt_no_norm, upper(cr.receipt_no)) having count(*) > 1)`).get().n;
      assert.equal(roundOne, 0, "the round-1 query dropped every row without a printed number, so it read clean");

      const found = integrityFindings(fresh.db);
      // Reported, so the shape the round-1 query dropped is visible — but in
      // `suspected_double_credits`, NOT in the field the harness exits on. The
      // evidence left on these rows (outlet, day, total) is the same evidence
      // two genuinely distinct purchases leave, so a gate built on it fails
      // clean runs; the test below measures exactly that pair.
      assert.equal(found.suspected_double_credits, 1, "same outlet, same day, same total, no number: reported for a human to resolve");
      assert.equal(found.double_credits, 0, "...and never counted as proof, because this evidence cannot distinguish one purchase from two");
      assert.equal(found.unidentified_credits, 2, "and the rows with no printed identity are counted, not silently dropped");
      assert.equal(found.detail.suspected[0].c, 2);
    } finally { await fresh.close(); }
  });

  it("two distinct unreadable purchases are not reported as one — including when their totals are equal", async () => {
    const fresh = await buildApp({ extractor: "simulator" });
    try {
      const P = "263771009104";
      await fresh.register(P, { identity: "TESTLOAD4X" });
      const a = await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550401" })));
      const b = await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550402", packs: 3 })));
      assert.equal(a.receipt.status, "QUALIFIED"); assert.equal(b.receipt.status, "QUALIFIED");
      // different purchases (different totals), neither number read
      fresh.db.prepare(`update canonical_receipts set receipt_no=null, receipt_no_norm=null`).run();
      const found = integrityFindings(fresh.db);
      assert.equal(found.double_credits, 0, "the total still separates them: a benchmark run must not fail on two real purchases");
      assert.equal(found.suspected_double_credits, 0, "different totals: not even a suspicion");
      assert.equal(found.unidentified_credits, 2);
    } finally { await fresh.close(); }
  });

  it("two distinct purchases with the SAME total and no number do not fail the run", async () => {
    // The old guard only used receipts whose totals differed (2 packs vs 3), so
    // the tie on the total kept them apart and the claim "two genuinely distinct
    // unreadable purchases still do not trip it" was never measured. Two slips
    // from one shop on one day for the same amount are ordinary, and with the
    // number unread they group exactly like one slip credited twice: the gate
    // exited 1 on a corpus with nothing wrong in it.
    const fresh = await buildApp({ extractor: "simulator" });
    try {
      const P = "263771009105";
      await fresh.register(P, { identity: "TESTLOAD5X" });
      const a = await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550501" })));
      const b = await fresh.submit(P, await fresh.simImage(fresh.simReceipt({ no: "550502" })));
      assert.equal(a.receipt.status, "QUALIFIED"); assert.equal(b.receipt.status, "QUALIFIED");
      const totals = fresh.db.prepare(`select distinct total_minor from canonical_receipts`).all();
      assert.equal(totals.length, 1, "two separate purchases that happen to ring up the same amount");
      fresh.db.prepare(`update canonical_receipts set receipt_no=null, receipt_no_norm=null`).run();

      const found = integrityFindings(fresh.db);
      assert.equal(found.double_credits, 0, "a benchmark run must not fail on two real purchases that share a total");
      assert.equal(found.suspected_double_credits, 1, "the pair is still surfaced, as a suspicion a human resolves");
      assert.equal(found.unidentified_credits, 2);
      // the gate's own expression, exactly as bench/load.mjs computes it
      assert.equal(found.double_credits || found.double_qualified ? 1 : 0, 0, "`node bench/load.mjs` exits 0 on this corpus");
    } finally { await fresh.close(); }
  });

  it("receipt numbers stay unique across participants however many slips each uploads", async () => {
    // `700000 + i * 100 + n` overlapped as soon as per-participant uploads
    // reached 100 (per = ceil(N/C)): participant 1's 150th slip and
    // participant 2's 50th printed the SAME number, date, layout and outlet.
    const seen = new Map();
    for (let i = 1; i <= 6; i++) for (let n = 0; n < 400; n++) {
      const no = slipNo(i, n);
      assert.ok(!seen.has(no), `${no} is printed for both ${seen.get(no)} and ${i}-${n}`);
      seen.set(no, `${i}-${n}`);
    }
    assert.notEqual(slipNo(1, 150), slipNo(2, 50));
    const a = await loadReceipt(1, 150, 200), b = await loadReceipt(2, 50, 200);
    assert.equal(a.outletQuery, b.outletQuery, "same layout and outlet: only the number keeps these two slips apart");
    assert.notEqual(a.no, b.no, "two participants must never submit the same printed slip while the report calls both 'unique'");
    // the two ways the block can still run out both fail loudly rather than
    // quietly reprinting a slip another participant already submitted
    assert.throws(() => slipNo(1, 10000), /exhausted/, "an exhausted block fails loudly instead of silently colliding");
    assert.throws(() => slipNo(29, 100), /exhausted/, `participant 29 upload 100 would print the shared race slip ${RACE_SLIP.no}`);
  });

  it("the corpus is mostly unique purchases, with a shared slip and a self-duplicate cohort", async () => {
    const per = 6;
    const slips = [];
    for (let i = 1; i <= 3; i++) for (let k = 0; k < per; k++) slips.push({ i, k, ...await loadReceipt(i, k, per) });
    const race = slips.filter((s) => s.cohort === "race");
    assert.equal(race.length, 3, "every participant submits the shared slip once (the concurrent canonical-claim race)");
    assert.deepEqual([...new Set(race.map((s) => s.no))], [RACE_SLIP.no], "the race cohort is ONE printed identity");
    assert.deepEqual([...new Set(race.map((s) => s.bytes.toString("base64")))].length, 3, "same printed slip, different bytes: the canonical layer decides, not the image hash");

    const unique = slips.filter((s) => s.cohort === "unique");
    assert.equal(unique.length, new Set(unique.map((s) => s.no)).size, "no unique-cohort receipt number is reused");
    assert.ok(unique.length > slips.length / 2, `the award path is the majority of the corpus (${unique.length}/${slips.length}); it used to be 2 of 30`);
    const selfDup = slips.filter((s) => s.cohort === "self_duplicate");
    assert.equal(selfDup.length, 3);
    for (const s of selfDup) assert.ok(unique.some((u) => u.i === s.i && u.no === s.no && u.outletQuery === s.outletQuery), "the repeat is the participant's OWN earlier slip, at the same outlet, so it is a duplicate and not a cross-outlet review");
    // the outlet the harness selects must be the merchant printed on the slip,
    // or the rules answer outlet_selection_mismatch and nothing is ever awarded
    for (const s of slips) assert.ok(/sunrise|valuemart|kwikshop/.test(s.outletQuery || ""), `slip ${s.no} has no outlet selection`);
    assert.ok(slips.every((s) => s.bytes.length > 1000), "every upload is a rendered image");
  });
});

describe("MFA: the pending-challenge branch (src/auth.mjs) and the public route", () => {
  let h; before(async () => { h = await buildApp({ extractor: "simulator", seed: false }); }); after(async () => { await h.close(); });

  const EMAIL = "mfa-gap@x.test", PASSWORD = "MfaGapPassword123";
  let userId, secret;
  before(() => {
    const created = h.app.auth.createUser({ email: EMAIL, name: "MFA Tester", password: PASSWORD, roles: ["support"], mustChangePassword: false });
    userId = created.user.id;
    secret = h.app.auth.enrollMfa(userId).secret;
    assert.ok(h.app.auth.enableMfa(userId, totp(secret)).ok);
  });

  it("a valid code with no password login behind it issues nothing", () => {
    const r = h.app.auth.verifyMfa({ userId, code: totp(secret) });
    assert.match(r.error, /no pending/i, "the pending-challenge lookup is what makes MFA a SECOND factor");
    assert.equal(r.token, undefined);
    assert.equal(h.app.auth.verifyMfa({ userId: "adm_does_not_exist", code: totp(secret) }).token, undefined);
  });

  it("POST /api/login/mfa refuses a valid code until the password step has run, then consumes the challenge", async () => {
    // the route is public and takes an attacker-supplied userId
    const forged = await h.api("/api/login/mfa", { method: "POST", body: { userId, code: totp(secret) } });
    assert.equal(forged.status, 401);
    assert.equal(forged.data?.token, undefined);

    const login = await h.api("/api/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    assert.equal(login.data?.pendingMfa, true);
    assert.equal(login.data?.token, undefined, "the password step alone never mints a session for an MFA account");

    const wrong = await h.api("/api/login/mfa", { method: "POST", body: { userId, code: "000000" } });
    assert.equal(wrong.status, 401);

    const ok = await h.api("/api/login/mfa", { method: "POST", body: { userId, code: totp(secret) } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data?.token, "the second factor completes the login it belongs to");
    assert.equal(ok.data.user.email, EMAIL);
    const who = await h.api("/api/whoami", { token: ok.data.token });
    assert.equal(who.status, 200);

    // the challenge is single-use: a replayed code cannot mint a second session
    const replay = await h.api("/api/login/mfa", { method: "POST", body: { userId, code: totp(secret) } });
    assert.equal(replay.status, 401);
    assert.equal(replay.data?.token, undefined);
  });
});

describe("audit checkpoint: the negative branch no test ever observed", () => {
  it("a checkpoint that names a head the chain does not hold does not verify", () => {
    // Own database: this test erases a chain head, and appending afterwards on
    // a shared connection would collide with the UNIQUE prev_hash index.
    const db = openDb(":memory:"); migrate(db, undefined, () => {});
    const audit = createAudit(db, { checkpointKey: "test-checkpoint-key" });
    for (const t of ["a", "b", "c"]) audit.record({ actorId: "sys", action: "entry.awarded", targetType: "entry", targetId: `ent_${t}`, payload: { t } });

    const ckp = audit.checkpoint("usr_auditor");
    assert.equal(audit.verifyCheckpoint(ckp).signatureOk, true);
    assert.equal(audit.verifyCheckpoint(ckp).headMatches, true);

    // every existing assertion on headMatches expects true, so nothing in the
    // suite ever proved this returns false when the head does not match
    assert.equal(audit.verifyCheckpoint({ ...ckp, headHash: "00".repeat(32) }).headMatches, false, "a rewritten head must not match the signed checkpoint");
    assert.equal(audit.verifyCheckpoint({ ...ckp, uptoId: ckp.uptoId + 99 }).headMatches, false, "a checkpoint pointing past the chain must not match");

    // erasing the checkpointed event itself is detected by the retained copy
    db.prepare(`delete from audit_events where id=?`).run(ckp.uptoId);
    const after = audit.verifyCheckpoint(ckp);
    assert.equal(after.signatureOk, true, "the signature still proves the checkpoint is authentic");
    assert.equal(after.headMatches, false, "...and the chain no longer holds the head it signed");
    db.close();
  });
});

describe("remote-smoke evidence rows (scripts/remote-smoke.mjs)", () => {
  // The script only runs against a live deployment, so what is checkable here
  // is the source: the two defects were a check NAME written twice (the SKIP
  // row and the rec() call drifting apart) and conditional blocks that recorded
  // nothing at all when they did not run.
  const src = fs.readFileSync(new URL("../scripts/remote-smoke.mjs", import.meta.url), "utf8");
  const table = () => {
    const at = src.indexOf("const CHECK = {");
    assert.ok(at > 0, "the check names must live in ONE table both rec() and skipChecks() read");
    const block = src.slice(at, src.indexOf("\n};", at));
    let group = null; const out = [];
    for (const line of block.split("\n")) {
      const g = line.match(/^ {2}(\w+): \{$/); if (g) { group = g[1]; continue; }
      const m = line.match(/^ {4}(\w+): "(.+)",$/); if (m) out.push({ group, key: m[1], name: m[2] });
    }
    return out;
  };

  it("every conditional check is named once and records its own SKIP row when its block does not run", () => {
    const checks = table();
    for (const g of ["review", "participant", "support", "privacy", "published", "draw", "winners"]) {
      assert.ok(checks.some((c) => c.group === g), `group ${g} has no named checks`);
      assert.ok(src.includes(`Object.values(CHECK.${g})`), `group ${g} has no whole-group SKIP path`);
    }
    assert.equal(checks.filter((c) => c.group === "review").length, 12, "all twelve review checks are named, not collapsed into one coarse row");
    assert.ok(!src.includes(`rec("review workflow"`), "the coarse 'review workflow' row hid twelve checks behind one SKIP");
    for (const c of checks) {
      const ref = `CHECK.${c.group}.${c.key}`;
      assert.ok(src.includes(`rec(${ref},`), `${ref} is never recorded by a rec() call`);
      assert.ok(!src.includes(`rec("${c.name}"`), `"${c.name}" is written out at its call site: a rename would leave the SKIP row naming a check that no longer exists`);
    }
    // the blocks the reviewer found still silent: each names its own rows
    for (const ref of ["CHECK.review.mediaAnon", "CHECK.review.mediaServed", "CHECK.review.mediaTampered", "CHECK.review.disqualify", "CHECK.review.reinstate"]) {
      assert.ok(new RegExp(`skipChecks\\("review", \\[[^\\]]*${ref.replace(/\./g, "\\.")}`).test(src), `${ref} is omitted with no SKIP row when its inner block does not run`);
    }
  });

  it("the operations and support rows assert content, not just HTTP 200", async () => {
    for (const statusOnly of [
      `rec("support sees the conversation transcript (masked phone)", conv.ok,`,
      `rec("queue stats and dead letters", queue.ok,`,
      `rec("CRM mapping preview", map.ok,`,
      `rec("CRM reconcile runs (audited)", recon.ok,`,
      `rec("alerts view", alerts.ok,`,
      `rec("reports summary", rep.ok,`,
    ]) assert.ok(!src.includes(statusOnly), `still passes on HTTP 200 alone: ${statusOnly}`);

    // ...and the content those rows now assert is what a healthy deployment
    // actually returns (a wrong matcher would turn a good deployment red).
    const h = await buildApp({ extractor: "simulator" });
    try {
      const admin = await h.login("admin@x.test", "TestAdminPassword123");
      const support = await h.staffToken("support@example.test");
      const P = "263771009301";
      await h.register(P, { identity: "TESTSMK01A" });
      const r = await h.submit(P, await h.simImage(h.simReceipt({ no: "770101" })));
      assert.equal(r.receipt.status, "QUALIFIED");
      await h.say(P, "7");

      const conv = await h.api(`/api/conversations/${P}`, { token: support });
      const convRows = conv.data?.transcript || [];
      assert.ok(convRows.some((t) => t.dir === "in" && t.text === "7"), "the transcript carries this run's own inbound messages");
      assert.ok(convRows.some((t) => t.dir === "out" && (t.text || "").length > 0));
      assert.match(conv.data?.participant?.phone || "", /^\*\*\*\d{4}$/);
      // scoped to the participant RECORD: the transcript itself legitimately
      // quotes the number back to the participant ("WhatsApp number: +263...")
      // in the registration confirmation, so asserting over the whole body
      // would fail against a healthy deployment.
      assert.ok(!JSON.stringify(conv.data.participant).includes(P), "the staff view of the participant carries only the masked phone");

      const queue = await h.api("/api/queue", { token: admin });
      assert.ok(Object.keys(queue.data?.events || {}).length > 0, "queue stats report the events this run created");
      assert.ok(Array.isArray(queue.data?.dead_events) && Array.isArray(queue.data?.dead_jobs));

      const map = await h.api("/api/crm/mapping-preview", { token: admin });
      assert.ok(map.data?.mapping_version && map.data?.record?.external_key);
      assert.ok((map.data?.excluded_by_default || []).includes("identity number"));

      const newestAudit = (r) => (r.data?.events || [])[0]?.id ?? 0;
      const auditBefore = await h.api("/api/audit-events?action=crm.reconcile", { token: admin });
      const recon = await h.api("/api/crm/reconcile", { method: "POST", token: admin });
      assert.ok(Number.isInteger(recon.data?.scanned) && Array.isArray(recon.data?.differences));
      const auditAfter = await h.api("/api/audit-events?action=crm.reconcile", { token: admin });
      assert.ok(newestAudit(auditAfter) > newestAudit(auditBefore), "'(audited)' is a claim about an audit row, compared by id (the smoke run's clock is not the deployment's)");

      const alerts = await h.api("/api/alerts", { token: admin });
      assert.ok(Array.isArray(alerts.data?.alerts) && alerts.data.alerts.every((a) => a.kind && a.severity && a.created_at));

      const rep = await h.api(`/api/reports/summary?campaign=${h.campaign.id}`, { token: admin });
      assert.equal(rep.data?.campaign, h.campaign.id);
      assert.ok(rep.data?.entries_active >= 1 && rep.data?.submissions >= 1 && Array.isArray(rep.data?.submissions_by_status));
    } finally { await h.close(); }
  });

  it("menu 7: the count is only readable off its own label, and the copy lists just the three most recent receipts", async () => {
    // the matcher itself (the module cannot be imported: it exits at load time
    // without BASE_URL), then the copy behaviour that makes the old one unsafe
    assert.ok(!src.includes('new RegExp(`\\\\b${activeEntries}\\\\b`)'), "any digit in the message satisfied the old count matcher");
    assert.ok(src.includes("Qualified entries:"), "the count is read off the label the status copy prints");
    assert.ok(!src.includes("mine.text.includes(s1.ref)"), "the FIRST reference falls off the status copy as soon as another P1 upload is added above it");

    const h = await buildApp({ extractor: "simulator" });
    try {
      const P = "263771009302";
      await h.register(P, { identity: "TESTSMK02A" });
      const img = await h.simImage(h.simReceipt({ no: "880101" }));
      const first = await h.submit(P, img);
      assert.equal(first.receipt.status, "QUALIFIED");
      await h.submit(P, img);                                                          // DUPLICATE
      await h.submit(P, await h.simImage(h.simReceipt({ no: "880102", packs: 1 })));   // NOT_QUALIFIED
      await h.submit(P, await h.simImage(h.simReceipt({ no: "880103", packs: 1 })));   // NOT_QUALIFIED
      const text = (await h.say(P, "7")).replies.join("\n");

      const pid = h.domain.getParticipantByPhone(P).id;
      const rows = h.db.prepare(`select id from receipts where participant_id=? order by created_at desc`).all(pid);
      assert.equal(rows.length, 4);
      assert.equal(rows[3].id, first.receiptId, "the qualifying receipt is the oldest of the four");
      assert.ok(text.includes(shortRef(rows[0].id)), "the most recent reference is listed");
      assert.ok(!text.includes(shortRef(rows[3].id)),
        "the copy lists only the three most recent receipts, so pinning the FIRST reference makes the smoke check fail against a healthy deployment");

      // the count: one active entry, three rejected receipts
      assert.match(text, /Qualified entries:\s*1\b/);
      assert.ok(/\b3\b/.test(text), "'3' appears in the message (Did not qualify: 3)");
      assert.ok(!new RegExp(`Qualified entries:\\s*3\\b`).test(text),
        "an unanchored \\b3\\b would have scored PASS for a deployment reporting three entries when there is one");
    } finally { await h.close(); }
  });

  it("the two participant phones are DIFFERENT numbers, and every reference the menu-7 row accepts is one of P1's own last three uploads", () => {
    // The menu-7 row failed on every single invocation of the script — 74
    // passed, 1 FAILED, exit 1, so no clean evidence run was possible — and the
    // test above could not see it, because it builds its own participant
    // instead of reading the journey the script actually drives.
    //
    // The cause was the phones, not the matcher: `26377` (5 chars) plus the
    // 7-digit run is already 12 characters, so `.slice(0, 12)` dropped the
    // trailing 1/2 and P1 === P2. ONE participant then played both parts, and
    // P2's four uploads (s1c, one, noise, amb) landed on top of P1's two. The
    // status copy prints only the three MOST RECENT receipts, so neither
    // s1.ref nor s1b.ref could ever appear, and the adjacent
    // "cross-phone re-use blocked" row was really a same-phone re-submission.
    //
    // Both halves are pinned here: the derivation must yield two distinct,
    // dialable numbers, and the references the row accepts must all belong to
    // P1 uploads that are still among the three the copy prints.
    const decl = src.match(/const run = (.+?);\s*const P1 = (.+?), P2 = (.+?);/);
    assert.ok(decl, "the script must still derive the two participant phones from the run id on one line");
    const [P1, P2] = new Function(`const run = ${decl[1]}; return [${decl[2]}, ${decl[3]}];`)();
    assert.notEqual(P1, P2, `the smoke run's two participants share the phone ${P1}: P2's uploads push P1's off the status copy`);
    for (const phone of [P1, P2]) assert.equal(normalizePhone(phone), phone, `${phone} is not a number the channel will accept as-is`);
    assert.notEqual(normalizePhone(P1), normalizePhone(P2), "the two phones must resolve to two participants, not one");

    const menuSevenAt = src.indexOf('const mine = await sim(admin, P1, "7")');
    assert.ok(menuSevenAt > 0, "the menu-7 status read must still be driven from P1");
    const uploads = [...src.slice(0, menuSevenAt).matchAll(/const (\w+) = await submitReceipt\(admin, P1,/g)].map((m) => m[1]);
    assert.ok(uploads.length >= 1, "P1 submits at least one receipt before its status is read");
    assert.ok(uploads.length <= 3, `P1 uploads ${uploads.length} receipts before menu 7; the copy lists only the three most recent, so the earliest can no longer be asserted`);
    const refs = src.slice(menuSevenAt).match(/myRefs = \[([^\]]+)\]/);
    assert.ok(refs, "the row must still assert a reference from this run");
    const accepted = refs[1].split(",").map((t) => t.trim().replace(/\.ref$/, ""));
    for (const name of accepted) assert.ok(uploads.includes(name), `myRefs accepts ${name}.ref, which is not one of P1's own uploads (${uploads.join(", ")})`);
    // Subset, not equality. Requiring myRefs to name EVERY pre-menu-7 upload
    // would reject the strictly safer edit of pinning only the newest reference,
    // which is the one that cannot fall off the three the copy prints. What has
    // to hold is that each accepted name is one of P1's own uploads (above) and
    // that at least one of them is among the last three.
    assert.ok(accepted.length > 0, "the row must accept at least one reference");
    const newest = uploads.slice(-3);
    assert.ok(accepted.some((n) => newest.includes(n)), `none of ${accepted.join(", ")} is among P1's three most recent uploads (${newest.join(", ")}), so the copy can never contain it`);
  });
});
