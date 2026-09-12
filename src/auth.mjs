import crypto from "node:crypto";
import { scryptHash, scryptVerify, id, nowIso } from "./db.mjs";
import { generateSecret, verifyTotp, otpauthUri } from "./mfa.mjs";

/**
 * Named staff identity + RBAC (spec §13, §17). Tokens stored as SHA-256
 * hashes; roles checked server-side on every route. platform_admin is a
 * TECHNICAL role: it manages users, configuration and integrations but does
 * NOT imply draw, approval, review or prize authority (§5.8, §13).
 */
export const ROLES = {
  CAMPAIGN_MANAGER: "campaign_manager", REVIEWER: "reviewer", DRAW_OFFICER: "draw_officer", DRAW_APPROVER: "draw_approver",
  WINNER_OPS: "winner_ops", SUPPORT: "support", AUDITOR: "auditor", PLATFORM_ADMIN: "platform_admin",
};
export const ALL_ROLES = Object.values(ROLES);
/** Roles implied by platform_admin (technical administration only). */
const ADMIN_IMPLIES = new Set([ROLES.PLATFORM_ADMIN, ROLES.CAMPAIGN_MANAGER, ROLES.SUPPORT, ROLES.AUDITOR]);

export function createAuth(db, { now = nowIso, bootstrap = null, audit = null } = {}) {
  const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
  const getUserByEmail = db.prepare(`select * from admin_users where email = ?`);
  const getUser = db.prepare(`select id, email, name, mfa_enabled, roles, status, must_change_password, last_login_at, created_at from admin_users where id = ?`);
  const getMfaFull = db.prepare(`select id, mfa_secret, mfa_pending_secret, mfa_enabled from admin_users where id = ?`);
  const insertToken = db.prepare(`insert into auth_tokens (id, token_hash, admin_user_id, expires_at, created_at) values (?,?,?,?,?)`);
  const getToken = db.prepare(`select * from auth_tokens where token_hash = ?`);
  const pendingMfa = new Map();
  const issueToken = (userId, remember) => {
    const token = crypto.randomBytes(32).toString("hex");
    insertToken.run(id("tok"), hashToken(token), userId, new Date(Date.now() + (remember ? 30 * 24 : 12) * 3600_000).toISOString(), now());
    db.prepare(`update admin_users set last_login_at=? where id=?`).run(now(), userId);
    return token;
  };
  if (bootstrap && !getUserByEmail.get(bootstrap.email)) {
    const { salt, hash } = scryptHash(bootstrap.password);
    db.prepare(`insert into admin_users (id, email, name, password_hash, roles, status, created_at, updated_at, must_change_password, created_by) values (?,?,?,?,?,?,?,?,?,?)`)
      .run(id("adm"), bootstrap.email, bootstrap.name || "Platform Admin", `${salt}:${hash}`, JSON.stringify([ROLES.PLATFORM_ADMIN]), "active", now(), now(), 0, "bootstrap");
  }
  const strong = (pw) => typeof pw === "string" && pw.length >= 12;

  return {
    login({ email, password, remember = false }) {
      const row = getUserByEmail.get(String(email || "").toLowerCase().trim());
      if (!row || row.status !== "active") return null;
      const [salt, hash] = row.password_hash.split(":");
      if (!scryptVerify(password, salt, hash)) return null;
      if (row.mfa_enabled) { pendingMfa.set(row.id, { expiresAt: Date.now() + 5 * 60 * 1000 }); return { pendingMfa: true, userId: row.id, message: "MFA code required" }; }
      return { token: issueToken(row.id, remember), user: getUser.get(row.id) };
    },
    verifyMfa({ userId, code, remember = false }) {
      const pending = pendingMfa.get(userId);
      if (!pending || pending.expiresAt < Date.now()) return { error: "no pending MFA login challenge (sign in again)" };
      const mfa = getMfaFull.get(userId);
      if (!mfa?.mfa_secret || !verifyTotp(mfa.mfa_secret, code)) return { error: "invalid MFA code" };
      pendingMfa.delete(userId);
      return { token: issueToken(userId, remember), user: getUser.get(userId) };
    },
    /**
     * Enrol an authenticator. The new secret is held PENDING until enableMfa
     * confirms it.
     *
     * This used to overwrite the live secret and set mfa_enabled=0
     * unconditionally, so a single POST /api/mfa/enroll with no code, no
     * password and no audit row turned a staff account's second factor off —
     * making the TOTP code that /api/mfa/disable demands pointless — and the
     * far more ordinary case, a user re-opening the enrol screen to re-scan the
     * QR, silently disabled their own MFA. Re-enrolling while MFA is on now
     * requires a current code (or a deliberate, audited /api/mfa/disable), and
     * the live factor is never cleared as a side effect.
     */
    enrollMfa(userId, code = null) {
      const m = getMfaFull.get(userId);
      if (!m) throw Object.assign(new Error("user not found"), { code: "NOT_FOUND" });
      if (m.mfa_enabled && !verifyTotp(m.mfa_secret || "", code)) throw Object.assign(new Error("MFA is already enabled: supply a current MFA code to re-enrol, or disable MFA first"), { code: "CONFLICT" });
      const secret = generateSecret();
      db.prepare(`update admin_users set mfa_pending_secret=?, updated_at=? where id=?`).run(secret, now(), userId);
      audit?.({ actorType: "admin", actorId: userId, action: "staff.mfa_enroll", targetType: "admin_user", targetId: userId, payload: { reEnrol: !!m.mfa_enabled } });
      return { secret, otpauth: otpauthUri(secret, { label: `${getUser.get(userId)?.email || "staff"}@PromoVault` }) };
    },
    enableMfa(userId, code) { const m = getMfaFull.get(userId); const secret = m?.mfa_pending_secret || m?.mfa_secret; if (!secret) return { error: "enroll first" }; if (!verifyTotp(secret, code)) return { error: "invalid MFA code" }; db.prepare(`update admin_users set mfa_secret=?, mfa_pending_secret=null, mfa_enabled=1, updated_at=? where id=?`).run(secret, now(), userId); return { ok: true }; },
    disableMfa(userId, code) { const m = getMfaFull.get(userId); if (!m?.mfa_secret) return { error: "MFA not configured" }; if (!verifyTotp(m.mfa_secret, code)) return { error: "invalid MFA code" }; db.prepare(`update admin_users set mfa_enabled=0, updated_at=? where id=?`).run(now(), userId); return { ok: true }; },
    authenticate(bearer) {
      if (!/^[A-Fa-f0-9]{64}$/.test(bearer || "")) return null;
      const row = getToken.get(hashToken(bearer));
      if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
      const user = getUser.get(row.admin_user_id);
      if (!user || user.status !== "active") return null;
      return { token: row, user };
    },
    revoke(bearer) { const row = getToken.get(hashToken(bearer)); if (row) db.prepare(`update auth_tokens set revoked_at=? where id=? and revoked_at is null`).run(now(), row.id); },
    revokeAllForUser(userId) { db.prepare(`update auth_tokens set revoked_at=? where admin_user_id=? and revoked_at is null`).run(now(), userId); },
    hasRole(user, ...roles) {
      if (!user) return false;
      const have = JSON.parse(user.roles || "[]");
      return roles.some((r) => have.includes(r) || (have.includes(ROLES.PLATFORM_ADMIN) && ADMIN_IMPLIES.has(r)));
    },
    roles: (user) => JSON.parse(user?.roles || "[]"),
    /** Create a named account with a temporary password that must be changed at first login. */
    createUser({ email, name, password, roles = [], createdBy = "system", mustChangePassword = true }) {
      email = String(email || "").toLowerCase().trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("valid email required"), { code: "VALIDATION" });
      if (getUserByEmail.get(email)) throw Object.assign(new Error("user exists"), { code: "CONFLICT" });
      const bad = roles.filter((r) => !ALL_ROLES.includes(r)); if (bad.length) throw Object.assign(new Error(`unknown roles: ${bad.join(",")}`), { code: "VALIDATION" });
      const pw = password || crypto.randomBytes(9).toString("base64url");
      if (!strong(pw)) throw Object.assign(new Error("password must be at least 12 characters"), { code: "VALIDATION" });
      const uid = id("adm"); const { salt, hash } = scryptHash(pw);
      db.prepare(`insert into admin_users (id, email, name, password_hash, roles, status, created_at, updated_at, must_change_password, created_by) values (?,?,?,?,?,?,?,?,?,?)`).run(uid, email, name || email, `${salt}:${hash}`, JSON.stringify(roles), "active", now(), now(), mustChangePassword ? 1 : 0, createdBy);
      audit?.({ actorType: "admin", actorId: createdBy, action: "staff.create", targetType: "admin_user", targetId: uid, payload: { email, roles } });
      return { user: getUser.get(uid), temporaryPassword: password ? null : pw };
    },
    updateUser(uid, { roles, status, name }, actorId) {
      const u = getUser.get(uid); if (!u) throw Object.assign(new Error("user not found"), { code: "NOT_FOUND" });
      if (roles) { const bad = roles.filter((r) => !ALL_ROLES.includes(r)); if (bad.length) throw Object.assign(new Error(`unknown roles: ${bad.join(",")}`), { code: "VALIDATION" }); }
      db.prepare(`update admin_users set roles=?, status=?, name=?, updated_at=?, roles_version=roles_version+1 where id=?`).run(JSON.stringify(roles || JSON.parse(u.roles)), status || u.status, name || u.name, now(), uid);
      if (roles || (status && status !== "active")) this.revokeAllForUser(uid); // privilege change revokes sessions
      audit?.({ actorType: "admin", actorId, action: "staff.update", targetType: "admin_user", targetId: uid, payload: { roles, status } });
      return getUser.get(uid);
    },
    changePassword(uid, { currentPassword, newPassword }) {
      const row = db.prepare(`select * from admin_users where id=?`).get(uid); if (!row) return { error: "not found" };
      const [salt, hash] = row.password_hash.split(":");
      if (!scryptVerify(currentPassword || "", salt, hash)) return { error: "current password incorrect" };
      if (!strong(newPassword)) return { error: "new password must be at least 12 characters" };
      const n = scryptHash(newPassword);
      db.prepare(`update admin_users set password_hash=?, must_change_password=0, updated_at=? where id=?`).run(`${n.salt}:${n.hash}`, now(), uid);
      this.revokeAllForUser(uid);
      return { ok: true };
    },
    resetPassword(uid, actorId) {
      const pw = crypto.randomBytes(9).toString("base64url"); const n = scryptHash(pw);
      db.prepare(`update admin_users set password_hash=?, must_change_password=1, updated_at=? where id=?`).run(`${n.salt}:${n.hash}`, now(), uid);
      this.revokeAllForUser(uid);
      audit?.({ actorType: "admin", actorId, action: "staff.password_reset", targetType: "admin_user", targetId: uid });
      return { temporaryPassword: pw };
    },
    getUser: (uid) => getUser.get(uid),
    listUsers: () => db.prepare(`select id, email, name, mfa_enabled, roles, status, must_change_password, last_login_at, created_at from admin_users order by created_at`).all(),
    revokeAll(email) { const u = getUserByEmail.get(String(email).toLowerCase().trim()); if (u) this.revokeAllForUser(u.id); },
  };
}
