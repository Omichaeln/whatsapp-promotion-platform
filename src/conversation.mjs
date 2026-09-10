import { normalizePhone, nowIso } from "./db.mjs";
import { renderCopy, shortRef } from "./copy.mjs";

/**
 * Conversation state machine (spec §8, §9). State is persisted per campaign +
 * channel identity (conversation_sessions, versioned). Every transition is a
 * pure function of (persisted state, event); nothing is inferred from message
 * text beyond explicit menu/keyword intents.
 *
 * States:
 *  HOME | REG_FIRST | REG_SURNAME | REG_IDENTITY | REG_LOCATION | REG_CONFIRM | REG_TERMS
 *  OUTLET_RETAILER | OUTLET_TOWN | OUTLET_BRANCH | OUTLET_SEARCH | ENTRY_RECEIPT | WINNERS | SUPPORT
 * Global intents: MENU/0, HELP/8, BACK, CANCEL, SUPPORT.
 */
export const STATES = ["HOME", "REG_FIRST", "REG_SURNAME", "REG_IDENTITY", "REG_LOCATION", "REG_CONFIRM", "REG_TERMS", "OUTLET_RETAILER", "OUTLET_TOWN", "OUTLET_BRANCH", "OUTLET_SEARCH", "ENTRY_RECEIPT", "WINNERS", "SUPPORT"];
const PAGE = 8;

export function parseIntent(text) {
  const t = String(text || "").toLowerCase().trim().replace(/[.!]$/, "");
  if (!t) return { intent: null, number: null };
  // numeric replies are always carried as `number`; state handlers that show a
  // numbered list consume them BEFORE the home-menu intent mapping applies
  const number = /^\d{1,2}$/.test(t) ? Number(t) : null;
  const r = parseWord(t);
  return { ...r, number };
}
function parseWord(t) {
  if (["menu", "main menu", "0", "home", "start"].includes(t)) return { intent: "MENU" };
  if (["help", "8", "?"].includes(t)) return { intent: "HELP" };
  if (["back", "b"].includes(t)) return { intent: "BACK" };
  if (["cancel", "stop", "exit"].includes(t)) return { intent: "CANCEL" };
  if (["support", "agent", "human", "help me"].includes(t)) return { intent: "SUPPORT" };
  if (["yes", "y", "accept", "agree", "confirm", "ok"].includes(t)) return { intent: "YES" };
  if (["no", "n", "decline", "reject"].includes(t)) return { intent: "NO" };
  if (["register", "sign up", "signup", "1"].includes(t)) return { intent: "REGISTER" };
  if (["enter", "enter promotion", "enter the promotion", "2"].includes(t)) return { intent: "ENTER" };
  if (["how it works", "mechanics", "3"].includes(t)) return { intent: "MECHANICS" };
  if (["terms", "t&c", "t&cs", "4"].includes(t)) return { intent: "TERMS" };
  if (["prizes", "prize", "5"].includes(t)) return { intent: "PRIZES" };
  if (["winners", "6"].includes(t)) return { intent: "WINNERS" };
  if (["status", "my entries", "entries", "7"].includes(t)) return { intent: "STATUS" };
  if (["hi", "hello", "hey", "hie", "hallo", "good morning", "good afternoon", "good evening", "start"].includes(t)) return { intent: "GREETING" };
  if (/^\d{1,2}$/.test(t)) return { intent: "NUMBER" };
  return { intent: null };
}

