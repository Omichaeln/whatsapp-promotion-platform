import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate } from "../src/db.mjs";
import { createAuth } from "../src/auth.mjs";
import { generateSecret, totp, verifyTotp, otpauthUri, base32ToBuf } from "../src/mfa.mjs";

function app() {
  const db = openDb(":memory:");
  migrate(db, undefined, () => {});
  const auth = createAuth(db, { bootstrap: { email: "admin@test.com", password: "SuperSecret123" } });
  return { db, auth };
}

describe("MFA (DEF-02)", () => {
  it("TOTP generates consistent codes and verifies within one window skew", () => {
    const secret = generateSecret();
    const t = 1_700_000_000_000;
    const code = totp(secret, { timeMs: t });
    assert.match(code, /^\d{6}$/);
    assert.equal(verifyTotp(secret, code, { timeMs: t }), true);
    assert.equal(verifyTotp(secret, "000000", { timeMs: t }), false);
    // previous window still valid (+/- 30s skew)
    assert.equal(verifyTotp(secret, totp(secret, { timeMs: t - 30_000 }), { timeMs: t }), true);
  });

  it("generates a valid base32 secret and otpauth URI", () => {
    const secret = generateSecret(20);
    assert.equal(base32ToBuf(secret).length, 20);
    const uri = otpauthUri(secret, { label: "x@WhatsApp" });
    assert.ok(uri.startsWith("otpauth://totp/"));
    assert.ok(uri.includes("secret=" + secret));
  });

  it("login with MFA enabled returns pending challenge; token only after valid code", () => {
    const { db, auth } = app();
    // enroll + enable for the admin
    const me = auth.login({ email: "admin@test.com", password: "SuperSecret123" }).user;
    const enrolled = auth.enrollMfa(me.id);
    assert.ok(enrolled.secret);
    const code = totp(enrolled.secret);
    assert.ok(auth.enableMfa(me.id, code).ok);
    assert.equal(auth.enableMfa(me.id, "000000").error, "invalid MFA code");

    // login now defers token
    const login = auth.login({ email: "admin@test.com", password: "SuperSecret123" });
    assert.equal(login.pendingMfa, true);
    assert.equal(login.token, undefined);

    // wrong code -> no token
    assert.equal(auth.verifyMfa({ userId: login.userId, code: "000000" }).error, "invalid MFA code");
    // valid code -> token issued
    const ok = auth.verifyMfa({ userId: login.userId, code: totp(enrolled.secret) });
    assert.ok(ok.token, "token issued after valid MFA");
    assert.equal(auth.authenticate(ok.token).user.email, "admin@test.com");

    // disable works with current code
    assert.ok(auth.disableMfa(me.id, totp(enrolled.secret)).ok);
  });

  it("login without MFA enabled still works directly", () => {
    const { auth } = app();
    const s = auth.login({ email: "admin@test.com", password: "SuperSecret123" });
    assert.ok(s.token);
    assert.equal(s.pendingMfa, undefined);
  });
});