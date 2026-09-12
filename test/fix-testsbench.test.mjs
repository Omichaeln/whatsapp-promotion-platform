// Tests + benchmark package (audit fixes: tests-1, tests-2, tests-6, tests-8).
//
// Three of these cover gates that were reported as green while the thing they
// gate was broken (the receipt benchmark's exit code, the load harness's
// double-credit query) and one covers the branch that stands between a
// public MFA route and a password-free staff session.
import { describe, it, before, after, assert, buildApp } from "./helpers.mjs";
import { fixturePass, gateExitCode } from "../bench/run.mjs";
import { integrityFindings, loadReceipt, RACE_SLIP } from "../bench/load.mjs";
import { createAudit } from "../src/audit.mjs";
import { openDb, migrate } from "../src/db.mjs";
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
    const clone = (table, row, overrides) => {
      const next = { ...row, ...overrides }; const cols = Object.keys(next);
      h.db.prepare(`insert into ${table} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => next[c]));
      return next;
    };
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
      assert.deepEqual({ ...found, detail: undefined }, { double_credits: 0, double_qualified: 0, detail: undefined });
      assert.equal(fresh.db.prepare(`select count(*) n from entries where status='active'`).get().n, 2, "two distinct purchases, two entries");
    } finally { await fresh.close(); }
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
