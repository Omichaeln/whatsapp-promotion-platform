// Evidence package, round three: the release smoke script's two participant
// identities and the load harness's integrity gate.
//
// The smoke script cannot be imported (it exits at load time without BASE_URL)
// and only runs against a live deployment, so the tests below do the two things
// that ARE possible here: evaluate the script's own identity expression as
// source, and replay the journey that expression drives against a real app.
// The round-two test for menu 7 built its own four-receipt participant instead
// of replaying the script's journey, which is why it stayed green while every
// real invocation of the script exited 1 on that exact row.
import fs from "node:fs";
import { describe, it, assert, buildApp } from "./helpers.mjs";
import { normalizePhone } from "../src/db.mjs";
import { shortRef } from "../src/copy.mjs";

const SMOKE = fs.readFileSync(new URL("../scripts/remote-smoke.mjs", import.meta.url), "utf8");

/** Evaluate the script's own `run` / P1 / P2 line, so this is the shipped expression and not a copy of it. */
function smokeIdentities() {
  const line = SMOKE.split("\n").find((l) => l.startsWith("const run = "));
  assert.ok(line, "scripts/remote-smoke.mjs no longer builds its run id and phones on one `const run = ` line");
  return new Function(`${line} return { run, P1, P2 };`)();
}

describe("remote-smoke participant identities (scripts/remote-smoke.mjs)", () => {
  it("the two smoke participants are two different phone numbers", () => {
    // `26377` (5 chars) + the 7-digit run is already 12 characters, so the old
    // `.slice(0, 12)` truncated the trailing 1/2 and P1 === P2: ONE participant
    // played both parts of the journey. Every consequence below follows from
    // that single collision.
    const { run, P1, P2 } = smokeIdentities();
    assert.notEqual(P1, P2, "P1 and P2 must be distinct numbers or the journey has one participant, not two");
    assert.ok(run.length >= 6, "the run id is what keeps receipt numbers and identity documents unique between runs");
    for (const p of [P1, P2]) {
      assert.match(p, /^263\d+$/, "still a Zimbabwean channel identity");
      assert.ok(normalizePhone(p), `${p} must survive normalizePhone() (8..15 digits) or the simulator cannot address it`);
    }
    assert.notEqual(normalizePhone(P1), normalizePhone(P2), "distinct before normalisation is worthless if they merge after it");
  });

  it("replaying the script's own journey leaves P1's two receipts inside the menu-7 status copy", async () => {
    // The script asserts `Qualified entries: <n>` plus one of [s1b.ref, s1.ref].
    // The status copy lists only the three MOST RECENT receipts
    // (src/conversation.mjs), so with the phones merged P2's four uploads sat on
    // top of P1's two and neither reference could ever appear: the row failed
    // deterministically on every run and the script exited 1.
    const { P1, P2 } = smokeIdentities();
    const h = await buildApp({ extractor: "simulator" });
    try {
      await h.register(P1, { first: "Smoke", last: "Tester", identity: "TESTSMKE1A" });
      const img1 = await h.simImage(h.simReceipt({ no: "990701" }));
      const s1 = await h.submit(P1, img1);
      assert.equal(s1.receipt.status, "QUALIFIED", "the script's first slip is the one that awards the entry");
      const s1b = await h.submit(P1, img1);
      assert.equal(s1b.receipt.status, "DUPLICATE", "the same slip from the same phone");

      // P2's leg of the journey: four uploads, exactly as the script submits
      // them (s1c, one, noise, amb). Their dispositions are P2's business; what
      // this test is about is that they are P2's receipts and not P1's.
      await h.register(P2, { first: "Smoke", last: "Second", identity: "TESTSMKE1B" });
      const s1c = await h.submit(P2, img1);
      assert.equal(s1c.receipt.status, "DUPLICATE", "same purchase from another phone: the 'cross-phone re-use blocked' row is only that check when the phones differ");
      assert.notEqual(s1c.receipt.participant_id, s1.receipt.participant_id, "the row is named 'from another phone' and must be exactly that");
      await h.submit(P2, await h.simImage(h.simReceipt({ no: "990702", packs: 1 })));
      await h.submit(P2, await h.simImage(h.simReceipt({ no: "990703", packs: 1 })));
      await h.submit(P2, await h.simImage(h.simReceipt({ no: "990704" })));

      // ...and now the script's menu-7 row, matcher and all.
      const pid = h.domain.getParticipantByPhone(P1).id;
      const activeEntries = h.db.prepare(`select count(*) n from entries where participant_id=? and status='active'`).get(pid).n;
      const text = (await h.say(P1, "7")).replies.join("\n");
      const myRefs = [shortRef(s1b.receiptId), shortRef(s1.receiptId)];

      assert.ok(new RegExp(`Qualified entries:\\s*${activeEntries}\\b`).test(text), "the count is read off its own label");
      assert.ok(myRefs.some((r) => text.includes(r)), "one of THIS participant's own references is in the three the status copy lists");
      assert.equal(h.db.prepare(`select count(*) n from receipts where participant_id=?`).get(pid).n, 2,
        "P1 submits exactly two receipts, so both are always inside the three-receipt window the copy prints");
    } finally { await h.close(); }
  });
});
