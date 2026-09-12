import { E, page, str } from "../http.mjs";
import { signMediaUrl, verifyMediaSig } from "../media.mjs";
import { validateActivation, validateVersionContentRules } from "../activation.mjs";
import { csvCell } from "../services.mjs";
import { shortRef } from "../copy.mjs";
import { ALL_ROLES } from "../auth.mjs";

const T = (tag) => ({ tag });

/** Promotion admin API (spec §17). Every route enforces roles server-side. */
export function registerAdminRoutes(r, S) {
  const { db, domain, auth, pipeline, drawService, winners, crm, outbox, intake, mediaStore, extractor, transport, conversation, cfg, worker, mediaSecret } = S;
  const A = { CM: ["campaign_manager"], RV: ["reviewer"], DO: ["draw_officer"], DA: ["draw_approver"], WO: ["winner_ops"], SU: ["support"], AU: ["auditor"], PA: ["platform_admin"] };
  const any = "any";
  const CAMPAIGN_STATUSES = ["draft", "active", "paused", "closed", "archived"];
  // These two routes write their own response and so bypass send(), which puts
  // no-store + nosniff on every other reply. An export of participant rows or
  // the audit log is the last response that should sit in a proxy or browser
  // cache, or be sniffed into another content type.
  const CSV_HEADERS = { "content-type": "text/csv", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const campaignOr404 = (id) => { const c = domain.getCampaign(id); if (!c) throw E.notFound("campaign not found"); return c; };
  /**
   * Decisions the design reserves for a NAMED business role. platform_admin is a
   * technical role that implies campaign_manager/support/auditor (auth.mjs), which
   * on these three routes meant the person who deploys the app and holds the
   * database could unmask any national ID and could remove or restore any entry
   * from the draw pool alone — deciding who is eligible for the weekly draw while
   * the draw itself still looked correctly two-person. The implication is dropped
   * HERE ONLY: every read route keeps it (the console relies on it, and a read is
   * audited), and a platform_admin who also genuinely holds the business role
   * still passes.
   */
  const requireLiteral = (user, ...roles) => { if (!auth.hasLiteralRole(user, ...roles)) throw E.forbidden(`requires one of: ${roles.join(", ")} (platform_admin does not imply it for this action)`); };
  const activeCampaignId = () => db.prepare(`select id from campaigns where status in ('active','paused') order by created_at desc limit 1`).get()?.id || null;

  // ---- auth / self ----------------------------------------------------------
  r.add("GET", "/api/whoami", { roles: any, allowPasswordChange: true, ...T("auth") }, ({ user }) => ({ id: user.id, name: user.name, email: user.email, roles: auth.roles(user), mfa: !!user.mfa_enabled, mustChangePassword: !!user.must_change_password, environment: domain.environment() }));
  r.add("POST", "/api/password", { roles: any, allowPasswordChange: true, ...T("auth"), body: { type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } } } }, async ({ user, body }) => { const b = await body(); const out = auth.changePassword(user.id, b); if (out.error) throw E.badRequest(out.error); domain.audit({ actorType: "admin", actorId: user.id, action: "staff.password_change", targetType: "admin_user", targetId: user.id }); return out; });
  r.add("POST", "/api/mfa/enroll", { roles: any, allowPasswordChange: true, ...T("auth") }, ({ user }) => auth.enrollMfa(user.id));
  r.add("POST", "/api/mfa/enable", { roles: any, allowPasswordChange: true, ...T("auth") }, async ({ user, body }) => { const b = await body(); const out = auth.enableMfa(user.id, b.code); if (out.error) throw E.badRequest(out.error); domain.audit({ actorType: "admin", actorId: user.id, action: "staff.mfa_enabled", targetType: "admin_user", targetId: user.id }); return out; });
  r.add("POST", "/api/mfa/disable", { roles: any, ...T("auth") }, async ({ user, body }) => { const b = await body(); const out = auth.disableMfa(user.id, b.code); if (out.error) throw E.badRequest(out.error); domain.audit({ actorType: "admin", actorId: user.id, action: "staff.mfa_disabled", targetType: "admin_user", targetId: user.id }); return out; });

  // ---- staff ----------------------------------------------------------------
  r.add("GET", "/api/users", { roles: A.PA, ...T("staff") }, () => ({ users: auth.listUsers().map((u) => ({ ...u, roles: JSON.parse(u.roles || "[]") })), roles: ALL_ROLES }));
  // The draw's only four-eyes control is "approver id differs from operator id"
  // (src/draw.mjs), so one account holding both roles defeats it outright.
  const bothDrawRoles = (roles) => Array.isArray(roles) && roles.includes("draw_officer") && roles.includes("draw_approver");
  r.add("POST", "/api/users", { roles: A.PA, ...T("staff"), body: { type: "object", required: ["email", "roles"], properties: { email: { type: "string" }, name: { type: "string" }, roles: { type: "array" } } } }, async ({ user, body }) => { const b = await body(); if (bothDrawRoles(b.roles)) throw E.badRequest("draw_officer and draw_approver must be held by different accounts"); const out = auth.createUser({ email: b.email, name: b.name, roles: b.roles || [], createdBy: user.id }); return { __status: 201, body: { user: { ...out.user, roles: JSON.parse(out.user.roles) }, temporaryPassword: out.temporaryPassword } }; });
  r.add("PATCH", "/api/users/:id", { roles: A.PA, ...T("staff") }, async ({ user, params, body }) => {
    const b = await body();
    if (params.id === user.id && b.status && b.status !== "active") throw E.badRequest("you cannot disable yourself");
    // Self-disable was blocked but self-grant was not: a platform_admin could
    // PATCH draw_officer + draw_approver onto its own account and then both run
    // and approve a draw. A role change must be made by someone else.
    if (params.id === user.id && b.roles !== undefined) throw E.badRequest("you cannot change your own roles; another platform admin must do it");
    if (bothDrawRoles(b.roles)) throw E.badRequest("draw_officer and draw_approver must be held by different accounts");
    return { user: auth.updateUser(params.id, { roles: b.roles, status: b.status, name: b.name }, user.id) };
  });
  r.add("POST", "/api/users/:id/reset-password", { roles: A.PA, ...T("staff") }, ({ user, params }) => auth.resetPassword(params.id, user.id));

  // ---- campaigns ----------------------------------------------------------------
  r.add("GET", "/api/campaigns", { roles: any, ...T("campaigns") }, () => ({ campaigns: domain.listCampaigns().map((c) => ({ ...c, draw_config: JSON.parse(c.draw_config_json || "{}"), active_version: domain.getActiveVersion(c.id)?.version_no || null, pause: domain.getPauseFlags(c.id), open_decisions: domain.listDecisions(c.id).filter((d) => d.blocks_activation && d.status !== "approved" && d.status !== "not_required").length })) }));
  r.add("POST", "/api/campaigns", { roles: A.CM, ...T("campaigns"), body: { type: "object", required: ["code", "start_at", "end_at"] } }, async ({ user, body }) => {
    const b = await body();
    if (!b.code || !b.start_at || !b.end_at) throw E.badRequest("code, start_at, end_at required");
    if (!/^[A-Z0-9-]{3,40}$/.test(b.code)) throw E.badRequest("code must be A-Z, 0-9, dashes");
    if (Number.isNaN(Date.parse(b.start_at)) || Number.isNaN(Date.parse(b.end_at))) throw E.badRequest("start_at and end_at must be ISO-8601");
    if (Date.parse(b.end_at) <= Date.parse(b.start_at)) throw E.badRequest("end_at must be after start_at");
    if (domain.getCampaignByCode(b.code)) throw E.conflict(`campaign code "${b.code}" already exists`);
    const c = domain.createCampaign({ code: b.code, name: str(b.name, 120) || b.code, startAt: b.start_at, endAt: b.end_at, timezone: str(b.timezone, 60) || "Africa/Harare", drawConfig: b.draw_config || {}, actorId: user.id });
    const vid = domain.createVersion(c.id, { content: b.content || {}, rules: b.rules || {}, flags: b.flags || {} }, user.id);
    return { __status: 201, body: { ...c, draft_version_id: vid } };
  });
  r.add("GET", "/api/campaigns/:id", { roles: any, ...T("campaigns") }, ({ params }) => { const c = campaignOr404(params.id); const v = domain.getActiveVersion(c.id); return { campaign: { ...c, draw_config: JSON.parse(c.draw_config_json || "{}") }, active_version: v ? { ...v, content: JSON.parse(v.content_json || "{}"), rules: JSON.parse(v.rules_json || "{}"), flags: JSON.parse(v.flags_json || "{}") } : null, versions: domain.listVersions(c.id).map((x) => ({ id: x.id, version_no: x.version_no, status: x.status, frozen_at: x.frozen_at, config_hash: x.config_hash })), periods: domain.listPeriods(c.id), decisions: domain.listDecisions(c.id), outlet_count: domain.listCampaignOutlets(c.id).length, pause: domain.getPauseFlags(c.id) }; });
  r.add("PATCH", "/api/campaigns/:id", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); return { campaign: domain.updateCampaign(params.id, { name: str(b.name, 120), startAt: b.start_at, endAt: b.end_at, timezone: str(b.timezone, 60), drawConfig: b.draw_config }, user.id) }; });
  r.add("POST", "/api/campaigns/:id/status", { roles: A.CM, ...T("campaigns"), body: { type: "object", required: ["status"] } }, async ({ user, params, body }) => {
    const b = await body(); campaignOr404(params.id);
    // An unknown status reached services.mjs as a plain Error, which the router
    // reports as 500 INTERNAL with the reason suppressed — an operator mistake
    // that looked like a platform outage and filled the error log.
    if (!CAMPAIGN_STATUSES.includes(b.status)) throw E.badRequest(`status must be one of: ${CAMPAIGN_STATUSES.join(", ")}`);
    if (b.status === "active" && domain.environment() === "production") { const v = await validateActivation({ domain, auth, campaignId: params.id, cfg, extractor, transport, crm, db }); if (!v.ok) throw E.conflict("production activation blocked", { failures: v.failures.filter((f) => f.blocking) }); }
    return { campaign: domain.setCampaignStatus(params.id, b.status, user.id, str(b.reason, 300)) };
  });
  r.add("POST", "/api/campaigns/:id/pause", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); return { pause: domain.setPauseFlags(params.id, Object.fromEntries(Object.entries(b).filter(([k]) => ["intake", "auto_qualify", "outbound", "draws"].includes(k)).map(([k, v]) => [k, !!v])), user.id) }; });
  r.add("POST", "/api/campaigns/:id/clone", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); if (!b.code) throw E.badRequest("code required"); if (domain.getCampaignByCode(b.code)) throw E.conflict("code exists"); return { __status: 201, body: domain.cloneCampaign(params.id, { code: b.code, name: str(b.name, 120), startAt: b.start_at, endAt: b.end_at }, user.id) }; });
  r.add("GET", "/api/campaigns/:id/activation", { roles: [...A.CM, ...A.AU], ...T("campaigns") }, async ({ params }) => { campaignOr404(params.id); return validateActivation({ domain, auth, campaignId: params.id, cfg, extractor, transport, crm, db }); });
  // versions
  // An unknown or already-activated version id reached services.mjs as a plain
  // Error and came back as 500 INTERNAL; the honest answers are 404 and 409.
  const versionOr404 = (vid, { campaignId = null, draft = false } = {}) => {
    const v = domain.getVersion(vid);
    if (!v || (campaignId && v.campaign_id !== campaignId)) throw E.notFound("version not found");
    if (draft && v.status !== "draft") throw E.conflict(`only draft versions can be changed (status=${v.status})`);
    return v;
  };
  r.add("GET", "/api/campaigns/:id/versions", { roles: any, ...T("campaigns") }, ({ params }) => ({ versions: domain.listVersions(params.id).map((v) => ({ id: v.id, version_no: v.version_no, status: v.status, frozen_at: v.frozen_at, frozen_by: v.frozen_by, config_hash: v.config_hash, content: JSON.parse(v.content_json || "{}"), rules: JSON.parse(v.rules_json || "{}"), flags: JSON.parse(v.flags_json || "{}") })) }));
  r.add("POST", "/api/campaigns/:id/versions", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); const vid = b.from_active ? domain.newVersionFrom(params.id, b, user.id) : domain.createVersion(params.id, { content: b.content || {}, rules: b.rules || {}, flags: b.flags || {} }, user.id); return { __status: 201, body: { versionId: vid } }; });
  r.add("PATCH", "/api/campaigns/:id/versions/:vid", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); versionOr404(params.vid, { draft: true }); return { version: domain.updateDraftVersion(params.vid, { content: b.content, rules: b.rules, flags: b.flags }, user.id) }; });
  r.add("POST", "/api/campaigns/:id/versions/:vid/activate", { roles: A.CM, ...T("campaigns") }, ({ user, params }) => {
    const c = campaignOr404(params.id);
    const target = versionOr404(params.vid, { campaignId: params.id, draft: true });
    // Swapping the live rule set is an activation too. The production gate used
    // to cover only the draft -> active STATUS transition, so once a campaign was
    // live a single campaign_manager could install a version that loosened the
    // rules (one pack qualifies) or dropped the terms URL, with no validation at
    // all. Only the content/rules checks are re-run, against the version being
    // INSTALLED (see validateVersionContentRules), so a mid-campaign correction
    // is not blocked by an unrelated provider blip.
    if (["active", "paused"].includes(c.status) && domain.environment() === "production") {
      const v = validateVersionContentRules({ domain, campaignId: params.id, version: target });
      if (!v.ok) throw E.conflict("production activation blocked: this version would change the live rules", { failures: v.failures });
    }
    const v = domain.activateVersion(params.id, params.vid, user.id);
    return { versionId: v.id, status: v.status, config_hash: v.config_hash };
  });
  // periods
  r.add("GET", "/api/campaigns/:id/periods", { roles: any, ...T("campaigns") }, ({ params }) => ({ periods: domain.listPeriods(params.id).map((p) => ({ ...p, prize_config: JSON.parse(p.prize_config_json || "{}") })) }));
  r.add("POST", "/api/campaigns/:id/periods", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id);
    // Same reason as above: missing or reversed dates are the caller's mistake
    // (400), not an internal fault.
    if (!b.code || !b.starts_at || !b.ends_at) throw E.badRequest("code, starts_at and ends_at are required");
    if (Number.isNaN(Date.parse(b.starts_at)) || Number.isNaN(Date.parse(b.ends_at))) throw E.badRequest("starts_at and ends_at must be ISO-8601");
    if (Date.parse(b.ends_at) <= Date.parse(b.starts_at)) throw E.badRequest("ends_at must be after starts_at");
    return { __status: 201, body: domain.upsertPeriod(params.id, { code: str(b.code, 20), label: str(b.label, 80), startsAt: b.starts_at, endsAt: b.ends_at, drawAt: b.draw_at, prizeConfig: b.prize_config, status: b.status }, user.id) }; });
  // outlets membership + import
  r.add("GET", "/api/campaigns/:id/outlets", { roles: any, ...T("outlets") }, ({ params }) => ({ outlets: domain.listCampaignOutlets(params.id) }));
  r.add("PUT", "/api/campaigns/:id/outlets", { roles: A.CM, ...T("outlets") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); if (!Array.isArray(b.outlet_ids)) throw E.badRequest("outlet_ids array required"); return { count: domain.setCampaignOutlets(params.id, b.outlet_ids, user.id, { collectionByOutlet: b.collection || {} }) }; });
  // Targeted removal of ONE membership row. Without it the console's Remove
  // button had to full-replace the membership through the PUT above, which
  // deleted every member whose master outlet row is inactive (the listing the
  // console builds the PUT body from filters them out, so the operator never
  // saw them) and reset every surviving member's collection window to always
  // open.
  r.add("DELETE", "/api/campaigns/:id/outlets/:outletId", { roles: A.CM, ...T("outlets") }, ({ user, params }) => { campaignOr404(params.id); if (!domain.removeCampaignOutlet(params.id, params.outletId, user.id)) throw E.notFound("outlet is not a member of this campaign"); return { removed: params.outletId }; });
  r.add("POST", "/api/campaigns/:id/outlets/import", { roles: A.CM, ...T("outlets"), bodyLimit: 2 * 1024 * 1024 }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); if (typeof b.csv !== "string") throw E.badRequest("csv text required"); return domain.importOutletsCsv(params.id, b.csv, { dryRun: b.dry_run !== false, actorId: user.id }); });
  // decisions
  r.add("GET", "/api/campaigns/:id/decisions", { roles: any, ...T("campaigns") }, ({ params }) => ({ decisions: domain.listDecisions(params.id) }));
  r.add("PUT", "/api/campaigns/:id/decisions/:did", { roles: A.CM, ...T("campaigns") }, async ({ user, params, body }) => { const b = await body(); campaignOr404(params.id); if (b.status === "approved" && !b.approved_value) throw E.badRequest("approved_value required to approve"); return { decision: domain.upsertDecision(params.id, { decision_id: params.did, question: str(b.question, 300), test_value: str(b.test_value, 500), approved_value: str(b.approved_value, 500), status: b.status, owner: str(b.owner, 80), evidence: str(b.evidence, 500), blocks_activation: b.blocks_activation }, user.id) }; });

  // ---- master data ---------------------------------------------------------------
  r.add("GET", "/api/outlets", { roles: any, ...T("outlets") }, () => ({ outlets: domain.listOutlets() }));
  r.add("POST", "/api/outlets", { roles: A.CM, ...T("outlets") }, async ({ user, body }) => { const o = await body(); if (!o.outlet_code || !o.retailer || !o.town) throw E.badRequest("outlet_code, retailer, town required"); return { __status: 201, body: domain.upsertOutlet(o, user.id) }; });
  r.add("GET", "/api/outlets/export.csv", { roles: [...A.CM, ...A.AU], produces: "text/csv", ...T("outlets") }, ({ res }) => { const rows = domain.listOutlets(); const head = ["outlet_code", "retailer", "branch", "town", "province", "collection_enabled", "active_from", "active_to", "aliases", "active"]; const csv = [head.join(","), ...rows.map((o) => head.map((k) => csvCell(k === "aliases" ? JSON.parse(o.aliases_json || "[]").join(";") : o[k])).join(","))].join("\r\n"); res.writeHead(200, { ...CSV_HEADERS, "content-disposition": "attachment; filename=outlets.csv" }); res.end(csv); });
  r.add("GET", "/api/products", { roles: any, ...T("products") }, () => ({ products: domain.listProducts().map((p) => ({ ...p, aliases: JSON.parse(p.aliases_json || "[]") })) }));
  r.add("POST", "/api/products", { roles: A.CM, ...T("products") }, async ({ body }) => { const p = await body(); if (!p.sku || !p.name) throw E.badRequest("sku and name required"); return { __status: 201, body: { id: domain.upsertProduct(p) } }; });

  // ---- participants -------------------------------------------------------------------
  r.add("GET", "/api/participants", { roles: [...A.SU, ...A.RV, ...A.WO, ...A.AU, ...A.CM], ...T("participants"), query: { q: "search", campaign: "campaign id" } }, ({ url }) => { const pg = page(url); const rows = domain.searchParticipants({ q: str(url.searchParams.get("q"), 60) || "", campaignId: url.searchParams.get("campaign"), limit: pg.limit, offset: pg.offset }); return { participants: rows, next: pg.next(rows) }; });
  r.add("GET", "/api/participants/:id", { roles: [...A.SU, ...A.RV, ...A.WO, ...A.AU, ...A.CM], ...T("participants") }, ({ params }) => {
    const p = domain.getParticipant(params.id); if (!p) throw E.notFound();
    const enrollments = db.prepare(`select e.*, c.code as campaign_code from campaign_enrollments e join campaigns c on c.id=e.campaign_id where e.participant_id=?`).all(p.id);
    const submissions = db.prepare(`select id, campaign_id, status, reason_code, period_code, selected_outlet_id, created_at, decided_at from receipts where participant_id=? order by created_at desc limit 100`).all(p.id).map((s) => ({ ...s, reference: shortRef(s.id) }));
    const entries = db.prepare(`select id, receipt_id, period_code, status, created_at from entries where participant_id=? order by created_at desc`).all(p.id);
    return { participant: { id: p.id, first_name: p.first_name, surname: p.surname, location: p.location, status: p.status, phone: domain.maskPhone(p.wa_phone_uid), identity_masked: p.identity_masked, created_at: p.created_at, row_version: p.row_version, marketing_consent: !!p.marketing_consent }, enrollments, submissions, entries };
  });
  r.add("PATCH", "/api/participants/:id", { roles: [...A.SU, ...A.CM], ...T("participants") }, async ({ user, params, body }) => { const b = await body(); return { participant: mask(domain.updateParticipant(params.id, { firstName: str(b.first_name, 60), surname: str(b.surname, 60), location: str(b.location, 80) }, user.id, str(b.reason, 200) || "support correction")) }; });
  r.add("POST", "/api/participants/:id/reveal-identity", { roles: [...A.WO, ...A.AU], ...T("participants") }, async ({ user, params, body }) => { requireLiteral(user, ...A.WO, ...A.AU); const b = await body(); if (!b.reason) throw E.badRequest("reason required"); const v = domain.revealIdentity(params.id, user.id, str(b.reason, 200)); return { identity: v }; });
  r.add("POST", "/api/participants/:id/withdraw", { roles: [...A.SU, ...A.PA], ...T("participants") }, async ({ user, params, body }) => { const b = await body(); const p = domain.getParticipant(params.id); if (!p) throw E.notFound(); return { participant: mask(domain.withdrawParticipant(p.wa_phone_uid, user.id, str(b.reason, 200) || "support request")) }; });
  r.add("POST", "/api/participants/:id/anonymise", { roles: A.PA, ...T("participants") }, async ({ user, params, body }) => { const b = await body(); if (!b.reason) throw E.badRequest("reason required"); return { participant: mask(domain.anonymiseParticipant(params.id, user.id, str(b.reason, 200))) }; });
  r.add("POST", "/api/participants/:id/phone", { roles: [...A.SU, ...A.PA], ...T("participants") }, async ({ user, params, body }) => { const b = await body(); if (!b.phone || !b.reason) throw E.badRequest("phone and reason required"); return { participant: mask(domain.changePhone(params.id, b.phone, user.id, str(b.reason, 200))) }; });
  const mask = (p) => ({ id: p.id, first_name: p.first_name, surname: p.surname, location: p.location, status: p.status, phone: domain.maskPhone(p.wa_phone_uid), identity_masked: p.identity_masked });

  // ---- receipts + review ---------------------------------------------------------------
  r.add("GET", "/api/receipts", { roles: [...A.RV, ...A.SU, ...A.AU, ...A.CM, ...A.DO], ...T("receipts"), query: { status: "status", campaign: "campaign id", participant: "participant id", outlet: "outlet id", period: "period code", since: "ISO", reference: "R-xxxxxxxx" } }, ({ url }) => {
    const q = url.searchParams; const pg = page(url); const where = ["1=1"], args = [];
    if (q.get("status")) { where.push("r.status=?"); args.push(q.get("status")); }
    if (q.get("campaign")) { where.push("r.campaign_id=?"); args.push(q.get("campaign")); }
    if (q.get("participant")) { where.push("r.participant_id=?"); args.push(q.get("participant")); }
    if (q.get("outlet")) { where.push("r.selected_outlet_id=?"); args.push(q.get("outlet")); }
    if (q.get("period")) { where.push("r.period_code=?"); args.push(q.get("period")); }
    if (q.get("since")) { where.push("r.created_at>=?"); args.push(q.get("since")); }
    if (q.get("reference")) { where.push("upper(r.id) like ?"); args.push(`RCPT_${String(q.get("reference")).replace(/^R-/i, "").toLowerCase()}%`); }
    const rows = db.prepare(`select r.id, r.status, r.reason_code, r.participant_id, r.campaign_id, r.period_code, r.selected_outlet_id, r.created_at, r.decided_at, r.row_version, rt.state as review_state, rt.assignee, rt.sla_due_at from receipts r left join review_tasks rt on rt.receipt_id=r.id where ${where.join(" and ")} order by r.created_at desc limit ? offset ?`).all(...args, pg.limit, pg.offset).map((x) => ({ ...x, reference: shortRef(x.id) }));
    return { receipts: rows, next: pg.next(rows) };
  });
  r.add("GET", "/api/reviews/queue", { roles: [...A.RV, ...A.SU, ...A.CM, ...A.DO], ...T("receipts") }, () => {
    const open = db.prepare(`select rt.*, r.reason_code, r.campaign_id, r.period_code from review_tasks rt join receipts r on r.id=rt.receipt_id where rt.state!='decided' order by rt.created_at`).all();
    const byReason = {}; for (const t of open) byReason[t.reason_code] = (byReason[t.reason_code] || 0) + 1;
    return { count: open.length, oldest: open[0]?.created_at || null, overdue: open.filter((t) => Date.parse(t.sla_due_at) < Date.now()).length, byReason, items: open.map((t) => ({ receipt_id: t.receipt_id, reference: shortRef(t.receipt_id), reason: t.reason_code, assignee: t.assignee, age_minutes: Math.round((Date.now() - Date.parse(t.created_at)) / 60000), sla_due_at: t.sla_due_at, period: t.period_code })) };
  });
  r.add("GET", "/api/receipts/:id", { roles: [...A.RV, ...A.SU, ...A.AU, ...A.CM, ...A.DO], ...T("receipts") }, ({ params, user }) => {
    const x = db.prepare(`select * from receipts where id=?`).get(params.id); if (!x) throw E.notFound();
    const canView = auth.hasRole(user, "reviewer", "auditor");
    const media = x.media_asset_id ? mediaStore.get(x.media_asset_id) : null;
    const validation = db.prepare(`select id, attempt_no, extractor_provider, extractor_version, facts_json, confidence, rule_results_json, decision, error, created_at, schema_version, latency_ms, ocr_text from validation_results where receipt_id=? order by attempt_no`).all(x.id).map((v) => ({ ...v, facts: JSON.parse(v.facts_json || "null"), rules: JSON.parse(v.rule_results_json || "[]"), facts_json: undefined, rule_results_json: undefined, ocr_text: canView ? v.ocr_text : undefined }));
    const duplicates = db.prepare(`select d.*, c.status as candidate_status, c.participant_id as candidate_participant_id from duplicate_candidates d join receipts c on c.id=d.candidate_receipt_id where d.receipt_id=? or d.candidate_receipt_id=?`).all(x.id, x.id).map((d) => ({ ...d, candidate_reference: shortRef(d.candidate_receipt_id), same_participant: d.candidate_participant_id === x.participant_id, candidate_participant_id: undefined }));
    const attempts = db.prepare(`select id, status, created_at from receipts where reupload_of=? or id=?`).all(x.id, x.reupload_of || "").map((a) => ({ ...a, reference: shortRef(a.id) }));
    if (canView) domain.audit({ actorType: "admin", actorId: user.id, action: "receipt.viewed", targetType: "receipt", targetId: x.id });
    return { receipt: { ...x, reference: shortRef(x.id), outlet: domain.getOutlet(x.selected_outlet_id), outlet_match: JSON.parse(x.outlet_match_json || "[]"), quality: JSON.parse(x.quality_json || "null"), participant: mask(domain.getParticipant(x.participant_id) || {}) }, media: canView && media ? { original: signMediaUrl(media.id, mediaSecret), normalised: { ...signMediaUrl(media.id, mediaSecret), url: signMediaUrl(media.id, mediaSecret).url + "&v=normalised" }, width: media.width, height: media.height, mime: media.mime, status: media.status } : null, validation, items: db.prepare(`select * from receipt_items where receipt_id=?`).all(x.id), duplicates, review: db.prepare(`select * from review_tasks where receipt_id=?`).get(x.id) || null, attempts, entry: db.prepare(`select * from entries where receipt_id=?`).get(x.id) || null, rules_version: domain.getVersion(x.campaign_version_id)?.config_hash };
  });
  r.add("GET", "/api/media/:id", { roles: [...A.RV, ...A.AU], allowTokenQuery: true, produces: ["image/jpeg", "image/png"], ...T("receipts") }, ({ params, url, res }) => {
    if (!verifyMediaSig(params.id, url.searchParams.get("exp"), url.searchParams.get("sig"), mediaSecret)) throw E.forbidden("invalid or expired media link");
    const a = mediaStore.get(params.id); const bytes = a ? mediaStore.readBytes(a, { normalised: url.searchParams.get("v") === "normalised" }) : null;
    if (!bytes) throw E.notFound("media not found");
    res.writeHead(200, { "content-type": url.searchParams.get("v") === "normalised" ? "image/png" : a.mime, "content-length": bytes.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" }); res.end(bytes);
  });
  r.add("POST", "/api/receipts/:id/assign", { roles: A.RV, ...T("receipts") }, ({ user, params }) => { const t = db.prepare(`select * from review_tasks where receipt_id=?`).get(params.id); if (!t) throw E.notFound("no review task"); if (t.assignee && t.assignee !== user.id && t.state === "assigned") throw E.conflict(`assigned to ${t.assignee}`); db.prepare(`update review_tasks set state='assigned', assignee=?, assigned_at=? where receipt_id=? and state!='decided'`).run(user.id, new Date().toISOString(), params.id); return { ok: true }; });
  r.add("POST", "/api/receipts/:id/release", { roles: A.RV, ...T("receipts") }, ({ params }) => { db.prepare(`update review_tasks set state='open', assignee=null where receipt_id=? and state='assigned'`).run(params.id); return { ok: true }; });
  r.add("POST", "/api/receipts/:id/review", { roles: A.RV, ...T("receipts"), body: { type: "object", required: ["decision"], properties: { decision: { enum: ["QUALIFIED", "NOT_QUALIFIED", "DUPLICATE", "REUPLOAD_REQUIRED"] }, reason_code: { type: "string" }, note: { type: "string" }, expected_version: { type: "integer" } } } }, async ({ user, params, body }) => { const b = await body(); const out = pipeline.review(params.id, { reviewer: user.id, decision: b.decision, reasonCode: str(b.reason_code, 60), note: str(b.note, 500), expectedVersion: b.expected_version }); return { receiptId: out.receiptId, decision: out.decision, entryId: out.entryId }; });
  r.add("POST", "/api/receipts/:id/reprocess", { roles: [...A.RV, ...A.PA], ...T("receipts") }, async ({ user, params, body }) => { const b = await body(); return pipeline.reprocess(params.id, user.id, str(b.reason, 200)); });
  r.add("POST", "/api/duplicates/:id/resolve", { roles: A.RV, ...T("receipts") }, async ({ user, params, body }) => { const b = await body(); return { candidate: pipeline.resolveDuplicate(params.id, b.resolution, user.id, str(b.note, 300)) }; });

  // ---- entries -------------------------------------------------------------------------
  r.add("GET", "/api/entries", { roles: [...A.RV, ...A.SU, ...A.AU, ...A.CM, ...A.DO, ...A.DA, ...A.WO], ...T("entries"), query: { campaign: "", period: "", status: "", participant: "" } }, ({ url }) => { const q = url.searchParams; const pg = page(url); const where = ["1=1"], args = []; for (const [k, col] of [["campaign", "campaign_id"], ["period", "period_code"], ["status", "status"], ["participant", "participant_id"]]) if (q.get(k)) { where.push(`${col}=?`); args.push(q.get(k)); } const rows = db.prepare(`select * from entries where ${where.join(" and ")} order by created_at desc limit ? offset ?`).all(...args, pg.limit, pg.offset).map((e) => ({ ...e, reference: shortRef(e.receipt_id) })); return { entries: rows, next: pg.next(rows) }; });
  r.add("GET", "/api/entries/:id", { roles: [...A.RV, ...A.SU, ...A.AU, ...A.CM, ...A.DO, ...A.DA, ...A.WO], ...T("entries") }, ({ params }) => { const e = db.prepare(`select * from entries where id=?`).get(params.id); if (!e) throw E.notFound(); return { entry: { ...e, reference: shortRef(e.receipt_id) }, events: db.prepare(`select * from entry_events where entry_id=? order by created_at`).all(e.id), receipt: db.prepare(`select id, status, reason_code, selected_outlet_id, period_code, canonical_receipt_id, campaign_version_id, decided_by, decided_at from receipts where id=?`).get(e.receipt_id), validation: db.prepare(`select attempt_no, extractor_provider, extractor_version, decision, created_at from validation_results where receipt_id=? order by attempt_no`).all(e.receipt_id), canonical: db.prepare(`select * from canonical_receipts where id=?`).get(e.canonical_receipt_id), rules_version: domain.getVersion(e.campaign_version_id)?.config_hash, draws: db.prepare(`select d.id, d.draw_period, d.status, c.status as candidate_status from draw_candidates c join draws d on d.id=c.draw_id where c.entry_id=?`).all(e.id), audit: db.prepare(`select action, actor_id, reason, created_at from audit_events where (target_type='entry' and target_id=?) or (target_type='receipt' and target_id=?) order by id`).all(e.id, e.receipt_id) }; });
  const entryOr404 = (eid) => { if (!db.prepare(`select 1 from entries where id=?`).get(eid)) throw E.notFound("entry not found"); };
  r.add("POST", "/api/entries/:id/disqualify", { roles: [...A.RV, ...A.CM], ...T("entries") }, async ({ user, params, body }) => { const b = await body(); entryOr404(params.id); requireLiteral(user, ...A.RV, ...A.CM); return pipeline.disqualifyEntry(params.id, { actorId: user.id, reason: str(b.reason, 300), approvedBy: str(b.approved_by, 60), note: str(b.note, 500) }); });
  r.add("POST", "/api/entries/:id/reinstate", { roles: [...A.RV, ...A.CM], ...T("entries") }, async ({ user, params, body }) => { const b = await body(); entryOr404(params.id); requireLiteral(user, ...A.RV, ...A.CM); return pipeline.reinstateEntry(params.id, { actorId: user.id, reason: str(b.reason, 300), approvedBy: str(b.approved_by, 60) }); });

  // ---- draws ---------------------------------------------------------------------------
  r.add("GET", "/api/campaigns/:id/draws", { roles: [...A.DO, ...A.DA, ...A.AU, ...A.WO, ...A.CM], ...T("draws") }, ({ params }) => ({ draws: drawService.list(params.id) }));
  r.add("GET", "/api/campaigns/:id/periods/:pid/barrier", { roles: [...A.DO, ...A.DA, ...A.AU, ...A.CM], ...T("draws") }, ({ params }) => { const b = drawService.barrier(params.id, params.pid); return { ok: b.ok, blockers: b.blockers, eligible: b.eligible.length, distinctParticipants: new Set(b.eligible.map((e) => e.participant_id)).size, exclusions: b.exclusions.length, plan: b.plan, period: b.period }; });
  r.add("POST", "/api/draws", { roles: A.DO, ...T("draws"), body: { type: "object", required: ["campaign_id", "period_id"] } }, async ({ user, body }) => { const b = await body(); if (!b.campaign_id || !b.period_id) throw E.badRequest("campaign_id and period_id required"); if (domain.getPauseFlags(b.campaign_id).draws) throw E.conflict("draws are paused for this campaign"); const d = drawService.freeze({ campaignId: b.campaign_id, periodId: b.period_id, actorId: user.id, override: b.override?.allow ? { allow: b.override.allow.filter((c) => c === "UNRESOLVED_SUBMISSIONS"), reason: str(b.override.reason, 300) } : null }); return { __status: 201, body: { draw: view(d) } }; });
  r.add("GET", "/api/draws/:id", { roles: [...A.DO, ...A.DA, ...A.AU, ...A.WO, ...A.CM], ...T("draws") }, ({ params }) => { const d = drawService.get(params.id); if (!d) throw E.notFound(); return { draw: view(d, true), candidates: drawService.candidates(d.id).length, attempts: db.prepare(`select actor_id, outcome, detail, created_at from draw_attempts where draw_id=? order by created_at`).all(d.id), winners: winners.listByDraw(d.id).map((w) => ({ id: w.id, rank: w.rank, status: w.status, prize_code: w.prize_code, publication_state: w.publication_state })) }; });
  const view = (d, full = false) => ({ id: d.id, campaign_id: d.campaign_id, period_id: d.period_id, period: d.period_code || d.draw_period, draw_label: d.draw_period, status: d.status, snapshot_hash: d.snapshot_hash, output_hash: d.output_hash, operator_id: d.operator_id, approver_id: d.approver_id, executed_at: d.executed_at, approved_at: d.approved_at, published_at: d.published_at, created_at: d.created_at, supersedes: d.supersedes, superseded_by: d.superseded_by, void_reason: d.void_reason, plan: JSON.parse(d.prize_plan_json || "{}"), barrier: JSON.parse(d.barrier_json || "{}"), ...(full ? { output: d.output_json ? (() => { const o = JSON.parse(d.output_json); return { winners: o.winners, alternates: o.alternates.length, sequence_length: o.sequence.length }; })() : null, integrity: drawService.verifyStored(d) } : {}) });
  r.add("POST", "/api/draws/:id/execute", { roles: A.DO, ...T("draws") }, ({ user, params }) => ({ draw: view(drawService.execute(params.id, user.id), true) }));
  r.add("POST", "/api/draws/:id/approve", { roles: A.DA, ...T("draws"), body: { type: "object", properties: { expected_output_hash: { type: "string" }, note: { type: "string" } } } }, async ({ user, params, body }) => { const b = await body(); return { draw: view(drawService.approve(params.id, user.id, { expectedOutputHash: b.expected_output_hash || null, note: str(b.note, 300) }), true) }; });
  r.add("POST", "/api/draws/:id/reject", { roles: A.DA, ...T("draws") }, async ({ user, params, body }) => { const b = await body(); if (!b.reason) throw E.badRequest("reason required"); return { draw: view(drawService.reject(params.id, user.id, str(b.reason, 300))) }; });
  r.add("POST", "/api/draws/:id/publish", { roles: A.WO, ...T("draws") }, ({ user, params }) => { const d = drawService.publish(params.id, user.id); const m = winners.materialise(d.id, user.id); return { draw: view(d), winners: m.created, idempotent: m.idempotent }; });
  r.add("POST", "/api/draws/:id/winners", { roles: A.WO, ...T("draws") }, ({ user, params }) => winners.materialise(params.id, user.id));
  r.add("POST", "/api/draws/:id/void", { roles: A.DA, ...T("draws") }, async ({ user, params, body }) => { const b = await body(); return { draw: view(drawService.voidDraw(params.id, user.id, str(b.reason, 300), str(b.approved_by, 60))) }; });
  r.add("POST", "/api/draws/:id/rerun", { roles: A.DO, ...T("draws") }, async ({ user, params, body }) => { const b = await body(); if (!b.reason) throw E.badRequest("reason required"); return { draw: view(drawService.rerun(params.id, user.id, str(b.reason, 300), str(b.approved_by, 60))) }; });
  r.add("GET", "/api/draws/:id/bundle", { roles: [...A.AU, ...A.DA], ...T("draws") }, ({ user, params }) => drawService.bundle(params.id, user.id));
  r.add("GET", "/api/draws/:id/verify", { roles: [...A.AU, ...A.DA, ...A.DO], ...T("draws") }, ({ params }) => { const d = drawService.get(params.id); if (!d) throw E.notFound(); return drawService.verifyStored(d); });

  // ---- winners ------------------------------------------------------------------------
  r.add("GET", "/api/winners", { roles: [...A.WO, ...A.AU, ...A.DA, ...A.SU, ...A.CM], ...T("winners"), query: { campaign: "", draw: "", status: "" } }, ({ url }) => ({ winners: winners.list({ campaignId: url.searchParams.get("campaign"), drawId: url.searchParams.get("draw"), status: url.searchParams.get("status") }) }));
  r.add("GET", "/api/winners/:id", { roles: [...A.WO, ...A.AU, ...A.DA, ...A.SU], ...T("winners") }, ({ params }) => { const w = winners.get(params.id); if (!w) throw E.notFound(); const p = domain.getParticipant(w.participant_id); return { winner: { ...w, claim_token_hash: undefined, history: JSON.parse(w.history_json || "[]"), published_fields: JSON.parse(w.published_fields_json || "{}"), participant: p ? mask(p) : null, collection_outlet: w.collection_outlet_id ? domain.getOutlet(w.collection_outlet_id) : null }, claims: winners.claims(w.id), messages: db.prepare(`select id, purpose, status, attempts, error_code, last_error, created_at, sent_at, delivered_at, read_at from outbound_messages where idempotency_key like ? order by created_at`).all(`winner:${w.id}:%`) }; });
  r.add("POST", "/api/winners/:id/notify", { roles: A.WO, ...T("winners") }, ({ user, params }) => winners.notify(params.id, user.id));
  r.add("POST", "/api/winners/:id/transition", { roles: A.WO, ...T("winners"), body: { type: "object", required: ["status"] } }, async ({ user, params, body }) => { const b = await body(); return winners.transition(params.id, { status: b.status, actorId: user.id, note: str(b.note, 500), reason: str(b.reason, 300), expectedVersion: b.expected_version, collectionOutletId: str(b.collection_outlet_id, 60), fulfilmentRef: str(b.fulfilment_ref, 120), evidence: str(b.evidence, 300) }); });
  r.add("POST", "/api/winners/:id/publish", { roles: [...A.WO, ...A.CM], ...T("winners") }, ({ user, params }) => ({ winner: strip(winners.publish(params.id, user.id)) }));
  r.add("POST", "/api/winners/:id/unpublish", { roles: [...A.WO, ...A.CM], ...T("winners") }, async ({ user, params, body }) => { const b = await body(); return { winner: strip(winners.unpublish(params.id, user.id, str(b.reason, 300))) }; });
  const strip = (w) => ({ ...w, claim_token_hash: undefined });

  // ---- support / conversations -------------------------------------------------------------
  r.add("GET", "/api/conversations/:phone", { roles: [...A.SU, ...A.CM], ...T("support") }, ({ params }) => { const cid = activeCampaignId(); const s = cid ? domain.getSession(cid, params.phone) : null; const p = domain.getParticipantByPhone(params.phone); const ph = s?.wa_phone_uid || p?.wa_phone_uid; const inbound = ph ? db.prepare(`select id, event_kind, payload_json, status, received_at from channel_events where wa_phone_uid=? order by received_at desc limit 50`).all(ph).map((e) => ({ id: e.id, kind: e.event_kind, text: JSON.parse(e.payload_json).text, status: e.status, at: e.received_at, dir: "in" })) : []; const outbound = ph ? db.prepare(`select id, purpose, status, payload_json, created_at from outbound_messages where wa_phone_uid=? order by created_at desc limit 50`).all(ph).map((o) => ({ id: o.id, purpose: o.purpose, status: o.status, text: JSON.parse(o.payload_json).body || "[template]", at: o.created_at, dir: "out" })) : []; return { session: s ? { state: s.state, handoff_owner: s.handoff_owner, handoff_since: s.handoff_since, updated_at: s.updated_at } : null, participant: p ? mask(p) : null, transcript: [...inbound, ...outbound].sort((a, b) => a.at.localeCompare(b.at)) }; });
  r.add("POST", "/api/conversations/:phone/claim", { roles: A.SU, ...T("support") }, ({ user, params }) => { const cid = activeCampaignId(); if (!cid) throw E.conflict("no campaign"); conversation.claimHandoff(cid, params.phone, user.id); return { ok: true }; });
  r.add("POST", "/api/conversations/:phone/release", { roles: A.SU, ...T("support") }, ({ user, params }) => { const cid = activeCampaignId(); if (!cid) throw E.conflict("no campaign"); conversation.releaseHandoff(cid, params.phone, user.id); return { ok: true }; });
  r.add("POST", "/api/conversations/:phone/send", { roles: A.SU, ...T("support") }, async ({ user, params, body }) => { const b = await body(); if (!b.text) throw E.badRequest("text required"); const p = domain.getParticipantByPhone(params.phone); const out = outbox.enqueueWhatsApp({ waPhoneUid: p?.wa_phone_uid || params.phone, kind: "text", purpose: "support", campaignId: activeCampaignId(), payload: String(b.text).slice(0, 2000), idempotencyKey: `support:${user.id}:${Date.now()}` }); domain.audit({ actorType: "admin", actorId: user.id, action: "support.message", targetType: "conversation", targetId: domain.maskPhone(params.phone), payload: { len: String(b.text).length } }); return out; });
  r.add("POST", "/api/receipts/:id/resend-result", { roles: A.SU, ...T("support") }, ({ user, params }) => { const x = db.prepare(`select * from receipts where id=?`).get(params.id); if (!x) throw E.notFound(); const last = db.prepare(`select payload_json from outbound_messages where idempotency_key like ? order by created_at desc limit 1`).get(`receipt:${x.id}:outcome%`); if (!last) throw E.conflict("no result message exists yet"); const p = domain.getParticipant(x.participant_id); const out = outbox.enqueueWhatsApp({ waPhoneUid: p.wa_phone_uid, kind: "text", purpose: "receipt_outcome", campaignId: x.campaign_id, payload: JSON.parse(last.payload_json).body, idempotencyKey: `receipt:${x.id}:resend:${Date.now()}` }); domain.audit({ actorType: "admin", actorId: user.id, action: "support.resend_result", targetType: "receipt", targetId: x.id }); return out; });

  // ---- integrations / operations ---------------------------------------------------------------
  r.add("GET", "/api/integrations", { roles: [...A.PA, ...A.CM, ...A.AU, ...A.SU], ...T("operations") }, async () => ({ environment: domain.environment(), transport: transport.health?.() || { provider: cfg.whatsappTransport }, extractor: await extractor.health(), crm: await crm.health(), database: { ok: !!db.prepare(`select 1 as ok`).get().ok, file: cfg.database }, storage: { dir: cfg.mediaDir, assets: db.prepare(`select count(*) n from media_assets where status='stored'`).get().n }, worker: worker?.health?.() || null, queues: intake.stats(), outbound: outbox.stats(), crm_queue: crm.reconcileView(), last_outbound_success: db.prepare(`select max(sent_at) t from outbound_messages where status in ('sent','delivered','read')`).get().t, last_inbound: db.prepare(`select max(received_at) t from channel_events`).get().t, alerts_open: db.prepare(`select count(*) n from alerts where acknowledged_at is null`).get().n }));
  r.add("GET", "/api/outbound", { roles: [...A.PA, ...A.SU, ...A.WO, ...A.AU], ...T("operations"), query: { status: "" } }, ({ url }) => ({ messages: outbox.list({ status: url.searchParams.get("status") }).map((m) => ({ ...m, wa_phone_uid: domain.maskPhone(m.wa_phone_uid) })) }));
  r.add("POST", "/api/outbound/:id/retry", { roles: [...A.PA, ...A.SU, ...A.WO], ...T("operations") }, ({ user, params }) => { const ok = outbox.retry(params.id); if (ok) domain.audit({ actorType: "admin", actorId: user.id, action: "outbound.retry", targetType: "outbound_message", targetId: params.id }); return { ok }; });
  r.add("GET", "/api/crm/events", { roles: [...A.PA, ...A.SU, ...A.AU], ...T("operations"), query: { status: "" } }, ({ url }) => ({ events: crm.list({ status: url.searchParams.get("status") }), summary: crm.reconcileView() }));
  r.add("POST", "/api/crm/events/:id/retry", { roles: [...A.PA, ...A.SU], ...T("operations") }, ({ user, params }) => { const ok = crm.retry(params.id); if (ok) domain.audit({ actorType: "admin", actorId: user.id, action: "crm.retry", targetType: "crm_event", targetId: params.id }); return { ok }; });
  r.add("POST", "/api/crm/reconcile", { roles: [...A.PA, ...A.SU], ...T("operations") }, async ({ user }) => { const out = await crm.reconcile(); domain.audit({ actorType: "admin", actorId: user.id, action: "crm.reconcile", targetType: "crm", targetId: "all", payload: out }); return out; });
  r.add("GET", "/api/crm/mapping-preview", { roles: [...A.PA, ...A.CM, ...A.AU], ...T("operations"), query: { type: "entity type" } }, ({ url }) => { const t = url.searchParams.get("type") || "participant"; const samples = { participant: { id: "ptc_example", firstName: "Sample", surname: "Person", phone: "***0000", location: "Town", status: "active" }, entry: { id: "ent_example", participantId: "ptc_example", campaignCode: "CODE", period: "W1", outletCode: "SUN-HRE-01", reference: "R-EXAMPLE", status: "active" }, winner: { id: "win_example", participantId: "ptc_example", campaignCode: "CODE", period: "W1", prize: "Prize", rank: 1, status: "selected" }, submission: { id: "rcpt_example", participantId: "ptc_example", campaignCode: "CODE", reference: "R-EXAMPLE", outletCode: "SUN-HRE-01", status: "QUALIFIED", reason: "ok" }, claim: { id: "win_example", winnerId: "win_example", state: "collected", collectionOutlet: "SUN-HRE-01" }, enrollment: { id: "ptc_example", participantId: "ptc_example", campaignCode: "CODE", termsVersion: "T1", privacyVersion: "P1", marketingConsent: false } }; return { type: t, mapping_version: "crm-mapping/1", excluded_by_default: ["identity number", "raw receipt image", "OCR text"], record: crm.mappingPreview(t, samples[t] || samples.participant) }; });
  r.add("GET", "/api/queue", { roles: [...A.PA, ...A.SU, ...A.AU], ...T("operations") }, () => ({ ...intake.stats(), dead_events: db.prepare(`select id, event_kind, error, attempts, received_at from channel_events where status in ('dead','failed') order by received_at desc limit 50`).all(), dead_jobs: db.prepare(`select id, kind, last_error, attempts, created_at from jobs where status in ('dead','failed') order by created_at desc limit 50`).all() }));
  r.add("POST", "/api/queue/events/:id/replay", { roles: [...A.PA, ...A.SU], ...T("operations") }, ({ user, params }) => ({ ok: intake.replay(params.id, user.id) }));
  r.add("POST", "/api/queue/jobs/:id/retry", { roles: [...A.PA, ...A.SU], ...T("operations") }, ({ user, params }) => ({ ok: intake.retryJob(params.id, user.id) }));
  r.add("GET", "/api/alerts", { roles: [...A.PA, ...A.SU, ...A.CM, ...A.AU, ...A.RV, ...A.DO, ...A.DA, ...A.WO], ...T("operations") }, ({ url }) => ({ alerts: db.prepare(`select * from alerts ${url.searchParams.get("all") ? "" : "where acknowledged_at is null"} order by created_at desc limit 100`).all() }));
  r.add("POST", "/api/alerts/:id/ack", { roles: [...A.PA, ...A.SU, ...A.CM], ...T("operations") }, ({ user, params }) => { db.prepare(`update alerts set acknowledged_by=?, acknowledged_at=? where id=? and acknowledged_at is null`).run(user.id, new Date().toISOString(), params.id); return { ok: true }; });
  r.add("GET", "/api/settings/:key", { roles: [...A.PA, ...A.CM], ...T("operations") }, ({ params }) => ({ key: params.key, value: domain.getSetting(params.key, null) }));
  r.add("PUT", "/api/settings/:key", { roles: A.PA, ...T("operations") }, async ({ user, params, body }) => { const b = await body(); if (!/^[a-z0-9_.:-]{1,80}$/.test(params.key)) throw E.badRequest("bad key"); domain.setSetting(params.key, b.value, user.id); domain.audit({ actorType: "admin", actorId: user.id, action: "settings.update", targetType: "setting", targetId: params.key }); return { key: params.key, value: b.value }; });
  r.add("POST", "/api/evidence/:kind", { roles: [...A.CM, ...A.PA], ...T("operations") }, async ({ user, params, body }) => { const b = await body(); const allowed = ["receipt_benchmark_accepted", "restore_rehearsal", "client_uat_signoff", "load_benchmark"]; if (!allowed.includes(params.kind)) throw E.badRequest(`kind must be one of ${allowed.join(", ")}`); const v = { ...b, at: new Date().toISOString(), recordedBy: user.id }; domain.setSetting(`evidence.${params.kind}`, v, user.id); domain.audit({ actorType: "admin", actorId: user.id, action: "evidence.recorded", targetType: "evidence", targetId: params.kind, payload: v }); return { kind: params.kind, value: v }; });

  // ---- audit / reports / readiness ---------------------------------------------------------
  r.add("GET", "/api/audit-events", { roles: A.AU, ...T("audit"), query: { target_type: "", target_id: "", actor: "", action: "" } }, ({ url }) => { const q = url.searchParams; const pg = page(url); const where = ["1=1"], args = []; for (const [k, col] of [["target_type", "target_type"], ["target_id", "target_id"], ["actor", "actor_id"], ["action", "action"]]) if (q.get(k)) { where.push(`${col}=?`); args.push(q.get(k)); } const rows = db.prepare(`select id, actor_type, actor_id, action, target_type, target_id, reason, entry_hash, correlation_id, created_at from audit_events where ${where.join(" and ")} order by id desc limit ? offset ?`).all(...args, pg.limit, pg.offset); return { events: rows, next: pg.next(rows) }; });
  r.add("GET", "/api/audit/verify", { roles: [...A.AU, ...A.PA], ...T("audit") }, () => domain.auditService.verify());
  r.add("POST", "/api/audit/checkpoint", { roles: [...A.AU, ...A.PA], ...T("audit") }, ({ user }) => domain.auditService.checkpoint(user.id));
  r.add("GET", "/api/reports/summary", { roles: [...A.CM, ...A.AU, ...A.SU, ...A.DO, ...A.DA, ...A.WO, ...A.RV], ...T("reports"), query: { campaign: "campaign id", since: "ISO", until: "ISO" } }, ({ url }) => {
    const cid = url.searchParams.get("campaign") || activeCampaignId(); if (!cid) throw E.badRequest("campaign required");
    const since = url.searchParams.get("since") || "1970-01-01", until = url.searchParams.get("until") || "9999-12-31";
    const n = (sql, ...a) => db.prepare(sql).get(cid, since, until, ...a).n;
    const grp = (sql) => db.prepare(sql).all(cid, since, until);
    return {
      campaign: cid, range: { since, until }, definitions: { submissions: "receipt uploads (one per image message)", canonical_receipts: "distinct purchases identified (outlet|date|number|total)", entries_active: "awards not disqualified", unique_participants: "distinct participants with >=1 submission", registrations: "enrollments in the campaign", winners_selected: "winner rows from approved draws", winners_verified: "status verified/accepted/collected", prizes_fulfilled: "status collected" },
      registrations: n(`select count(*) n from campaign_enrollments where campaign_id=? and enrolled_at between ? and ?`),
      submissions: n(`select count(*) n from receipts where campaign_id=? and created_at between ? and ?`),
      submissions_by_status: grp(`select status as k, count(*) n from receipts where campaign_id=? and created_at between ? and ? group by status`),
      not_qualified_by_reason: grp(`select reason_code as k, count(*) n from receipts where campaign_id=? and created_at between ? and ? and status in ('NOT_QUALIFIED','REUPLOAD_REQUIRED') group by reason_code`),
      canonical_receipts: n(`select count(*) n from canonical_receipts where campaign_id=? and created_at between ? and ?`),
      entries_active: n(`select count(*) n from entries where campaign_id=? and created_at between ? and ? and status='active'`),
      entries_excluded: n(`select count(*) n from entries where campaign_id=? and created_at between ? and ? and status='excluded'`),
      unique_participants: n(`select count(distinct participant_id) n from receipts where campaign_id=? and created_at between ? and ?`),
      entries_by_period: grp(`select period_code as k, count(*) n from entries where campaign_id=? and created_at between ? and ? and status='active' group by period_code`),
      entries_by_outlet: grp(`select o.outlet_code as k, count(*) n from entries e join receipts r on r.id=e.receipt_id join outlets o on o.id=r.selected_outlet_id where e.campaign_id=? and e.created_at between ? and ? and e.status='active' group by o.outlet_code order by n desc limit 20`),
      review_open: db.prepare(`select count(*) n from review_tasks rt join receipts r on r.id=rt.receipt_id where r.campaign_id=? and rt.state!='decided'`).get(cid).n,
      winners_selected: db.prepare(`select count(*) n from winners w join draws d on d.id=w.draw_id where d.campaign_id=? and d.status in ('approved','published')`).get(cid).n,
      winners_verified: db.prepare(`select count(*) n from winners w join draws d on d.id=w.draw_id where d.campaign_id=? and w.status in ('verified','accepted','collected')`).get(cid).n,
      prizes_fulfilled: db.prepare(`select count(*) n from winners w join draws d on d.id=w.draw_id where d.campaign_id=? and w.status='collected'`).get(cid).n,
      draws_by_status: db.prepare(`select status as k, count(*) n from draws where campaign_id=? group by status`).all(cid),
      outbound: outbox.stats(), crm: crm.reconcileView(),
    };
  });
  r.add("GET", "/api/reports/export", { roles: A.AU, produces: ["application/json", "text/csv"], ...T("reports"), query: { scope: "receipts|entries|winners|audit|participants|outlets", campaign: "", format: "json|csv" } }, ({ user, url, res }) => {
    const scope = url.searchParams.get("scope") || "entries"; const cid = url.searchParams.get("campaign") || activeCampaignId(); const format = url.searchParams.get("format") || "json"; const cap = 50_000;
    const Q = { receipts: `select id, participant_id, campaign_id, period_code, selected_outlet_id, status, reason_code, decided_by, decided_at, created_at from receipts where campaign_id=? order by created_at desc limit ${cap}`, entries: `select id, receipt_id, participant_id, period_code, status, canonical_receipt_id, campaign_version_id, created_at from entries where campaign_id=? order by created_at desc limit ${cap}`, winners: `select w.id, w.draw_id, w.rank, w.prize_code, w.status, w.publication_state, w.display_name, w.verified_at, w.fulfilled_at, d.draw_period from winners w join draws d on d.id=w.draw_id where d.campaign_id=? order by d.draw_period, w.rank limit ${cap}`, audit: `select id, actor_type, actor_id, action, target_type, target_id, reason, entry_hash, created_at from audit_events where 1=1 or ?='' order by id desc limit ${cap}`, participants: `select p.id, p.first_name, p.surname, p.location, p.status, p.identity_masked, p.created_at from participants p join campaign_enrollments e on e.participant_id=p.id where e.campaign_id=? order by p.created_at desc limit ${cap}`, outlets: `select outlet_code, retailer, branch, town, province, collection_enabled from outlets where 1=1 or ?='' order by retailer, town` };
    if (!Q[scope]) throw E.badRequest("unknown scope");
    const rows = db.prepare(Q[scope]).all(cid || "");
    domain.audit({ actorType: "admin", actorId: user.id, action: "export", targetType: "report", targetId: scope, reason: `${rows.length} rows`, payload: { scope, campaign: cid, count: rows.length, format } });
    if (format === "csv") { const head = rows[0] ? Object.keys(rows[0]) : []; const csv = [head.join(","), ...rows.map((r) => head.map((k) => csvCell(r[k])).join(","))].join("\r\n"); res.writeHead(200, { ...CSV_HEADERS, "content-disposition": `attachment; filename=${scope}.csv`, "x-export-watermark": `${user.email} ${new Date().toISOString()}` }); res.end(csv); return; }
    return { scope, campaign: cid, generated_at: new Date().toISOString(), exported_by: user.email, watermark: true, count: rows.length, rows };
  });
  r.add("GET", "/api/readiness", { roles: any, ...T("operations") }, async ({ user }) => {
    const cid = activeCampaignId(); const c = cid ? domain.getCampaign(cid) : null;
    const decisions = cid ? domain.listDecisions(cid) : [];
    const ev = ["receipt_benchmark_accepted", "restore_rehearsal", "client_uat_signoff", "load_benchmark"].map((k) => ({ kind: k, value: domain.getSetting(`evidence.${k}`, null) }));
    // The named roster (emails, roles, MFA state, who is still on a temporary
    // password) is a ready-made target list that GET /api/users refuses to
    // everyone but platform_admin, yet this route handed it to every signed-in
    // role; the activation detail follows GET /api/campaigns/:id/activation.
    const staff = auth.listUsers();
    const canSeeStaff = auth.hasRole(user, ...A.PA);
    const canSeeActivation = auth.hasRole(user, ...A.CM, ...A.AU);
    return { environment: domain.environment(), sample_data: domain.getSetting("sample_data", null), campaign: c ? { id: c.id, code: c.code, name: c.name, status: c.status } : null, providers: { transport: transport.health?.(), extractor: await extractor.health(), crm: await crm.health() }, open_decisions: decisions.filter((d) => d.blocks_activation && !["approved", "not_required"].includes(d.status)).map((d) => ({ id: d.decision_id, question: d.question, test_value: d.test_value })), evidence: ev, activation: canSeeActivation && cid ? await validateActivation({ domain, auth, campaignId: cid, cfg, extractor, transport, crm, db }) : null, counts: { participants: db.prepare(`select count(*) n from participants`).get().n, receipts: db.prepare(`select count(*) n from receipts`).get().n, entries: db.prepare(`select count(*) n from entries where status='active'`).get().n, draws: db.prepare(`select count(*) n from draws`).get().n, winners: db.prepare(`select count(*) n from winners`).get().n }, staff: canSeeStaff ? staff.map((u) => ({ email: u.email, roles: JSON.parse(u.roles || "[]"), mfa: !!u.mfa_enabled, temp_password: !!u.must_change_password })) : [], staff_counts: { total: staff.length, without_mfa: staff.filter((u) => !u.mfa_enabled).length, temp_passwords: staff.filter((u) => !!u.must_change_password).length }, levels: { locally_testable: true, integrated_client_testing: transport.health?.()?.mode === "configured" && (await extractor.health()).mode === "real", production: false } };
  });
}