export function createConversationService({ db, domain, receiptPipeline, winners = null, crm = null, now = nowIso, log = console }) {
  const activeCampaign = () => db.prepare(`select * from campaigns where status in ('active','paused','closed') order by case status when 'active' then 0 when 'paused' then 1 else 2 end, created_at desc limit 1`).get() || null;
  const copy = (campaignId, key, vars) => renderCopy(campaignId ? domain.versionContent(campaignId) : {}, key, vars);
  const ctxOf = (s) => { try { return JSON.parse(s?.context_json || "{}"); } catch { return {}; } };

  function menu(campaign) {
    const flags = domain.versionFlags(campaign.id);
    return copy(campaign.id, "menu_home", { campaign: campaign.name, status_line: flags.participant_status ? copy(campaign.id, "menu_status_line") : "" });
  }
  function fmtOptions(options) { return options.map((o, i) => `${i + 1}. ${o.label}`).join("\n"); }
  function paged(list, page) { const start = page * PAGE; const slice = list.slice(start, start + PAGE); const more = start + PAGE < list.length; return { options: [...slice, ...(more ? [{ label: "More…", value: "__more", kind: "more" }] : [])], more }; }

  function outletSearch(campaignId, q) {
    const words = String(q).toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    if (!words.length) return [];
    return domain.listCampaignOutlets(campaignId).map((o) => {
      let aliases = []; try { aliases = JSON.parse(o.aliases_json || "[]"); } catch { /* ignore */ }
      const hay = `${o.retailer} ${o.branch} ${o.town} ${o.province} ${aliases.join(" ")}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      return hits ? { o, hits } : null;
    }).filter(Boolean).sort((a, b) => b.hits - a.hits || a.o.retailer.localeCompare(b.o.retailer)).slice(0, PAGE).map(({ o }) => ({ label: `${o.retailer} — ${o.branch}, ${o.town}`, value: o.id, kind: "outlet" }));
  }
  const outletLabel = (o) => `${o.retailer} — ${o.branch}, ${o.town}`;

  async function handle({ eventId, providerMessageId, phoneUid, type, text, mediaBytes, mime, correlationId = null, eventAt = null }) {
    const pUid = normalizePhone(phoneUid) || phoneUid;
    const campaign = activeCampaign();
    if (!campaign) return { replies: [copy(null, "no_campaign")], state: "HOME", campaignId: null };
    const cid = campaign.id;
    const session = domain.getSession(cid, pUid);
    const state = session?.state || "HOME";
    const ctx = ctxOf(session);
    const version = session?.row_version ?? null;
    const participant = domain.getParticipantByPhone(pUid);
    const enrollment = participant ? domain.getEnrollment(participant.id, cid) : null;
    const isImage = type === "message.image" || type === "message.document";
    const { intent, number } = isImage ? { intent: "IMAGE" } : parseIntent(text);
    const save = (st, c = ctx, extra = {}) => domain.setSession(cid, pUid, { state: st, context: c, participantId: participant?.id || null, expectedVersion: version, ...extra });
    const reply = (st, msgs, extra = {}) => ({ replies: [].concat(msgs), state: st, campaignId: cid, ...extra });
    const home = (prefix = null) => { save("HOME", { lastReceiptId: ctx.lastReceiptId }); return reply("HOME", prefix ? [prefix, menu(campaign)] : [menu(campaign)]); };

    // support handoff: automation suspended until an operator releases the conversation
    if (session?.handoff_owner) return reply("SUPPORT", [copy(cid, "support_active")]);
    if (intent === "SUPPORT") { save("SUPPORT", ctx, { handoffOwner: "queue", handoffSince: now() }); domain.alert({ kind: "support.handoff", severity: "info", message: `participant ${domain.maskPhone(pUid)} requested support`, runbook: "docs/runbooks/support-handoff.md" }); return reply("SUPPORT", [copy(cid, "support_handoff")]); }

    // campaign lifecycle gates
    if (campaign.status === "closed") {
      if (intent === "WINNERS" || state === "WINNERS") return winnersFlow();
      return reply("HOME", [copy(cid, "campaign_closed")]);
    }
    const pause = domain.getPauseFlags(cid);

    // global navigation
    if (intent === "MENU") return home();
    if (intent === "HELP") return reply(state, [copy(cid, "help")]);
    if (intent === "CANCEL") { save("HOME", {}); return reply("HOME", [copy(cid, "cancel")]); }

    switch (state) {
      case "HOME": return homeIntent();
      case "REG_FIRST": case "REG_SURNAME": case "REG_IDENTITY": case "REG_LOCATION": case "REG_CONFIRM": case "REG_TERMS": return registration();
      case "OUTLET_RETAILER": case "OUTLET_TOWN": case "OUTLET_BRANCH": case "OUTLET_SEARCH": return outletFlow();
      case "ENTRY_RECEIPT": return receiptFlow();
      case "WINNERS": return winnersFlow();
      default: return home();
    }

    // ---------------------------------------------------------------- HOME
    function homeIntent() {
      if (intent === "REGISTER") {
        if (participant && enrollment && !enrollment.withdrawn_at) { save("REG_FIRST", { reg: { firstName: participant.first_name, surname: participant.surname, location: participant.location, identityMasked: participant.identity_masked, update: true } }); return reply("REG_FIRST", [copy(cid, "already_registered", { first_name: participant.first_name, surname: participant.surname }), copy(cid, "ask_first_name")]); }
        save("REG_FIRST", { reg: {} }); return reply("REG_FIRST", [copy(cid, "ask_first_name")]);
      }
      if (intent === "ENTER") return startEntry();
      if (intent === "MECHANICS") return reply("HOME", [mechanics()]);
      if (intent === "TERMS") return reply("HOME", [termsText()]);
      if (intent === "PRIZES") return reply("HOME", [prizesText()]);
      if (intent === "WINNERS") return winnersFlow(true);
      if (intent === "STATUS") return statusText();
      if (intent === "GREETING" || intent === null || intent === "NUMBER" || intent === "IMAGE" || intent === "YES" || intent === "NO" || intent === "BACK") {
        if (intent === "IMAGE") return reply("HOME", [copy(cid, "need_image"), menu(campaign)]);
        return intent === "GREETING" || intent === "BACK" ? home() : reply("HOME", [copy(cid, "unknown_input", { menu: menu(campaign) })]);
      }
      return home();
    }
    function mechanics() { const r = domain.versionRules(cid); return copy(cid, "mechanics", { min_packs: r.primary_rule.min_packs, pack_label: `${r.primary_rule.pack_grams / 1000}kg pack`, product: r.products?.[0]?.name || "the qualifying product" }); }
    function termsText() { const c = domain.versionContent(cid); return copy(cid, "terms", { terms_version: c.terms_version || "unversioned", privacy_version: c.privacy_version || "unversioned", terms_url: c.terms_url || "(link to be supplied)" }); }
    function prizesText() { const c = domain.versionContent(cid); const dc = JSON.parse(campaign.draw_config_json || "{}"); const prizes = c.prizes_text || (dc.prizes || []).map((p) => `${p.label} (${p.per_week} per week)`).join("; ") || "to be announced"; return copy(cid, "prizes", { prizes, prize_artwork_note: c.prize_artwork_url ? `Artwork: ${c.prize_artwork_url}` : copy(cid, "prizes_artwork_note") }); }

    function statusText() {
      const flags = domain.versionFlags(cid);
      if (!flags.participant_status) return reply("HOME", [copy(cid, "status_disabled")]);
      if (!participant) return reply("HOME", [copy(cid, "not_registered_for_entry")]);
      const rows = db.prepare(`select id, status, reason_code, created_at from receipts where participant_id=? and campaign_id=? order by created_at desc`).all(participant.id, cid);
      const qualified = domain.countActiveEntries(participant.id, cid);
      const pending = rows.filter((r) => ["received", "processing", "delayed", "REVIEW_REQUIRED"].includes(r.status)).length;
      const rejected = rows.filter((r) => ["NOT_QUALIFIED", "DUPLICATE", "REUPLOAD_REQUIRED"].includes(r.status)).length;
      const label = { received: "being checked", processing: "being checked", delayed: "delayed", REVIEW_REQUIRED: "under review", QUALIFIED: "qualified", NOT_QUALIFIED: "did not qualify", DUPLICATE: "already used", REUPLOAD_REQUIRED: "needs a clearer photo" };
      const recent = rows.slice(0, 3).map((r) => copy(cid, "status_recent_line", { reference: shortRef(r.id), outcome: label[r.status] || r.status })).join("\n");
      return reply("HOME", [copy(cid, "status", { campaign: campaign.name, qualified, pending, rejected, recent })]);
    }

    // ---------------------------------------------------------- registration
    function regFlags() { const f = domain.versionFlags(cid); return { identityStage: f.registration?.identity_stage || "registration" }; }
    function registration() {
      const reg = ctx.reg || {};
      const val = String(text || "").trim();
      const back = { REG_SURNAME: "REG_FIRST", REG_IDENTITY: "REG_SURNAME", REG_LOCATION: regFlags().identityStage === "registration" ? "REG_IDENTITY" : "REG_SURNAME", REG_CONFIRM: "REG_LOCATION", REG_TERMS: "REG_CONFIRM" };
      const prompts = { REG_FIRST: "ask_first_name", REG_SURNAME: "ask_surname", REG_IDENTITY: "ask_identity", REG_LOCATION: "ask_location", REG_CONFIRM: "confirm_details", REG_TERMS: "ask_terms" };
      const ask = (st) => { save(st, { ...ctx, reg }); return reply(st, [copy(cid, prompts[st], regVars(reg))]); };
      if (intent === "BACK") return state === "REG_FIRST" ? home() : ask(back[state]);
      if (isImage) return reply(state, [copy(cid, prompts[state], regVars(reg))]);
      switch (state) {
        case "REG_FIRST": if (val.length < 2 || /\d/.test(val)) return reply(state, [copy(cid, "ask_retry_short")]); reg.firstName = val.slice(0, 60); return reg.update && reg.returnTo ? confirmAfter(reg) : ask("REG_SURNAME");
        case "REG_SURNAME": if (val.length < 2) return reply(state, [copy(cid, "ask_retry_short")]); reg.surname = val.slice(0, 60); return reg.returnTo ? confirmAfter(reg) : ask(regFlags().identityStage === "registration" ? "REG_IDENTITY" : "REG_LOCATION");
        case "REG_IDENTITY": if (!/^[A-Za-z0-9-]{5,20}$/.test(val)) return reply(state, [copy(cid, "ask_identity_retry")]); reg.identity = val.toUpperCase(); reg.identityMasked = maskId(reg.identity); return reg.returnTo ? confirmAfter(reg) : ask("REG_LOCATION");
        case "REG_LOCATION": if (val.length < 2) return reply(state, [copy(cid, "ask_retry_short")]); reg.location = val.slice(0, 80); return confirmAfter(reg);
        case "REG_CONFIRM": {
          if (intent === "YES") return ask("REG_TERMS");
          const field = number != null ? { 1: "REG_FIRST", 2: "REG_SURNAME", 3: "REG_IDENTITY", 4: "REG_LOCATION" }[number] : null;
          if (field) { reg.returnTo = "REG_CONFIRM"; if (field === "REG_IDENTITY" && regFlags().identityStage !== "registration") return ask("REG_CONFIRM"); return ask(field); }
          return ask("REG_CONFIRM");
        }
        case "REG_TERMS": {
          if (intent === "NO") { save("HOME", {}); return reply("HOME", [copy(cid, "terms_declined")]); }
          if (intent !== "YES") return ask("REG_TERMS");
          const c = domain.versionContent(cid); const v = domain.getActiveVersion(cid);
          const res = domain.registerParticipant({ phoneUid: pUid, firstName: reg.firstName || participant?.first_name, surname: reg.surname ?? participant?.surname, identity: reg.identity || null, location: reg.location || participant?.location, campaignId: cid, campaignVersionId: v?.id, termsVersion: c.terms_version || `V${v?.version_no || 1}`, privacyVersion: c.privacy_version || `V${v?.version_no || 1}`, marketingConsent: false });
          const p = res.participant;
          crm?.emit({ entityType: "participant", entityId: p.id, entityVersion: p.row_version || 1, payload: { firstName: p.first_name, surname: p.surname, phone: domain.maskPhone(p.wa_phone_uid), location: p.location, status: p.status }, correlationId });
          if (res.enrollment) crm?.emit({ entityType: "enrollment", entityId: p.id + ":" + cid, entityVersion: 1, payload: { participantId: p.id, campaignCode: campaign.code, termsVersion: res.enrollment.terms_version, privacyVersion: res.enrollment.privacy_version, marketingConsent: !!res.enrollment.marketing_consent, enrolledAt: res.enrollment.enrolled_at }, correlationId });
          save("HOME", { lastReceiptId: ctx.lastReceiptId }, { participantId: p.id });
          return reply("HOME", [copy(cid, "registered", { first_name: p.first_name }), menu(campaign)], { participantId: p.id });
        }
        default: return home();
      }
      function confirmAfter(r) { delete r.returnTo; save("REG_CONFIRM", { ...ctx, reg: r }); return reply("REG_CONFIRM", [copy(cid, "confirm_details", regVars(r))]); }
    }
    function regVars(reg) { const c = domain.versionContent(cid); return { first_name: reg.firstName || participant?.first_name || "", surname: reg.surname || participant?.surname || "", identity_masked: reg.identityMasked || participant?.identity_masked || (regFlags().identityStage === "registration" ? "(not given)" : "(asked from winners)"), location: reg.location || participant?.location || "", phone: `+${pUid}`, terms_version: c.terms_version || "unversioned", privacy_version: c.privacy_version || "unversioned", terms_url: c.terms_url || "(link to be supplied)" }; }
    function maskId(v) { const s = String(v); return s.length > 6 ? s.slice(0, 2) + "*".repeat(s.length - 4) + s.slice(-2) : "******"; }

    // -------------------------------------------------------------- entry / outlet
    function startEntry() {
      if (!participant) return reply("HOME", [copy(cid, "not_registered_for_entry")]);
      if (!enrollment || enrollment.withdrawn_at) { save("REG_TERMS", { reg: { firstName: participant.first_name, surname: participant.surname, location: participant.location } }); return reply("REG_TERMS", [copy(cid, "ask_terms", regVars({}))]); }
      if (campaign.status === "paused" || pause.intake) return reply("HOME", [copy(cid, "campaign_paused")]);
      return showRetailers(0);
    }
    function retailers() { return [...new Set(domain.listCampaignOutlets(cid).map((o) => o.retailer))].sort(); }
    function showRetailers(page) {
      const list = retailers().map((r) => ({ label: r, value: r, kind: "retailer" }));
      const { options } = paged(list, page);
      save("OUTLET_RETAILER", { ...ctx, nav: { page, options } });
      return reply("OUTLET_RETAILER", [copy(cid, "ask_outlet_retailer", { options: fmtOptions(options) })]);
    }
    function showTowns(retailer, page) {
      const towns = [...new Set(domain.listCampaignOutlets(cid).filter((o) => o.retailer === retailer).map((o) => o.town))].sort();
      if (towns.length === 1) return showBranches(retailer, towns[0], 0);
      const { options } = paged(towns.map((t) => ({ label: t, value: t, kind: "town" })), page);
      save("OUTLET_TOWN", { ...ctx, nav: { retailer, page, options } });
      return reply("OUTLET_TOWN", [copy(cid, "ask_outlet_town", { retailer, options: fmtOptions(options) })]);
    }
    function showBranches(retailer, town, page) {
      const branches = domain.listCampaignOutlets(cid).filter((o) => o.retailer === retailer && o.town === town).map((o) => ({ label: o.branch, value: o.id, kind: "outlet" }));
      const { options } = paged(branches, page);
      save("OUTLET_BRANCH", { ...ctx, nav: { retailer, town, page, options } });
      return reply("OUTLET_BRANCH", [copy(cid, "ask_outlet_branch", { retailer, town, options: fmtOptions(options) })]);
    }
    function selectOutlet(outletId) {
      const o = domain.listCampaignOutlets(cid).find((x) => x.id === outletId);
      if (!o) return reply(state, [copy(cid, "outlet_choose_number")]);
      save("ENTRY_RECEIPT", { ...ctx, nav: null, selectedOutletId: o.id, selectedOutletLabel: outletLabel(o) });
      return reply("ENTRY_RECEIPT", [copy(cid, "outlet_confirmed", { outlet: outletLabel(o) })]);
    }
    function outletFlow() {
      const nav = ctx.nav || {};
      if (intent === "BACK") {
        if (state === "OUTLET_RETAILER") return home();
        if (state === "OUTLET_TOWN") return showRetailers(0);
        if (state === "OUTLET_BRANCH") return showTowns(nav.retailer, 0);
        return showRetailers(0);
      }
      if (isImage) return reply(state, [copy(cid, "outlet_choose_number")]);
      if (number != null && nav.options) {
        const pick = nav.options[number - 1];
        if (!pick) return reply(state, [copy(cid, "outlet_choose_number")]);
        if (pick.kind === "more") { const p = (nav.page || 0) + 1; return state === "OUTLET_RETAILER" ? showRetailers(p) : state === "OUTLET_TOWN" ? showTowns(nav.retailer, p) : showBranches(nav.retailer, nav.town, p); }
        if (pick.kind === "retailer") return showTowns(pick.value, 0);
        if (pick.kind === "town") return showBranches(nav.retailer, pick.value, 0);
        if (pick.kind === "outlet") return selectOutlet(pick.value);
      }
      const q = String(text || "").trim();
      if (q.length >= 2) {
        const options = outletSearch(cid, q);
        if (!options.length) return reply(state, [copy(cid, "outlet_no_match", { query: q.slice(0, 40) })]);
        save("OUTLET_SEARCH", { ...ctx, nav: { ...nav, options, query: q } });
        return reply("OUTLET_SEARCH", [copy(cid, "outlet_search_results", { options: fmtOptions(options) })]);
      }
      return reply(state, [copy(cid, "outlet_choose_number")]);
    }

    async function receiptFlow() {
      if (intent === "BACK") return showRetailers(0);
      if (intent === "ENTER") return startEntry();
      if (!isImage) return reply("ENTRY_RECEIPT", [copy(cid, "need_image")]);
      if (!mediaBytes) return reply("ENTRY_RECEIPT", [copy(cid, "media_missing")]);
      if (!participant) return home();
      if (pause.intake) return reply("HOME", [copy(cid, "campaign_paused")]);
      try {
        const res = await receiptPipeline.submit({ campaignId: cid, participantId: participant.id, phoneUid: pUid, selectedOutletId: ctx.selectedOutletId, providerMessageId, channelEventId: eventId, imageBytes: mediaBytes, correlationId, eventAt });
        save("HOME", { lastReceiptId: res.receiptId, lastOutletId: ctx.selectedOutletId }, { activeReceiptId: res.receiptId });
        if (res.replay) return reply("HOME", [copy(cid, "processing_wait", { reference: res.reference })], { receiptId: res.receiptId });
        return reply("HOME", [copy(cid, "received", { reference: res.reference })], { receiptId: res.receiptId });
      } catch (e) {
        if (["BAD_TYPE", "TOO_LARGE", "TOO_SMALL", "EMPTY"].includes(e.code)) return reply("ENTRY_RECEIPT", [copy(cid, "media_rejected", { reason: e.message })]);
        log.error?.("[conversation] submit failed", e.message);
        throw e; // intake retries with backoff; the participant is not told a false outcome
      }
    }

    // ----------------------------------------------------------------- winners
    function winnersFlow(fresh = false) {
      const periods = winners ? winners.publishedPeriods(cid) : [];
      if (!periods.length) { save("HOME", ctx); return reply("HOME", [copy(cid, "winners_none")]); }
      const nav = ctx.nav || {};
      if (!fresh && state === "WINNERS" && number != null && nav.options?.[number - 1]) {
        const code = nav.options[number - 1].value;
        const rows = winners.listPublic(cid, code);
        const lines = rows.map((w) => copy(cid, "winners_line", { rank: w.rank, name: w.name, location: w.location || "", prize: w.prize })).join("\n") || "(none)";
        return reply("WINNERS", [copy(cid, "winners_list", { period: nav.options[number - 1].label, lines })]);
      }
      const options = periods.map((p) => ({ label: p.label, value: p.code, kind: "period" }));
      save("WINNERS", { ...ctx, nav: { options } });
      return reply("WINNERS", [copy(cid, "winners_periods", { options: fmtOptions(options) })]);
    }
  }

  /** Background outcome hook: never overwrites a newer conversation state. */
  async function onReceiptOutcome(receiptId, result) {
    const r = receiptPipeline.get(receiptId); if (!r) return;
    const p = domain.getParticipant(r.participant_id); if (!p) return;
    const s = domain.getSession(r.campaign_id, p.wa_phone_uid);
    if (s && s.active_receipt_id === receiptId) domain.setSession(r.campaign_id, p.wa_phone_uid, { context: { ...JSON.parse(s.context_json || "{}"), lastOutcome: { receiptId, decision: result?.decision } }, activeReceiptId: null });
  }

  /** Operator handoff controls. */
  function claimHandoff(campaignId, phoneUid, operatorId) { domain.setSession(campaignId, phoneUid, { handoffOwner: operatorId, handoffSince: now() }); domain.audit({ actorType: "admin", actorId: operatorId, action: "support.claim", targetType: "conversation", targetId: normalizePhone(phoneUid) }); }
  function releaseHandoff(campaignId, phoneUid, operatorId) { domain.setSession(campaignId, phoneUid, { state: "HOME", handoffOwner: null, handoffSince: null }); domain.audit({ actorType: "admin", actorId: operatorId, action: "support.release", targetType: "conversation", targetId: normalizePhone(phoneUid) }); }

  return { handle, onReceiptOutcome, claimHandoff, releaseHandoff, services: {} };
}
