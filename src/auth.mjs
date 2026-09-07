import crypto from "node:crypto";
import { scryptHash, scryptVerify, id, nowIso } from "./db.mjs";

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
  const insertToken = db.prepare(`insert into auth_tokens (id, token_hash, admin_user_id, expires_at, created_at) values (?,?,?,?,?)`);
  const getToken = db.prepare(`select * from auth_tokens where token_hash = ?`);
  const revokeToken = db.prepare(`update auth_tokens set revoked_at=? where id=? and revoked_at is null`);
  const insertUser = db.prepare(`insert into admin_users (id, email, name, password_hash, roles, status, created_at, updated_at) values (?,?,?,?,?,?,?,?)`);

  // Bootstrap the first platform admin (fail-closed: no shared password).
  if (bootstrap && !getUserByEmail.get(bootstrap.email)) {
    const { salt, hash } = scryptHash(bootstrap.password);
    insertUser.run(id("adm"), bootstrap.email, bootstrap.name || "Platform Admin", `${salt}:${hash}`,
      JSON.stringify([ROLES.PLATFORM_ADMIN]), "active", nowIso(), nowIso());
  }

  return {
    /** Login -> { token, user } or null. */
    login({ email, password, remember = false }) {
      const row = getUserByEmail.get(String(email).toLowerCase().trim());
      if (!row || row.status !== "active") return null;
      const [salt, hash] = row.password_hash.split(":");
      if (!scryptVerify(password, salt, hash)) return null;
      const token = crypto.randomBytes(32).toString("hex");
      const ttl = remember ? 30 * 24 * 3600 : 12 * 3600;
      insertToken.run(id("tok"), hashToken(token), row.id, new Date(Date.now() + ttl * 1000).toISOString(), nowIso());
      db.prepare(`update admin_users set last_login_at=? where id=?`).run(nowIso(), row.id);
      return { token, user: getUser.get(row.id) };
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