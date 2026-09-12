import crypto from "node:crypto";
import { id, tx, nowIso, normalizePhone, jsonHash } from "./db.mjs";
import { createAudit } from "./audit.mjs";
import { defaultRules } from "./eligibility.mjs";

/**
 * Domain services: campaign (versions, periods, outlets, products, content,
 * decisions), participant (profile, enrollment, consent, identity
 * protection), conversation sessions (versioned), staff. Authorisation is
 * enforced in the HTTP layer; these services enforce invariants.
 */
export function createDomain(db, identityKey = "dev-only-key", now = nowIso, { checkpointKey = "", retention = { rawReceiptsDays: 90, factsDays: 180 } } = {}) {
  const audit = createAudit(db, { checkpointKey, now });
  const A = (args) => audit.record(args);

  // ---- prepared statements ------------------------------------------------
  const getCampaign = db.prepare(`select * from campaigns where id = ?`);
  const getCampaignByCode = db.prepare(`select * from campaigns where code = ?`);
  const listCampaigns = db.prepare(`select * from campaigns order by created_at`);
  const getVersion = db.prepare(`select * from campaign_versions where id = ?`);
  const listVersions = db.prepare(`select * from campaign_versions where campaign_id = ? order by version_no`);
  const getActiveVersion = db.prepare(`select * from campaign_versions where campaign_id=? and status='activated' order by version_no desc limit 1`);
  const allOutlets = db.prepare(`select * from outlets order by retailer, town, branch`);
  const getOutlet = db.prepare(`select * from outlets where id = ?`);
  const getOutletByCode = db.prepare(`select * from outlets where outlet_code = ?`);
  const campaignOutlets = db.prepare(`select o.*, co.collection_enabled as campaign_collection_enabled, co.active_from as member_from, co.active_to as member_to from outlets o join campaign_outlets co on co.outlet_id = o.id where co.campaign_id = ? and o.active = 1 order by o.retailer, o.town, o.branch`);
  const allProducts = db.prepare(`select * from products where active = 1 order by brand, name`);
  const getProductBySku = db.prepare(`select * from products where sku = ?`);
  const getParticipantByPhone = db.prepare(`select * from participants where wa_phone_uid = ?`);
  const getParticipant = db.prepare(`select * from participants where id = ?`);
  const getEnrollment = db.prepare(`select * from campaign_enrollments where participant_id = ? and campaign_id = ?`);
  const getSession = db.prepare(`select * from conversation_sessions where campaign_id=? and wa_phone_uid=?`);
  const listPeriods = db.prepare(`select * from campaign_periods where campaign_id = ? order by starts_at`);
  const getPeriod = db.prepare(`select * from campaign_periods where id = ?`);
  const getPeriodByCode = db.prepare(`select * from campaign_periods where campaign_id = ? and code = ?`);

  // ---- helpers -------------------------------------------------------------
  const key32 = crypto.createHash("sha256").update(identityKey).digest();
  function encryptIdentity(v) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key32, iv);
    const enc = Buffer.concat([c.update(String(v), "utf8"), c.final()]);
    return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
  }
  function decryptIdentity(blob) {
    const [ivh, tagh, ench] = String(blob).split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", key32, Buffer.from(ivh, "hex"));
    d.setAuthTag(Buffer.from(tagh, "hex"));
    return Buffer.concat([d.update(Buffer.from(ench, "hex")), d.final()]).toString("utf8");
  }
  const normIdentity = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  /** Keyed fingerprint for equality checks (never a plain guessable hash). */
  const identityFingerprint = (v) => crypto.createHmac("sha256", key32).update(`identity:${normIdentity(v)}`).digest("hex");
  const maskIdentity = (v) => { const s = normIdentity(v); return s.length > 6 ? s.slice(0, 2) + "*".repeat(s.length - 4) + s.slice(-2) : "******"; };
  const maskPhone = (p) => p ? `***${String(p).slice(-4)}` : null;

  function nextVersionNo(campaignId) { return listVersions.all(campaignId).length + 1; }

  /**
   * Master-data fields whose before/after must be recoverable from the audit
   * chain. An outlet edit decides who can enter and who can collect: `active`
   * drops the outlet out of listCampaignOutlets (so every in-flight receipt for
   * that branch is decided outlet_not_participating), `collection_enabled`
   * gates prize collection and `aliases_json` feeds merchant matching. A single
   * POST used to change all of that with nothing in audit_events naming who did
   * it, when, or what the value had been.
   */
  const OUTLET_AUDITED = ["outlet_code", "retailer", "branch", "town", "province", "collection_enabled", "active_from", "active_to", "aliases_json", "active", "retailer_code"];
  const PRODUCT_AUDITED = ["sku", "brand", "name", "aliases_json", "pack_weight_kg", "unit", "active", "pack_grams", "product_code"];
  const pickFields = (row, keys) => (row ? Object.fromEntries(keys.map((k) => [k, row[k] ?? null])) : null);
  const changedFields = (before, after) => (before ? Object.keys(after).filter((k) => String(before[k] ?? "") !== String(after[k] ?? "")) : Object.keys(after));

  const domain = {
    audit: A, auditService: audit, maskPhone, maskIdentity, identityFingerprint,

    // ---- campaigns ------------------------------------------------------------
    createCampaign({ code, name, startAt, endAt, timezone = "Africa/Harare", drawConfig = {}, actorId = "system", status = "draft" }) {
      const cid = id("cmp");
      db.prepare(`insert into campaigns (id, code, name, status, timezone, start_at, end_at, draw_config_json, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)`)
        .run(cid, code, name, status, timezone, startAt, endAt, JSON.stringify(drawConfig), now(), now());
      A({ actorType: "admin", actorId, action: "campaign.create", targetType: "campaign", targetId: cid, payload: { code, name } });
      return getCampaign.get(cid);
    },
    getCampaign: (cid) => getCampaign.get(cid),
    getCampaignByCode: (code) => getCampaignByCode.get(code),
    listCampaigns: () => listCampaigns.all(),
    updateCampaign(cid, { name, startAt, endAt, timezone, drawConfig }, actorId) {
      const c = getCampaign.get(cid); if (!c) throw new Error("campaign not found");
      if (["closed", "archived"].includes(c.status)) throw new Error(`campaign is ${c.status}`);
      db.prepare(`update campaigns set name=?, start_at=?, end_at=?, timezone=?, draw_config_json=?, updated_at=? where id=?`)
        .run(name ?? c.name, startAt ?? c.start_at, endAt ?? c.end_at, timezone ?? c.timezone, JSON.stringify(drawConfig ?? JSON.parse(c.draw_config_json || "{}")), now(), cid);
      A({ actorType: "admin", actorId, action: "campaign.update", targetType: "campaign", targetId: cid, payload: { name, startAt, endAt, timezone } });
      return getCampaign.get(cid);
    },
    /** Status transitions: draft->active (requires activated version), active<->paused, active|paused->closed, closed->archived. */
    setCampaignStatus(cid, status, actorId, reason = null) {
      const c = getCampaign.get(cid); if (!c) throw new Error("campaign not found");
      const allowed = { draft: ["active"], active: ["paused", "closed"], paused: ["active", "closed"], closed: ["archived"], archived: [] };
      if (!allowed[c.status]?.includes(status)) throw new Error(`cannot move campaign from ${c.status} to ${status}`);
      if (status === "active" && !getActiveVersion.get(cid)) throw new Error("activate a campaign version first");
      db.prepare(`update campaigns set status=?, updated_at=? where id=?`).run(status, now(), cid);
      A({ actorType: "admin", actorId, action: `campaign.${status}`, targetType: "campaign", targetId: cid, reason });
      return getCampaign.get(cid);
    },
    /** Pause semantics are separate flags in settings (intake, auto-qualify, outbound, draws). */
    getPauseFlags(cid) { return domain.getSetting(`campaign:${cid}:pause`, { intake: false, auto_qualify: false, outbound: false, draws: false }); },
    setPauseFlags(cid, flags, actorId) {
      const cur = domain.getPauseFlags(cid); const next = { ...cur, ...flags };
      domain.setSetting(`campaign:${cid}:pause`, next, actorId);
      A({ actorType: "admin", actorId, action: "campaign.pause_flags", targetType: "campaign", targetId: cid, payload: next });
      return next;
    },
    cloneCampaign(cid, { code, name, startAt, endAt }, actorId) {
      const src = getCampaign.get(cid); if (!src) throw new Error("campaign not found");
      return tx(db, () => {
        const c = domain.createCampaign({ code, name: name || `${src.name} (copy)`, startAt: startAt || src.start_at, endAt: endAt || src.end_at, timezone: src.timezone, drawConfig: JSON.parse(src.draw_config_json || "{}"), actorId });
        const v = getActiveVersion.get(cid) || listVersions.all(cid).at(-1);
        if (v) domain.createVersion(c.id, { content: JSON.parse(v.content_json || "{}"), rules: JSON.parse(v.rules_json || "{}"), flags: JSON.parse(v.flags_json || "{}") }, actorId);
        for (const o of campaignOutlets.all(cid)) db.prepare(`insert or ignore into campaign_outlets (campaign_id, outlet_id, active_from, active_to, collection_enabled) values (?,?,?,?,?)`).run(c.id, o.id, o.member_from, o.member_to, o.campaign_collection_enabled);
        for (const d of db.prepare(`select * from campaign_decisions where campaign_id=?`).all(cid)) db.prepare(`insert into campaign_decisions (id, campaign_id, decision_id, question, test_value, approved_value, status, owner, blocks_activation, updated_at) values (?,?,?,?,?,?,?,?,?,?)`).run(id("dec"), c.id, d.decision_id, d.question, d.test_value, null, "open", d.owner, d.blocks_activation, now());
        A({ actorType: "admin", actorId, action: "campaign.clone", targetType: "campaign", targetId: c.id, payload: { from: cid } });
        return c;
      });
    },

    // ---- versions (immutable once activated) ---------------------------------------
    createVersion(campaignId, { content = {}, rules = {}, flags = {} }, actorId = "system") {
      const vid = id("cv");
      const fullRules = defaultRules(rules);
      const configHash = jsonHash({ content, rules: fullRules, flags });
      db.prepare(`insert into campaign_versions (id, campaign_id, version_no, status, content_json, rules_json, flags_json, config_hash) values (?,?,?,?,?,?,?,?)`)
        .run(vid, campaignId, nextVersionNo(campaignId), "draft", JSON.stringify(content), JSON.stringify(fullRules), JSON.stringify(flags), configHash);
      A({ actorType: "admin", actorId, action: "campaign.version.create", targetType: "campaign_version", targetId: vid, payload: { campaignId, configHash } });
      return vid;
    },
    updateDraftVersion(versionId, { content, rules, flags }, actorId) {
      const v = getVersion.get(versionId); if (!v) throw new Error("version not found");
      if (v.status !== "draft") throw new Error("only draft versions can be edited; create a new version");
      const c = content ?? JSON.parse(v.content_json || "{}"), r = defaultRules(rules ?? JSON.parse(v.rules_json || "{}")), f = flags ?? JSON.parse(v.flags_json || "{}");
      db.prepare(`update campaign_versions set content_json=?, rules_json=?, flags_json=?, config_hash=? where id=?`).run(JSON.stringify(c), JSON.stringify(r), JSON.stringify(f), jsonHash({ content: c, rules: r, flags: f }), versionId);
      A({ actorType: "admin", actorId, action: "campaign.version.update", targetType: "campaign_version", targetId: versionId });
      return getVersion.get(versionId);
    },
    /** Prospective change: copy the active version into a new draft. */
    newVersionFrom(campaignId, patch = {}, actorId) {
      const v = getActiveVersion.get(campaignId) || listVersions.all(campaignId).at(-1);
      const base = v ? { content: JSON.parse(v.content_json || "{}"), rules: JSON.parse(v.rules_json || "{}"), flags: JSON.parse(v.flags_json || "{}") } : { content: {}, rules: {}, flags: {} };
      // The nested rule objects are merged, not replaced. A shallow spread put
      // the patch's `primary_rule` over the LIVE one whole, and defaultRules()
      // then filled the missing siblings from the platform DEFAULTS, not from
      // the campaign: editing only min_packs on a campaign configured with
      // pack_grams 1000 silently reverted it to 2000 and every 1kg receipt
      // stopped qualifying. (defaultRules deep-merges the same way, but it only
      // ever sees the already-flattened patch.)
      return domain.createVersion(campaignId, { content: mergeOneLevel(base.content, patch.content), rules: mergeOneLevel(base.rules, patch.rules), flags: mergeOneLevel(base.flags, patch.flags) }, actorId);
    },
    getVersion: (vid) => getVersion.get(vid),
    listVersions: (cid) => listVersions.all(cid),
    getActiveVersion: (cid) => getActiveVersion.get(cid),
    activateVersion(campaignId, versionId, actorId) {
      const target = getVersion.get(versionId);
      if (!target) throw new Error("version not found");
      if (target.campaign_id !== campaignId) throw new Error("version does not belong to campaign");
      if (target.status !== "draft") throw new Error(`only draft versions can be activated (status=${target.status})`);
      return tx(db, () => {
        db.prepare(`update campaign_versions set status='retired' where campaign_id=? and id<>? and status='activated'`).run(campaignId, versionId);
        const changed = db.prepare(`update campaign_versions set status='activated', frozen_at=?, frozen_by=? where campaign_id=? and id=? and status='draft'`).run(now(), actorId, campaignId, versionId);
        if (changed.changes === 0) throw new Error("version could not be activated");
        A({ actorType: "admin", actorId, action: "campaign.version.activate", targetType: "campaign_version", targetId: versionId, payload: { campaignId, configHash: target.config_hash } });
        return getVersion.get(versionId);
      });
    },
    versionContent(campaignId) { const v = getActiveVersion.get(campaignId); try { return v ? JSON.parse(v.content_json || "{}") : {}; } catch { return {}; } },
    versionRules(campaignId) { const v = getActiveVersion.get(campaignId); try { return defaultRules(v ? JSON.parse(v.rules_json || "{}") : {}); } catch { return defaultRules(); } },
    versionFlags(campaignId) { const v = getActiveVersion.get(campaignId); try { return v ? JSON.parse(v.flags_json || "{}") : {}; } catch { return {}; } },

    // ---- periods -----------------------------------------------------------------------
    listPeriods: (cid) => listPeriods.all(cid),
    getPeriod: (pid) => getPeriod.get(pid),
    getPeriodByCode: (cid, code) => getPeriodByCode.get(cid, code),
    upsertPeriod(campaignId, { id: pid, code, label, startsAt, endsAt, drawAt, prizeConfig, status }, actorId = "system") {
      if (!code || !startsAt || !endsAt) throw new Error("code, startsAt, endsAt required");
      if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("endsAt must be after startsAt");
      for (const p of listPeriods.all(campaignId)) {
        if (p.code === code || p.id === pid) continue;
        if (Date.parse(startsAt) < Date.parse(p.ends_at) && Date.parse(endsAt) > Date.parse(p.starts_at)) throw new Error(`period overlaps ${p.code}`);
      }
      const existing = getPeriodByCode.get(campaignId, code);
      if (existing) {
        if (existing.status === "drawn") throw new Error("period already drawn; immutable");
        db.prepare(`update campaign_periods set label=?, starts_at=?, ends_at=?, draw_at=?, prize_config_json=?, status=? where id=?`).run(label || existing.label, startsAt, endsAt, drawAt || null, JSON.stringify(prizeConfig || JSON.parse(existing.prize_config_json || "{}")), status || existing.status, existing.id);
        A({ actorType: "admin", actorId, action: "period.update", targetType: "campaign_period", targetId: existing.id, payload: { code, startsAt, endsAt } });
        return getPeriod.get(existing.id);
      }
      const np = pid || id("per");
      db.prepare(`insert into campaign_periods (id, campaign_id, code, label, starts_at, ends_at, draw_at, status, prize_config_json, created_at) values (?,?,?,?,?,?,?,?,?,?)`)
        .run(np, campaignId, code, label || code, startsAt, endsAt, drawAt || null, status || "scheduled", JSON.stringify(prizeConfig || {}), now());
      A({ actorType: "admin", actorId, action: "period.create", targetType: "campaign_period", targetId: np, payload: { code, startsAt, endsAt } });
      return getPeriod.get(np);
    },
    setPeriodStatus(pid, status, actorId) {
      const p = getPeriod.get(pid); if (!p) throw new Error("period not found");
      db.prepare(`update campaign_periods set status=? where id=?`).run(status, pid);
      A({ actorType: "admin", actorId, action: `period.${status}`, targetType: "campaign_period", targetId: pid });
      return getPeriod.get(pid);
    },
    /** Period containing an intake time (half-open). */
    periodAt(campaignId, iso) {
      const t = Date.parse(iso);
      return listPeriods.all(campaignId).find((p) => t >= Date.parse(p.starts_at) && t < Date.parse(p.ends_at)) || null;
    },

    // ---- outlets & products ---------------------------------------------------------------
    listOutlets: () => allOutlets.all(),
    listCampaignOutlets: (cid) => campaignOutlets.all(cid),
    getOutlet: (oid) => getOutlet.get(oid),
    getOutletByCode: (code) => getOutletByCode.get(code),
    upsertOutlet(o, actorId = "system") {
      if (!o.outlet_code || !o.retailer || !o.town) throw new Error("outlet_code, retailer, town required");
      const oid = o.id || `out_${o.outlet_code}`;
      const prev = getOutletByCode.get(o.outlet_code) || null;
      db.prepare(`insert into outlets (id, outlet_code, retailer, branch, town, province, collection_enabled, active_from, active_to, aliases_json, active, retailer_code)
        values (?,?,?,?,?,?,?,?,?,?,?,?)
        on conflict(outlet_code) do update set retailer=excluded.retailer, branch=excluded.branch, town=excluded.town, province=excluded.province,
          collection_enabled=excluded.collection_enabled, active_from=excluded.active_from, active_to=excluded.active_to, aliases_json=excluded.aliases_json, active=excluded.active, retailer_code=excluded.retailer_code`)
        .run(oid, o.outlet_code, o.retailer, o.branch || o.retailer, o.town, o.province || "", Number(o.collection_enabled ?? 1), o.active_from || "1970-01-01", o.active_to || "9999-12-31", JSON.stringify(o.aliases || []), Number(o.active ?? 1), o.retailer_code || null);
      const row = getOutletByCode.get(o.outlet_code);
      // Without this the hash-chained trail held no record of an outlet being
      // deactivated, renamed or stripped of its aliases — the change that stops
      // a branch's receipts qualifying or stops it handing out prizes.
      const before = pickFields(prev, OUTLET_AUDITED); const after = pickFields(row, OUTLET_AUDITED);
      const changed = changedFields(before, after);
      if (changed.length) A({ actorType: "admin", actorId, action: "outlet.upsert", targetType: "outlet", targetId: row.id, payload: { created: !prev, changed, before, after } });
      return row;
    },
    setCampaignOutlets(campaignId, outletIds, actorId, { collectionByOutlet = {} } = {}) {
      return tx(db, () => {
        // Carry each surviving member's MEMBERSHIP WINDOW forward. The replace
        // used to re-insert only (campaign, outlet, collection_enabled), so
        // every remaining outlet's active_from/active_to silently fell back to
        // the schema defaults 1970-01-01/9999-12-31 — the very columns
        // winner-service.assertCollectionPoint reads to refuse a prize
        // collection at a branch outside its campaign window.
        const prev = new Map(db.prepare(`select outlet_id, active_from, active_to from campaign_outlets where campaign_id=?`).all(campaignId).map((r) => [r.outlet_id, r]));
        db.prepare(`delete from campaign_outlets where campaign_id=?`).run(campaignId);
        const ins = db.prepare(`insert into campaign_outlets (campaign_id, outlet_id, collection_enabled, active_from, active_to) values (?,?,?,?,?)`);
        for (const oid of outletIds) ins.run(campaignId, oid, Number(collectionByOutlet[oid] ?? getOutlet.get(oid)?.collection_enabled ?? 1), prev.get(oid)?.active_from || "1970-01-01", prev.get(oid)?.active_to || "9999-12-31");
        A({ actorType: "admin", actorId, action: "campaign.outlets.set", targetType: "campaign", targetId: campaignId, payload: { count: outletIds.length } });
        return outletIds.length;
      });
    },
    /**
     * Remove ONE outlet from a campaign. The console had only the full-replace
     * PUT above to shrink membership, and the list it builds that call from is
     * filtered to active master records, so removing one closed branch also
     * deleted every member whose master row was inactive (invisible to the
     * operator) and reset the windows of all the rest. A targeted delete
     * removes exactly the row asked for and touches nothing else.
     */
    removeCampaignOutlet(campaignId, outletId, actorId) {
      const r = db.prepare(`delete from campaign_outlets where campaign_id=? and outlet_id=?`).run(campaignId, outletId);
      if (r.changes) A({ actorType: "admin", actorId, action: "campaign.outlets.remove", targetType: "campaign", targetId: campaignId, payload: { outletId } });
      return r.changes > 0;
    },
    /** Validated CSV import (all-or-nothing). Returns { ok, rows, errors } and imports only when errors are empty and !dryRun. */
    importOutletsCsv(campaignId, csvText, { dryRun = true, actorId = "system" } = {}) {
      const rows = parseCsv(csvText);
      const required = ["outlet_code", "retailer", "branch", "town"];
      const errors = []; const seen = new Set();
      rows.forEach((r, i) => {
        for (const k of required) if (!r[k]) errors.push({ row: i + 2, error: `${k} required` });
        if (r.outlet_code) { if (seen.has(r.outlet_code)) errors.push({ row: i + 2, error: `duplicate outlet_code ${r.outlet_code}` }); seen.add(r.outlet_code); }
        for (const k of ["active_from", "active_to"]) if (r[k] && Number.isNaN(Date.parse(r[k]))) errors.push({ row: i + 2, error: `${k} invalid date` });
        if (r.collection_enabled && !/^(0|1|true|false|yes|no)$/i.test(r.collection_enabled)) errors.push({ row: i + 2, error: "collection_enabled must be 0/1" });
      });
      if (errors.length || dryRun) return { ok: errors.length === 0, rows: rows.length, errors, imported: 0 };
      return tx(db, () => {
        const ids = [];
        for (const r of rows) {
          // actorId is passed through so the per-outlet audit rows name the
          // importing user, not "system"; the outlets.import summary row below
          // stays as the record of the bulk action itself.
          const o = domain.upsertOutlet({ ...r, aliases: r.aliases ? String(r.aliases).split(";").map((s) => s.trim()).filter(Boolean) : [], collection_enabled: /^(1|true|yes)$/i.test(r.collection_enabled || "1") ? 1 : 0 }, actorId);
          ids.push(o.id);
        }
        if (campaignId) { const ins = db.prepare(`insert or ignore into campaign_outlets (campaign_id, outlet_id, collection_enabled) values (?,?,?)`); for (const oid of ids) ins.run(campaignId, oid, getOutlet.get(oid).collection_enabled); }
        A({ actorType: "admin", actorId, action: "outlets.import", targetType: "campaign", targetId: campaignId || "master", payload: { rows: rows.length } });
        return { ok: true, rows: rows.length, errors: [], imported: ids.length };
      });
    },
    listProducts: () => allProducts.all(),
    upsertProduct(p, actorId = "system") {
      if (!p.sku || !p.name) throw new Error("sku and name required");
      const grams = Number(p.pack_grams ?? (p.pack_weight_kg ? Math.round(Number(p.pack_weight_kg) * 1000) : 0));
      if (!Number.isInteger(grams) || grams <= 0) throw new Error("pack_grams must be a positive integer");
      const pid = p.id || `prod_${p.sku}`;
      const prev = getProductBySku.get(p.sku) || null;
      db.prepare(`insert into products (id, sku, brand, name, aliases_json, pack_weight_kg, unit, active, pack_grams, product_code) values (?,?,?,?,?,?,?,?,?,?)
        on conflict(sku) do update set brand=excluded.brand, name=excluded.name, aliases_json=excluded.aliases_json, pack_weight_kg=excluded.pack_weight_kg, unit=excluded.unit, active=excluded.active, pack_grams=excluded.pack_grams, product_code=excluded.product_code`)
        .run(pid, p.sku, p.brand || "", p.name, JSON.stringify(p.aliases || []), grams / 1000, p.unit || "pack", Number(p.active ?? 1), grams, p.product_code || p.sku);
      // Catalogue edits were equally unrecorded. (They do not change
      // qualification — eligibility matches against the campaign version's
      // rules.products — but FR-24 covers every master-data change.)
      const before = pickFields(prev, PRODUCT_AUDITED); const after = pickFields(getProductBySku.get(p.sku), PRODUCT_AUDITED);
      const changed = changedFields(before, after);
      if (changed.length) A({ actorType: "admin", actorId, action: "product.upsert", targetType: "product", targetId: pid, payload: { created: !prev, changed, before, after } });
      return pid;
    },

    // ---- decisions register ----------------------------------------------------------------
    listDecisions: (cid) => db.prepare(`select * from campaign_decisions where campaign_id=? order by decision_id`).all(cid),
    upsertDecision(campaignId, d, actorId = "system") {
      const ex = db.prepare(`select * from campaign_decisions where campaign_id=? and decision_id=?`).get(campaignId, d.decision_id);
      if (ex) {
        db.prepare(`update campaign_decisions set question=?, test_value=?, approved_value=?, status=?, owner=?, approved_by=?, approved_at=?, evidence=?, blocks_activation=?, updated_at=? where id=?`)
          .run(d.question ?? ex.question, d.test_value ?? ex.test_value, d.approved_value ?? ex.approved_value, d.status ?? ex.status, d.owner ?? ex.owner, d.status === "approved" ? actorId : ex.approved_by, d.status === "approved" ? now() : ex.approved_at, d.evidence ?? ex.evidence, Number(d.blocks_activation ?? ex.blocks_activation), now(), ex.id);
        A({ actorType: "admin", actorId, action: "decision.update", targetType: "campaign_decision", targetId: ex.id, payload: { decisionId: d.decision_id, status: d.status ?? ex.status } });
        return db.prepare(`select * from campaign_decisions where id=?`).get(ex.id);
      }
      const did = id("dec");
      db.prepare(`insert into campaign_decisions (id, campaign_id, decision_id, question, test_value, approved_value, status, owner, blocks_activation, updated_at) values (?,?,?,?,?,?,?,?,?,?)`)
        .run(did, campaignId, d.decision_id, d.question || d.decision_id, d.test_value || null, d.approved_value || null, d.status || "open", d.owner || null, Number(d.blocks_activation ?? 1), now());
      return db.prepare(`select * from campaign_decisions where id=?`).get(did);
    },

    // ---- settings ------------------------------------------------------------------------------
    getSetting(key, fallback = null) { const r = db.prepare(`select value_json from settings where key=?`).get(key); try { return r ? JSON.parse(r.value_json) : fallback; } catch { return fallback; } },
    setSetting(key, value, actorId = "system") { db.prepare(`insert into settings (key, value_json, updated_by, updated_at) values (?,?,?,?) on conflict(key) do update set value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(key, JSON.stringify(value), actorId, now()); return value; },
    environment() { return db.prepare(`select value from schema_meta where key='environment'`).get()?.value || "local"; },

    // ---- participants, enrollment, consent -------------------------------------------------------
    getParticipantByPhone: (phoneUid) => getParticipantByPhone.get(normalizePhone(phoneUid) || phoneUid),
    getParticipant: (pid) => getParticipant.get(pid),
    getEnrollment: (participantId, campaignId) => getEnrollment.get(participantId, campaignId),
    /** Create or update the reusable profile and enrol in the campaign (terms/privacy versions recorded). */
    registerParticipant({ phoneUid, firstName, surname, identity, location, ageConfirmed = true, termsVersion, privacyVersion, channel = "whatsapp", campaignId, campaignVersionId, marketingConsent = false, declarations = {} }) {
      phoneUid = normalizePhone(phoneUid) || phoneUid;
      if (!firstName) throw new Error("first name required");
      return tx(db, () => {
        let p = getParticipantByPhone.get(phoneUid); let created = false;
        if (p) {
          if (p.status !== "active") throw new Error("participant not active");
          db.prepare(`update participants set first_name=?, surname=?, location=?, identity_enc=coalesce(?, identity_enc), identity_masked=coalesce(?, identity_masked), identity_fp=coalesce(?, identity_fp), updated_at=?, row_version=row_version+1 where id=?`)
            .run(firstName, surname || "", location || p.location, identity ? encryptIdentity(identity) : null, identity ? maskIdentity(identity) : null, identity ? identityFingerprint(identity) : null, now(), p.id);
        } else {
          const pid = id("ptc"); created = true;
          db.prepare(`insert into participants (id, wa_phone_uid, first_name, surname, identity_enc, identity_masked, identity_hash, identity_fp, location, age_confirmed, status, created_at, updated_at, phone_confirmed_at, marketing_consent)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(pid, phoneUid, firstName, surname || "", identity ? encryptIdentity(identity) : null, identity ? maskIdentity(identity) : null, null, identity ? identityFingerprint(identity) : null, location || null, ageConfirmed ? 1 : 0, "active", now(), now(), now(), marketingConsent ? 1 : 0);
          A({ actorType: "participant", actorId: pid, action: "participant.register", targetType: "participant", targetId: pid, payload: { phone: maskPhone(phoneUid), identityProvided: !!identity } });
        }
        p = getParticipantByPhone.get(phoneUid);
        // One national ID, several phones. The keyed fingerprint was written and
        // indexed but never read by anything, so three SIMs and one ID produced
        // three independent participants, each accumulating entries and each
        // entering the weekly sortition separately — one_prize_per_participant is
        // enforced per participant id, so one human could hold several chances
        // and win twice in a week, with no alert, no review task and nothing a
        // reviewer could see. Whether a second registration should be REFUSED is
        // an open client decision (D-08 participant caps, D-10 household rules,
        // D-16 one prize per participant), and coding a hard block in would
        // pre-empt it — a lost SIM legitimately re-registers. So this detects and
        // names it for a human and changes no outcome. The fingerprint normalises
        // case, spacing and punctuation (normIdentity), so "63-123456 X 07" and
        // "63123456X07" match.
        if (identity) {
          const fp = identityFingerprint(identity);
          const others = db.prepare(`select id, wa_phone_uid from participants where identity_fp=? and id<>? and status='active'`).all(fp, p.id);
          if (others.length) {
            domain.alert({
              kind: "participant.identity_reuse", dedupeKey: `participant.identity_reuse:${fp}`, severity: "warning",
              message: `the same identity number is registered on ${others.length + 1} phone numbers (${[p, ...others].map((x) => maskPhone(x.wa_phone_uid)).join(", ")}): each is a separate participant in the draw`,
              detail: { participantIds: [p.id, ...others.map((o) => o.id)], identityMasked: maskIdentity(identity) },
              runbook: "docs/runbooks/review-operations.md",
            });
            A({ actorType: "participant", actorId: p.id, action: "participant.identity_reuse", targetType: "participant", targetId: p.id, payload: { others: others.map((o) => o.id) } });
          }
        }
        // legacy consent row (kept for compatibility) + campaign enrollment
        db.prepare(`insert into consents (id, participant_id, terms_version, privacy_version, channel, accepted_at) values (?,?,?,?,?,?)`).run(id("con"), p.id, termsVersion || "unversioned", privacyVersion || "unversioned", channel, now());
        let enrollment = null;
        if (campaignId) enrollment = domain.enrol(p.id, campaignId, { campaignVersionId, termsVersion, privacyVersion, marketingConsent, declarations });
        return { participant: p, created, enrollment };
      });
    },
    enrol(participantId, campaignId, { campaignVersionId, termsVersion, privacyVersion, marketingConsent = false, declarations = {} }) {
      const v = campaignVersionId || getActiveVersion.get(campaignId)?.id;
      if (!v) throw new Error("no active campaign version");
      const ex = getEnrollment.get(participantId, campaignId);
      if (ex && !ex.withdrawn_at) return ex;
      const eid = id("enr");
      db.prepare(`insert into campaign_enrollments (id, participant_id, campaign_id, campaign_version_id, terms_version, privacy_version, marketing_consent, declarations_json, enrolled_at)
        values (?,?,?,?,?,?,?,?,?) on conflict(participant_id, campaign_id) do update set campaign_version_id=excluded.campaign_version_id, terms_version=excluded.terms_version, privacy_version=excluded.privacy_version, marketing_consent=excluded.marketing_consent, declarations_json=excluded.declarations_json, enrolled_at=excluded.enrolled_at, withdrawn_at=null`)
        .run(eid, participantId, campaignId, v, termsVersion || "unversioned", privacyVersion || "unversioned", marketingConsent ? 1 : 0, JSON.stringify(declarations || {}), now());
      A({ actorType: "participant", actorId: participantId, action: "participant.enrol", targetType: "campaign_enrollment", targetId: participantId, payload: { campaignId, termsVersion, privacyVersion, marketingConsent: !!marketingConsent } });
      return getEnrollment.get(participantId, campaignId);
    },
    updateParticipant(pid, { firstName, surname, location, identity }, actorId, reason = "correction") {
      const p = getParticipant.get(pid); if (!p) throw new Error("participant not found");
      db.prepare(`update participants set first_name=?, surname=?, location=?, identity_enc=coalesce(?, identity_enc), identity_masked=coalesce(?, identity_masked), identity_fp=coalesce(?, identity_fp), updated_at=?, row_version=row_version+1 where id=?`)
        .run(firstName ?? p.first_name, surname ?? p.surname, location ?? p.location, identity ? encryptIdentity(identity) : null, identity ? maskIdentity(identity) : null, identity ? identityFingerprint(identity) : null, now(), pid);
      A({ actorType: actorId === pid ? "participant" : "admin", actorId, action: "participant.update", targetType: "participant", targetId: pid, reason, payload: { fields: Object.keys({ firstName, surname, location, identity }).filter((k) => ({ firstName, surname, location, identity })[k] != null) } });
      return getParticipant.get(pid);
    },
    /** Reveal the identity value (audited; restricted role enforced by the HTTP layer). */
    revealIdentity(pid, actorId, reason) {
      const p = getParticipant.get(pid); if (!p?.identity_enc) return null;
      A({ actorType: "admin", actorId, action: "participant.identity.reveal", targetType: "participant", targetId: pid, reason });
      return decryptIdentity(p.identity_enc);
    },
    withdrawParticipant(phoneUid, actorId = null, reason = "participant request") {
      const p = getParticipantByPhone.get(normalizePhone(phoneUid) || phoneUid);
      if (!p) return null;
      tx(db, () => {
        db.prepare(`update consents set withdrawn_at=? where participant_id=? and withdrawn_at is null`).run(now(), p.id);
        db.prepare(`update campaign_enrollments set withdrawn_at=? where participant_id=? and withdrawn_at is null`).run(now(), p.id);
        db.prepare(`update participants set status='withdrawn', updated_at=?, row_version=row_version+1 where id=?`).run(now(), p.id);
        A({ actorType: actorId ? "admin" : "participant", actorId: actorId || p.id, action: "participant.withdraw", targetType: "participant", targetId: p.id, reason });
      });
      return getParticipant.get(p.id);
    },
    /** Privacy deletion/anonymisation: profile fields and identity removed, ledger references retained (§17). */
    anonymiseParticipant(pid, actorId, reason) {
      const p = getParticipant.get(pid); if (!p) throw new Error("participant not found");
      const phone = p.wa_phone_uid;
      // Erasure used to touch the participants row and nothing else, so the
      // person's real MSISDN (and, for an abandoned registration, their
      // plaintext national ID in the session context) stayed in
      // channel_events / conversation_sessions / outbound_messages and was
      // still served by the conversation and transcript views.
      //
      // A published winner is NOT refused here. An earlier revision threw
      // CONFLICT ("withdraw the publication first") on the grounds that the
      // frozen winners.display_name was served by the unauthenticated
      // /api/winners/public. winner-service.listPublic now derives the name from
      // the LIVE participant status and reports "[removed]" for anyone who is
      // not 'active', so the refusal bought no privacy at all and instead made a
      // lawful erasure request hard-fail (409) until an operator rewrote a
      // published draw result. Erasure completes; the name leaves the public
      // list because the participant is no longer active, and display_name is
      // cleared below so the frozen copy does not survive either.
      const scrubbed = { channelEvents: 0, sessions: 0, outbound: 0, outboundDeleted: 0, winnerNames: 0, inboundCancelled: 0 };
      tx(db, () => {
        db.prepare(`update participants set first_name='[deleted]', surname='', identity_enc=null, identity_masked=null, identity_hash=null, identity_fp=null, location=null, status='deleted', wa_phone_uid=?, updated_at=?, row_version=row_version+1 where id=?`).run(`deleted:${pid}`, now(), pid);
        db.prepare(`update campaign_enrollments set withdrawn_at=coalesce(withdrawn_at, ?) where participant_id=?`).run(now(), pid);
        // withdrawParticipant closes the consent; erasure did not, so a deleted
        // person's consent still read as live.
        db.prepare(`update consents set withdrawn_at=coalesce(withdrawn_at, ?) where participant_id=?`).run(now(), pid);
        // Inbound ledger: keep the row (provider idempotency, counts) but drop
        // the number and the message body it carried.
        // Anything still in the queue must be cancelled FIRST. Re-keying alone
        // left 'received'/'processing'/'failed' rows visible to intake.nextEvent,
        // which then ran conversation.handle with phoneUid='deleted:<pid>' and
        // text='[erased]' and enqueued a fresh main-menu reply to that dead
        // address — a guaranteed provider failure that retries and trips the
        // outbound.failures alert. 'ignored' is a terminal channel_events status.
        scrubbed.inboundCancelled = db.prepare(`update channel_events set status='ignored', lease_until=null, processed_at=coalesce(processed_at, ?), error='cancelled: participant erased' where wa_phone_uid=? and status in ('received','processing','failed')`).run(now(), phone).changes;
        const updEvent = db.prepare(`update channel_events set wa_phone_uid=?, payload_json=? where id=?`);
        for (const e of db.prepare(`select id, payload_json from channel_events where wa_phone_uid=?`).all(phone)) {
          let body = {}; try { body = JSON.parse(e.payload_json) || {}; } catch { body = {}; }
          updEvent.run(`deleted:${pid}`, JSON.stringify({ text: "[erased]", mediaId: null, status: body.status ?? null, raw: null, timestamp: body.timestamp ?? null, inlineMediaB64: null, mime: body.mime ?? null, erased: true }), e.id);
          scrubbed.channelEvents += 1;
        }
        // context_json can hold the plaintext identity of an abandoned
        // registration; nothing needs the row (a later message starts at HOME).
        scrubbed.sessions = db.prepare(`delete from conversation_sessions where wa_phone_uid=?`).run(phone).changes;
        // Messages that were never sent are dropped outright — they are only
        // personal data addressed to someone who no longer exists, and leaving
        // them queued would have the worker try to deliver to a dead number.
        // Anything already sent stays as delivery history, minus the number and
        // the body. Statuses are left alone so an erasure does not masquerade as
        // an outbound-failure incident (worker.mjs alerts on failed messages).
        // The status list used to be ('pending','retryable_failure'), which left
        // 'sending' rows behind: outbox.next re-picks a 'sending' row once its
        // 60s lease expires, so the worker still dispatched to 'deleted:<pid>'.
        // 'permanent_failure'/'unknown_outcome' rows are operator-requeueable
        // (outbox.retry) and had the same problem. sent_at is null is the honest
        // test: a message that never left has no delivery history to preserve.
        scrubbed.outboundDeleted = db.prepare(`delete from outbound_messages where wa_phone_uid=? and sent_at is null`).run(phone).changes;
        // Anything still here was actually delivered; make sure nothing can
        // re-lease it after the recipient column is rewritten.
        db.prepare(`update outbound_messages set lease_until=null, next_attempt_at=null where wa_phone_uid=?`).run(phone);
        const updOut = db.prepare(`update outbound_messages set wa_phone_uid=?, payload_json=? where id=?`);
        for (const m of db.prepare(`select id from outbound_messages where wa_phone_uid=?`).all(phone)) {
          updOut.run(`deleted:${pid}`, JSON.stringify({ body: "[erased]", erased: true }), m.id);
          scrubbed.outbound += 1;
        }
        scrubbed.winnerNames = db.prepare(`update winners set display_name=null, row_version=row_version+1 where participant_id=? and display_name is not null`).run(pid).changes;
        A({ actorType: "admin", actorId, action: "participant.anonymise", targetType: "participant", targetId: pid, reason, payload: { scrubbed } });
      });
      return getParticipant.get(pid);
    },
    /** Controlled phone change: only by staff, audited, never merges two existing participants. */
    changePhone(pid, newPhone, actorId, reason) {
      const np = normalizePhone(newPhone); if (!np) throw new Error("invalid phone");
      const p = getParticipant.get(pid); if (!p) throw new Error("participant not found");
      if (getParticipantByPhone.get(np)) throw new Error("another participant already uses that number");
      const old = p.wa_phone_uid;
      // The channel tables are keyed by the MSISDN, not by participant_id, and
      // only participants.wa_phone_uid used to move. Everything written before a
      // correction therefore stayed keyed to the OLD number: it fell out of the
      // support transcript, and — the reason this matters — anonymiseParticipant
      // scrubs by the CURRENT number, so a later erasure left the old MSISDN,
      // the conversation session (which can hold a plaintext national ID) and
      // the full inbound/outbound message text in the database while returning
      // 200. Move the history with the person, in the same transaction.
      const moved = { channelEvents: 0, sessions: 0, outbound: 0, sessionsDropped: 0 };
      tx(db, () => {
        db.prepare(`update participants set wa_phone_uid=?, updated_at=?, row_version=row_version+1 where id=?`).run(np, now(), pid);
        moved.channelEvents = db.prepare(`update channel_events set wa_phone_uid=? where wa_phone_uid=?`).run(np, old).changes;
        moved.outbound = db.prepare(`update outbound_messages set wa_phone_uid=? where wa_phone_uid=?`).run(np, old).changes;
        // conversation_sessions is unique (campaign_id, wa_phone_uid). If the
        // new number already has a session of its own it is the live one, so the
        // superseded session on the old number is dropped rather than failing
        // the correction on a constraint violation.
        moved.sessionsDropped = db.prepare(`delete from conversation_sessions where wa_phone_uid=? and campaign_id in (select campaign_id from conversation_sessions where wa_phone_uid=?)`).run(old, np).changes;
        moved.sessions = db.prepare(`update conversation_sessions set wa_phone_uid=? where wa_phone_uid=?`).run(np, old).changes;
        A({ actorType: "admin", actorId, action: "participant.phone_change", targetType: "participant", targetId: pid, reason, payload: { from: maskPhone(old), to: maskPhone(np), moved } });
      });
      return getParticipant.get(pid);
    },
    searchParticipants({ q = "", campaignId = null, limit = 50, offset = 0 } = {}) {
      const like = `%${q}%`;
      return db.prepare(`select p.id, p.first_name, p.surname, p.location, p.status, p.created_at, p.wa_phone_uid, p.identity_masked from participants p
        where (? = '' or p.first_name like ? or p.surname like ? or p.wa_phone_uid like ?) ${campaignId ? "and exists (select 1 from campaign_enrollments e where e.participant_id=p.id and e.campaign_id=?)" : ""}
        order by p.created_at desc limit ? offset ?`).all(...(campaignId ? [q, like, like, like, campaignId, limit, offset] : [q, like, like, like, limit, offset]))
        .map((r) => ({ ...r, wa_phone_uid: maskPhone(r.wa_phone_uid) }));
    },

    // ---- sessions (versioned) ----------------------------------------------------------------
    getSession: (campaignId, phoneUid) => getSession.get(campaignId, normalizePhone(phoneUid) || phoneUid),
    /** Optimistic version check: pass expectedVersion to detect concurrent writers. */
    setSession(campaignId, phoneUid, { state, context, participantId, ttlMinutes = 60 * 24 * 7, expectedVersion = null, activeReceiptId, handoffOwner, handoffSince }) {
      phoneUid = normalizePhone(phoneUid) || phoneUid;
      const prev = getSession.get(campaignId, phoneUid);
      if (expectedVersion != null && prev && prev.row_version !== expectedVersion) { const e = new Error("session version conflict"); e.code = "CONFLICT"; throw e; }
      const ctx = context !== undefined ? context : JSON.parse(prev?.context_json || "{}");
      const exp = new Date(Date.parse(now()) + ttlMinutes * 60_000).toISOString();
      if (prev) {
        db.prepare(`update conversation_sessions set participant_id=?, state=?, context_json=?, updated_at=?, expires_at=?, row_version=row_version+1, active_receipt_id=?, handoff_owner=?, handoff_since=? where id=?`)
          .run(participantId ?? prev.participant_id ?? null, state ?? prev.state, JSON.stringify(ctx), now(), exp, activeReceiptId === undefined ? prev.active_receipt_id : activeReceiptId, handoffOwner === undefined ? prev.handoff_owner : handoffOwner, handoffSince === undefined ? prev.handoff_since : handoffSince, prev.id);
      } else {
        db.prepare(`insert into conversation_sessions (id, campaign_id, wa_phone_uid, participant_id, state, context_json, updated_at, expires_at, active_receipt_id, handoff_owner, handoff_since) values (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id("ses"), campaignId, phoneUid, participantId ?? null, state ?? "HOME", JSON.stringify(ctx), now(), exp, activeReceiptId ?? null, handoffOwner ?? null, handoffSince ?? null);
      }
      return getSession.get(campaignId, phoneUid);
    },

    // ---- misc ---------------------------------------------------------------------------------
    countPeriodEntries(participantId, campaignId, periodCode) {
      return db.prepare(`select count(*) n from entries where participant_id=? and campaign_id=? and period_code=? and status='active'`).get(participantId, campaignId, periodCode || "").n;
    },
    countActiveEntries(participantId, campaignId) {
      return db.prepare(`select count(*) n from entries where participant_id=? and campaign_id=? and status='active'`).get(participantId, campaignId).n;
    },
    metric(name, value = 1, labels = null) { db.prepare(`insert into metrics_events (name, value, labels_json, created_at) values (?,?,?,?)`).run(name, value, labels ? JSON.stringify(labels) : null, now()); },
    /**
     * Retention sweep (D-22): drop extracted receipt text and stored inbound
     * message bodies once they are older than the facts-retention window.
     *
     * This existed only as a documented commitment — docs/runbooks and the
     * production checklist claim it runs — but nothing implemented or scheduled
     * it, so OCR text and conversation payloads grew without bound. The raw
     * IMAGES are handled separately by mediaStore.purgeExpired via the
     * media.purge job.
     */
    retentionScrub({ factsDays = retention.factsDays } = {}) {
      const cutoff = new Date(Date.now() - Number(factsDays) * 86400_000).toISOString();
      const facts = db.prepare(`update validation_results set ocr_text=null, raw_result_json=null
        where created_at < ? and (ocr_text is not null or raw_result_json is not null)`).run(cutoff).changes;
      const events = db.prepare(`select id, payload_json from channel_events where received_at < ? and payload_json like '%"text":"%' limit 2000`).all(cutoff);
      let scrubbed = 0;
      const upd = db.prepare(`update channel_events set payload_json=? where id=?`);
      for (const e of events) {
        let p; try { p = JSON.parse(e.payload_json); } catch { continue; }
        if (!p || (p.textRedacted && !p.inlineMediaB64)) continue;
        if (!p.text && !p.inlineMediaB64) continue;
        upd.run(JSON.stringify({ ...p, text: p.text ? "[redacted: retention]" : p.text, textRedacted: true, inlineMediaB64: null, inlineMediaRedacted: true }), e.id);
        scrubbed += 1;
      }
      if (facts || scrubbed) A({ actorType: "system", actorId: "retention", action: "retention.scrubbed", targetType: "settings", targetId: "retention", payload: { factsDays: Number(factsDays), validationRows: facts, channelEvents: scrubbed, cutoff } });
      return { validationRows: facts, channelEvents: scrubbed, cutoff };
    },
    /**
     * Raise an operator alert, de-duplicated within an hour.
     *
     * De-duplication used to key on `kind` ALONE and returned the matched row
     * untouched, so every remedy of the form "raise an alert so an operator
     * acts" covered only the FIRST entity of the hour: nine of ten winners
     * whose notification failed, the 2nd..Nth dead-lettered event, the second
     * stuck receipt, all raised nothing at all, and the one surviving row still
     * carried the first message (a backlog alert read "1 waiting" however deep
     * the queue got). Two changes, both needed:
     *   - `dedupeKey` — callers naming a specific entity (winner, event, job,
     *     receipt, draw) pass one so each entity gets its own row; callers that
     *     genuinely want one-per-hour (backlog warnings the worker re-evaluates
     *     every minute) omit it and keep the old behaviour;
     *   - the matched row is REFRESHED with the newest message/detail/severity
     *     and an occurrence count, so a suppressed repeat still updates the
     *     information an operator reads instead of discarding it.
     * The key is carried in detail_json (`_dedupe`) rather than a new column so
     * this needs no migration; nothing renders detail_json for alerts.
     */
    alert({ kind, severity = "warning", message, detail = null, runbook = null, dedupeKey = null }) {
      const key = String(dedupeKey || kind);
      const since = new Date(Date.now() - 3600_000).toISOString();
      const open = db.prepare(`select id, detail_json, severity from alerts where kind=? and acknowledged_at is null and created_at > ? order by created_at desc`).all(kind, since)
        .find((r) => { try { return String(JSON.parse(r.detail_json || "{}")?._dedupe ?? kind) === key; } catch { return kind === key; } });
      const body = (occurrences) => JSON.stringify({ ...(detail || {}), _dedupe: key, ...(occurrences > 1 ? { _occurrences: occurrences } : {}) });
      if (open) {
        let n = 1; try { n = Number(JSON.parse(open.detail_json || "{}")?._occurrences || 1); } catch { /* unparsable detail */ }
        const SEV = { info: 0, warning: 1, critical: 2 };
        const worst = (SEV[severity] ?? 1) >= (SEV[open.severity] ?? 1) ? severity : open.severity;
        db.prepare(`update alerts set message=?, detail_json=?, severity=?, runbook=coalesce(?, runbook) where id=?`).run(message, body(n + 1), worst, runbook, open.id);
        return open.id;
      }
      const aid = id("alr");
      db.prepare(`insert into alerts (id, kind, severity, message, detail_json, runbook, created_at) values (?,?,?,?,?,?,?)`).run(aid, kind, severity, message, body(1), runbook, now());
      return aid;
    },
  };
  return domain;
}

/**
 * One-level-deep object merge used for campaign version patches: the patch wins
 * key by key, but a nested plain object (primary_rule, caps, outlet_match, ...)
 * is merged into its base rather than replacing it. Same rule defaultRules()
 * applies to its own defaults.
 */
function mergeOneLevel(base = {}, patch = {}) {
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const out = { ...(base || {}), ...(patch || {}) };
  for (const k of Object.keys(patch || {})) if (isObj(base?.[k]) && isObj(patch[k])) out[k] = { ...base[k], ...patch[k] };
  return out;
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, commas, CRLF). Formula-injection is neutralised on export, not import. */
export function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => String(v).trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => String(h).trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Neutralise spreadsheet formula injection in exported cell values. */
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export { id, tx, nowIso };
