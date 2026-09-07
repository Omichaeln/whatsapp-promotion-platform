import crypto from "node:crypto";
import { scryptHash, scryptVerify, id, nowIso } from "./db.mjs";
import { generateSecret, verifyTotp, otpauthUri } from "./mfa.mjs";

/**
 * Named admin identity + RBAC (G-12). No shared production account. Tokens are
 * stored as sha256 hashes; roles are checked server-side on every route.
 */
export const ROLES = {
  CAMPAIGN_MANAGER: "campaign_manager",
  REVIEWER: "reviewer",
  DRAW_OFFICER: "draw_officer",
  DRAW_APPROVER: "draw_approver",
  WINNER_OPS: "winner_ops",
  SUPPORT: "support",
  AUDITOR: "auditor",
  PLATFORM_ADMIN: "platform_admin",
};

export function createAuth(db, { secret, now = nowIso, bootstrap = null } = {}) {
  const hashToken = (t) => crypto.createHash("sha256").update(t).digest().toString("hex");

  const getUserByEmail = db.prepare(`select * from admin_users where email = ?`);
  const getUser = db.prepare(`select id, email, name, mfa_enabled, roles, status from admin_users where id = ?`);
  const getMfaFull = db.prepare(`select id, mfa_secret, mfa_enabled from admin_users where id = ?`);
  const insertToken = db.prepare(`insert into auth_tokens (id, token_hash, admin_user_id, expires_at, created_at) values (?,?,?,?,?)`);
  const getToken = db.prepare(`select * from auth_tokens where token_hash = ?`);
  const revokeToken = db.prepare(`update auth_tokens set revoked_at=? where id=? and revoked_at is null`);
  const insertUser = db.prepare(`insert into admin_users (id, email, name, password_hash, roles, status, created_at, updated_at) values (?,?,?,?,?,?,?,?)`);
  const setMfaSecret = db.prepare(`update admin_users set mfa_secret=?, mfa_enabled=?, updated_at=? where id=?`);
  const setLastLogin = db.prepare(`update admin_users set last_login_at=? where id=?`);

  // --- MFA login challenge store (in-memory; tokens only issued after code) ---
  const pendingMfa = new Map(); // userId -> { expiresAt, consumed }

  const issueToken = (userId, remember) => {
    const token = crypto.randomBytes(32).toString("hex");
    const ttl = remember ? 30 * 24 * 3600 : 12 * 3600;
    insertToken.run(id("tok"), hashToken(token), userId, new Date(Date.now() + ttl * 1000).toISOString(), nowIso());
    setLastLogin.run(nowIso(), userId);
    return token;
  };

  // Bootstrap the first platform admin (fail-closed: no shared password).
  if (bootstrap && !getUserByEmail.get(bootstrap.email)) {
    const { salt, hash } = scryptHash(bootstrap.password);
    insertUser.run(id("adm"), bootstrap.email, bootstrap.name || "Platform Admin", `${salt}:${hash}`,
      JSON.stringify([ROLES.PLATFORM_ADMIN]), "active", nowIso(), nowIso());
  }

  return {
    /** Login -> { token, user } or { pendingMfa: true, userId, message }.
     *  When MFA is enabled, NO token is issued until verifyMfa(). */
    login({ email, password, remember = false }) {
      const row = getUserByEmail.get(String(email).toLowerCase().trim());
      if (!row || row.status !== "active") return null;
      const [salt, hash] = row.password_hash.split(":");
      if (!scryptVerify(password, salt, hash)) return null;
      if (row.mfa_enabled) {
        pendingMfa.set(row.id, { expiresAt: Date.now() + 5 * 60 * 1000, consumed: false });
        return { pendingMfa: true, userId: row.id, message: "MFA code required" };
      }
      const token = issueToken(row.id, remember);
      return { token, user: getUser.get(row.id) };
    },
    /** Verify the MFA code for a user with a pending challenge, then issue token. */
    verifyMfa({ userId, code, remember = false }) {
      const pending = pendingMfa.get(userId);
      if (!pending || pending.consumed || pending.expiresAt < Date.now()) {
        return { error: "no pending MFA login challenge (sign in again)" };
      }
      const mfa = getMfaFull.get(userId);
      if (!mfa?.mfa_secret || !verifyTotp(mfa.mfa_secret, code)) {
        return { error: "invalid MFA code" };
      }
      pendingMfa.delete(userId);
      const token = issueToken(userId, remember);
      return { token, user: getUser.get(userId) };
    },
    /** Enroll: generate a fresh secret for a user (platform_admin). */
    enrollMfa(adminUserId) {
      const secret = generateSecret();
      setMfaSecret.run(secret, 0, nowIso(), adminUserId); // not enabled until verified
      const label = `${getUser.get(adminUserId)?.email || "admin"}@WhatsApp`;
      return { secret, otpauth: otpauthUri(secret, { label }) };
    },
    /** Enable MFA: code must verify against the stored secret. */
    enableMfa(adminUserId, code) {
      const mfa = getMfaFull.get(adminUserId);
      if (!mfa?.mfa_secret) return { error: "enroll first" };
      if (!verifyTotp(mfa.mfa_secret, code)) return { error: "invalid MFA code" };
      setMfaSecret.run(mfa.mfa_secret, 1, nowIso(), adminUserId);
      return { ok: true };
    },
    /** Disable MFA: code must verify (requires the current authenticator). */
    disableMfa(adminUserId, code) {
      const mfa = getMfaFull.get(adminUserId);
      if (!mfa?.mfa_secret) return { error: "MFA not configured" };
      if (!verifyTotp(mfa.mfa_secret, code)) return { error: "invalid MFA code" };
      setMfaSecret.run(mfa.mfa_secret, 0, nowIso(), adminUserId);
      return { ok: true };
    },
    /** { user, expiresAt } | null */
    authenticate(bearer) {
      if (!/^[A-Za-z0-9+/=]{32,}$/.test(bearer || "")) return null;
      const row = getToken.get(hashToken(bearer));
      if (!row || row.revoked_at) return null;
      if (new Date(row.expires_at) < new Date()) return null;
      return { token: row, user: getUser.get(row.admin_user_id) };
    },
    revoke(bearer) {
      const row = getToken.get(hashToken(bearer));
      if (row) revokeToken.run(nowIso(), row.id);
    },
    hasRole(user, ...roles) {
      if (!user) return false;
      const have = JSON.parse(user.roles || "[]");
      if (have.includes(ROLES.PLATFORM_ADMIN)) return true;
      return roles.some((r) => have.includes(r));
    },
    createUser({ email, name, password, roles = [] }) {
      email = String(email).toLowerCase().trim();
      if (getUserByEmail.get(email)) throw new Error("user exists");
      const uid = id("adm");
      const { salt, hash } = scryptHash(password);
      insertUser.run(uid, email, name || email, `${salt}:${hash}`, JSON.stringify(roles), "active", nowIso(), nowIso());
      return getUser.get(uid);
    },
    getUser: (uid) => getUser.get(uid),
    revokeAll(email) {
      const u = getUserByEmail.get(String(email).toLowerCase().trim());
      if (u) db.prepare(`update auth_tokens set revoked_at=? where admin_user_id=? and revoked_at is null`).run(nowIso(), u.id);
    },
  };
}