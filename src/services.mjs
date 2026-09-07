import crypto from "node:crypto";
import { id, tx, nowIso, normalizePhone } from "./db.mjs";

/**
 * Campaign + participant + consent + conversation session domain operations
 * (G-04, G-05). Server-enforced authorization is applied in the HTTP layer.
 */
export function createDomain(db, identityKey = "dev-only-key", now = nowIso) {
  const sha256hex = (s) => crypto.createHash("sha256").update(s).digest().toString("hex");

  // ---- prepared statements ------------------------------------------------
  const insertCampaign = db.prepare(
    `insert into campaigns (id, code, name, status, timezone, start_at, end_at, draw_config_json, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?)`);
  const getCampaign = db.prepare(`select * from campaigns where id = ?`);
  const listCampaigns = db.prepare(`select * from campaigns order by created_at`);
  const setCampaignStatus = db.prepare(`update campaigns set status=?, updated_at=? where id=?`);

  const insertVersion = db.prepare(
    `insert into campaign_versions (id, campaign_id, version_no, status, content_json, rules_json, flags_json, config_hash)
     values (?,?,?,?,?,?,?,?)`);
  const getVersion = db.prepare(`select * from campaign_versions where id = ?`);
  const listVersions = db.prepare(`select * from campaign_versions where campaign_id = ? order by version_no`);
  const getActiveVersion = db.prepare(
    `select * from campaign_versions where campaign_id=? and status='activated' order by version_no desc limit 1`);
  const activateVersion = db.prepare(
    `update campaign_versions set status='activated', frozen_at=?, frozen_by=? where campaign_id=? and id=? and status='draft'`);
  const deactivateOthers = db.prepare(
    `update campaign_versions set status='retired' where campaign_id=? and id<>? and status='activated'`);

  const allOutlets = db.prepare(`select * from outlets order by retailer, town`);
  const getOutlet = db.prepare(`select * from outlets where id = ?`);
  const allProducts = db.prepare(`select * from products where active = 1`);
  const insertOutlet = db.prepare(
    `insert into outlets (id, outlet_code, retailer, branch, town, province, collection_enabled, active_from, active_to)
     values (?,?,?,?,?,?,?,?,?)
     on conflict(outlet_code) do update set retailer=excluded.retailer, branch=excluded.branch, town=excluded.town,
       province=excluded.province, collection_enabled=excluded.collection_enabled, active_from=excluded.active_from, active_to=excluded.active_to`);
  const insertProduct = db.prepare(
    `insert into products (id, sku, brand, name, aliases_json, pack_weight_kg, unit, active)
     values (?,?,?,?,?,?,?,?)
     on conflict(sku) do update set brand=excluded.brand, name=excluded.name, aliases_json=excluded.aliases_json,
       pack_weight_kg=excluded.pack_weight_kg, unit=excluded.unit, active=excluded.active`);

  const getParticipantByPhone = db.prepare(`select * from participants where wa_phone_uid = ?`);
  const getParticipant = db.prepare(`select * from participants where id = ?`);
  const insertParticipant = db.prepare(
    `insert into participants (id, wa_phone_uid, first_name, surname, identity_enc, identity_masked, identity_hash,
       location, age_confirmed, status, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateParticipantProfile = db.prepare(
    `update participants set first_name=?, surname=?, location=?, updated_at=? where wa_phone_uid=?`);

  const insertConsent = db.prepare(
    `insert into consents (id, participant_id, terms_version, privacy_version, channel, accepted_at) values (?,?,?,?,?,?)`);
  const withdrawConsent = db.prepare(
    `update consents set withdrawn_at=? where participant_id=? and withdrawn_at is null`);

  const getSession = db.prepare(`select * from conversation_sessions where campaign_id=? and wa_phone_uid=?`);
  const upsertSession = db.prepare(
    `insert into conversation_sessions (id, campaign_id, wa_phone_uid, participant_id, state, context_json, updated_at, expires_at)
     values (?,?,?,?,?,?,?,?)
     on conflict(campaign_id, wa_phone_uid) do update set
       participant_id=excluded.participant_id, state=excluded.state, context_json=excluded.context_json,
       updated_at=excluded.updated_at, expires_at=excluded.expires_at`);

  const countWeeklyEntries = db.prepare(
    `select count(*) as n from entries where participant_id=? and campaign_id=? and created_at >= ?`);
  const lastAuditHash = db.prepare(`select entry_hash from audit_events order by id desc limit 1`);
  const insertAudit = db.prepare(
    `insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id,
       prev_hash, entry_hash, payload_json, created_at) values (?,?,?,?,?,?,?,?,?,?,?)`);

  // ---- helpers -------------------------------------------------------------
  let auditSeq = { prev: "" };
  function audit({ actorType = "admin", actorId, action, targetType, targetId, reason, requestId, payload }) {
    const prev = auditSeq.prev || lastAuditHash.get()?.entry_hash || "";
    const body = JSON.stringify({ action, targetType, targetId, payload: payload ?? null, when: now() });
    const entryHash = crypto.createHash("sha256").update(prev + body).digest().toString("hex");
    insertAudit.run(actorType, actorId, action, targetType, targetId, reason || null, requestId || null, prev, entryHash, body, now());
    auditSeq.prev = entryHash;
  }
  function weekStartIso() {
    const d = new Date();
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  function encryptIdentity(v) {
    const k = crypto.createHash("sha256").update(identityKey).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", k, iv);
    const enc = Buffer.concat([c.update(String(v), "utf8"), c.final()]);
    return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
  }
  function maskIdentity(v) {
    const s = String(v);
    return s.length > 8 ? s.slice(0, 3) + "******" + s.slice(-3) : "******";
  }

  // ---- campaigns ------------------------------------------------------------
  return {
    createCampaign({ code, name, startAt, endAt, timezone = "Africa/Harare", drawConfig = {} }) {
      const cid = id("cmp");
      insertCampaign.run(cid, code, name, "draft", timezone, startAt, endAt, JSON.stringify(drawConfig), now(), now());
      audit({ actorId: "system", action: "campaign.create", targetType: "campaign", targetId: cid });
      return getCampaign.get(cid);
    },
    getCampaign: (cid) => getCampaign.get(cid),
    listCampaigns: () => listCampaigns.all(),
    setCampaignStatus(cid, status, actorId) {
      setCampaignStatus.run(status, now(), cid);
      audit({ actorId, action: `campaign.${status}`, targetType: "campaign", targetId: cid });
    },
    createVersion(campaignId, { content = {}, rules = {}, flags = {} }) {
      const existing = listVersions.all(campaignId);
      const videoNo = existing.length + 1;
      const vid = id("cv");
      const configHash = crypto.createHash("sha256").update(JSON.stringify({ content, rules, flags })).digest().toString("hex");
      insertVersion.run(vid, campaignId, videoNo, "draft", JSON.stringify(content), JSON.stringify(rules), JSON.stringify(flags), configHash);
      return vid;
    },
    getVersion,
    listVersions: (cid) => listVersions.all(cid),
    getActiveVersion: (cid) => getActiveVersion.get(cid),
    activateVersion(campaignId, versionId, actor) {
      // P1-03: verify the target exists and is a draft FIRST — never retire the
      // current active version before we know the swap can succeed.
      const target = getVersion.get(versionId);
      if (!target) throw new Error("version not found");
      if (target.campaign_id !== campaignId) throw new Error("version does not belong to campaign");
      if (target.status !== "draft") throw new Error(`only draft versions can be activated (status=${target.status})`);
      const out = tx(db, () => {
        deactivateOthers.run(campaignId, versionId);
        const changed = activateVersion.run(now(), actor, campaignId, versionId);
        if (changed.changes === 0) throw new Error("version could not be activated");
        audit({ actorId: actor, action: "campaign.version.activate", targetType: "campaign_version", targetId: versionId, payload: { campaignId } });
        return getVersion.get(versionId);
      });
      return out;
    },

    // ---- outlets & products ---------------------------------------------------
    listOutlets: () => allOutlets.all(),
    getOutlet: (oid) => getOutlet.get(oid),
    upsertOutlet(o) {
      const oid = o.id || `out_${o.outlet_code}`;
      insertOutlet.run(oid, o.outlet_code, o.retailer, o.branch || o.retailer, o.town, o.province,
        Number(o.collection_enabled ?? 1), o.active_from || "1970-01-01", o.active_to || "9999-12-31");
      return getOutlet.get(oid);
    },
    listProducts: () => allProducts.all(),
    upsertProduct(p) {
      const pid = p.id || `prod_${p.sku}`;
      insertProduct.run(pid, p.sku, p.brand, p.name, JSON.stringify(p.aliases || []), Number(p.pack_weight_kg), p.unit || "pack", 1);
      return pid;
    },

    // ---- participants & consent -------------------------------------------------------
    getParticipantByPhone: (phoneUid) => getParticipantByPhone.get(phoneUid),
    getParticipant: (pid) => getParticipant.get(pid),
    registerParticipant({ phoneUid, firstName, surname, identity, location, ageConfirmed = true, termsVersion, privacyVersion, channel = "whatsapp" }) {
      phoneUid = normalizePhone(phoneUid) || phoneUid;
      return tx(db, () => {
        const existing = getParticipantByPhone.get(phoneUid);
        if (existing) {
          if (existing.status !== "active") throw new Error("participant not active");
          updateParticipantProfile.run(firstName, surname, location, now(), phoneUid);
          return { participant: getParticipantByPhone.get(phoneUid), created: false };
        }
        const pid = id("ptc");
        const identityEnc = identity ? encryptIdentity(identity) : null;
        insertParticipant.run(pid, phoneUid, firstName, surname, identityEnc, identity ? maskIdentity(identity) : null,
          identity ? sha256hex(phoneUid + identity) : null, location, ageConfirmed ? 1 : 0, "active", now(), now());
        insertConsent.run(id("con"), pid, termsVersion, privacyVersion, channel, now());
        audit({ actorId: pid, action: "participant.register", targetType: "participant", targetId: pid, payload: { phone: String(phoneUid).slice(-4) } });
        return { participant: getParticipant.get(pid), created: true };
      });
    },
    withdrawParticipant(phoneUid) {
      tx(db, () => {
        const p = getParticipantByPhone.get(phoneUid);
        if (!p) return;
        withdrawConsent.run(now(), p.id);
        db.prepare(`update participants set status='withdrawn', updated_at=? where id=?`).run(now(), p.id);
        audit({ actorId: p.id, action: "participant.withdraw", targetType: "participant", targetId: p.id });
      });
    },

    // ---- sessions -------------------------------------------------------------
    getSession: (campaignId, phoneUid) => getSession.get(campaignId, phoneUid),
    setSession(campaignId, phoneUid, { state, context, participantId, ttlMinutes = 60 * 24 }) {
      const prev = getSession.get(campaignId, phoneUid);
      const ctx = context !== undefined ? context : JSON.parse(prev?.context_json || "{}");
      upsertSession.run(
        prev?.id || id("ses"), campaignId, phoneUid, participantId ?? (prev?.participant_id ?? null),
        state ?? prev?.state ?? null, JSON.stringify(ctx), now(),
        new Date(Date.parse(now()) + ttlMinutes * 60_000).toISOString());
    },

    // ---- misc ---------------------------------------------------------------
    countWeeklyEntries: (participantId, campaignId) => countWeeklyEntries.get(participantId, campaignId, weekStartIso()).n,
    audit,
    lastAudit: () => lastAuditHash.get()?.entry_hash || "",
  };
}

export { id, tx, nowIso };