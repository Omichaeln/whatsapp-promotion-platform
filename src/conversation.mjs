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
 * Global intents: MENU/0, HELP/8, BACK, CANCEL, SUPPORT, CLAIM, STOP (opt-out).
 * MENU/HELP give way to the numbered list a state is currently showing, so
 * option 8 (and 0) of a list are selectable.
 */
export const STATES = ["HOME", "REG_FIRST", "REG_SURNAME", "REG_IDENTITY", "REG_LOCATION", "REG_CONFIRM", "REG_TERMS", "OUTLET_RETAILER", "OUTLET_TOWN", "OUTLET_BRANCH", "OUTLET_SEARCH", "ENTRY_RECEIPT", "WINNERS", "SUPPORT"];
const PAGE = 8;
/** States whose numbered list must win over the global "0"/"8" aliases. */
const LIST_STATES = ["OUTLET_RETAILER", "OUTLET_TOWN", "OUTLET_BRANCH", "OUTLET_SEARCH", "WINNERS"];
/** An unclaimed (queue) support handoff is handed back to the bot after this. */
const HANDOFF_QUEUE_TIMEOUT_MS = 12 * 3600_000;
/**
 * Participant-supplied text is published (the winners list interpolates the
 * town and display name), so control characters are stripped at capture AND at
 * render: a town containing a newline forged an extra "winner" line in the
 * published list that every other participant could read.
 */
export function cleanField(v, max = 80) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseIntent(text) {
  const t = String(text || "").toLowerCase().trim().replace(/[.!]$/, "");
  if (!t) return { intent: null, number: null };
  // numeric replies are always carried as `number`; state handlers that show a
  // numbered list consume them BEFORE the home-menu intent mapping applies
  const number = /^\d{1,2}$/.test(t) ? Number(t) : null;
  const r = parseWord(t);
  return { intent: null, number, claimRef: null, ...r };
}
function parseWord(t) {
  if (["menu", "main menu", "0", "home", "start"].includes(t)) return { intent: "MENU" };
  if (["help", "8", "?"].includes(t)) return { intent: "HELP" };
  if (["back", "b"].includes(t)) return { intent: "BACK" };
  if (["cancel", "exit"].includes(t)) return { intent: "CANCEL" };
  // STOP/UNSUBSCRIBE is the universal opt-out and must withdraw consent, not
  // cancel the current step and invite the participant to start again.
  if (["stop", "unsubscribe", "opt out", "optout", "stop all"].includes(t)) return { intent: "OPTOUT" };
  // The winner message says "reply CLAIM … your claim reference is XXXX-XXXX";
  // both forms were answered "Sorry, I didn't understand that".
  if (["claim", "claim prize", "claim my prize"].includes(t)) return { intent: "CLAIM" };
  if (/^[0-9a-f]{4}-?[0-9a-f]{4}$/.test(t)) return { intent: "CLAIM", claimRef: t.toUpperCase().replace(/^(.{4})(.{4})$/, "$1-$2") };
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
      // NOTE: every match is returned; the caller pages it like the browse
      // lists. Truncating to the first PAGE here hid later branches with no
      // "More…" and no hint that anything had been cut.
    }).filter(Boolean).sort((a, b) => b.hits - a.hits || a.o.retailer.localeCompare(b.o.retailer)).map(({ o }) => ({ label: `${o.retailer} — ${o.branch}, ${o.town}`, value: o.id, kind: "outlet" }));
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
    const { intent, number, claimRef } = isImage ? { intent: "IMAGE", number: null, claimRef: null } : parseIntent(text);
    const save = (st, c = ctx, extra = {}) => domain.setSession(cid, pUid, { state: st, context: c, participantId: participant?.id || null, expectedVersion: version, ...extra });
    // Set when the inbound message body itself is personal data that must not
    // be retained in channel_events (currently the national ID at registration).
    let redactInbound = false;
    const reply = (st, msgs, extra = {}) => ({ replies: [].concat(msgs), state: st, campaignId: cid, redactInbound, ...extra });
    const home = (prefix = null) => { save("HOME", { lastReceiptId: ctx.lastReceiptId }); return reply("HOME", prefix ? [prefix, menu(campaign)] : [menu(campaign)]); };

    // The winner message instructs "reply CLAIM"; it is answered before the
    // support gate so a winner whose conversation is parked in handoff can
    // still claim. claimTurn() returns null when there is nothing to claim and
    // the text only looked like a reference, so ordinary input is unaffected.
    // A bare reference is only read as a claim where free text means nothing
    // anyway, so it can never swallow an ID, a town or an outlet search.
    if (intent === "CLAIM" && (!claimRef || state === "HOME" || state === "SUPPORT")) { const claimed = claimTurn(); if (claimed) return claimed; }

    // Opting out is a consent decision, so it is honoured even while a support
    // operator holds the conversation.
    if (intent === "OPTOUT") return optOut();

    // support handoff: automation suspended until an operator releases the conversation
    if (session?.handoff_owner) {
      // …but an UNCLAIMED request must not freeze the participant out of
      // registration, entry and the menu for ever: getSession ignores
      // expires_at and nothing sweeps the table, so without this the only way
      // back is a staff release for a phone number staff cannot discover. A
      // conversation an operator has actually claimed is never auto-released.
      const since = Date.parse(session.handoff_since || "") || 0;
      const stale = session.handoff_owner === "queue" && since > 0 && Date.parse(now()) - since > HANDOFF_QUEUE_TIMEOUT_MS;
      if (!stale) return reply("SUPPORT", [copy(cid, "support_active")]);
      domain.setSession(cid, pUid, { state: "HOME", context: {}, participantId: participant?.id || null, handoffOwner: null, handoffSince: null });
      domain.audit({ actorType: "system", actorId: "system", action: "support.auto_release", targetType: "conversation", targetId: pUid, reason: "unclaimed support handoff timed out" });
      return reply("HOME", [copy(cid, "support_timeout"), menu(campaign)]);
    }
    if (intent === "SUPPORT") {
      save("SUPPORT", ctx, { handoffOwner: "queue", handoffSince: now() });
      // alert() de-duplicates on `kind` for an hour, so the 2nd..Nth requester
      // in that hour raises nothing at all; carrying the size of the queue in
      // the message at least tells whoever reads it that others are waiting.
      const waiting = db.prepare(`select count(*) n from conversation_sessions where campaign_id=? and handoff_owner='queue'`).get(cid).n;
      domain.alert({ kind: "support.handoff", severity: "info", message: `participant ${domain.maskPhone(pUid)} requested support (${waiting} conversation(s) waiting for an operator)`, runbook: "docs/runbooks/support-handoff.md" });
      return reply("SUPPORT", [copy(cid, "support_handoff")]);
    }

    // campaign lifecycle gates
    if (campaign.status === "closed") {
      if (intent === "WINNERS" || state === "WINNERS") return winnersFlow();
      return reply("HOME", [copy(cid, "campaign_closed")]);
    }
    const pause = domain.getPauseFlags(cid);

    // global navigation. A state that is showing a numbered list must consume
    // its own numbers FIRST: "0" and "8" are also the MENU/HELP aliases, so
    // option 8 of any list (the 8th retailer, town, search result or published
    // week) used to answer the Help text and could never be chosen at all.
    // At HOME there is no list of this kind, so "8. Help" still works.
    const listSize = state === "REG_CONFIRM" ? 4 : (LIST_STATES.includes(state) && Array.isArray(ctx.nav?.options) ? ctx.nav.options.length : 0);
    const picksListOption = number != null && number >= 1 && number <= listSize;
    if (intent === "MENU" && !picksListOption) return home();
    if (intent === "HELP" && !picksListOption) return reply(state, [copy(cid, "help")]);
    if (intent === "CANCEL") { save("HOME", {}); return reply("HOME", [copy(cid, "cancel")]); }

    try {
      switch (state) {
        case "HOME": return await homeIntent();
        case "REG_FIRST": case "REG_SURNAME": case "REG_IDENTITY": case "REG_LOCATION": case "REG_CONFIRM": case "REG_TERMS": return registration();
        case "OUTLET_RETAILER": case "OUTLET_TOWN": case "OUTLET_BRANCH": case "OUTLET_SEARCH": return outletFlow();
        case "ENTRY_RECEIPT": return await receiptFlow();
        case "WINNERS": return winnersFlow();
        default: return home();
      }
    } catch (e) {
      // A domain error must never escape an ordinary participant turn: intake
      // has no participant-facing failure path, so the person gets absolute
      // silence, the event retries four more times and dead-letters, and the
      // session stays wedged in the state that throws (reproduced with a
      // withdrawn participant re-accepting the terms). Genuinely retryable
      // failures — the receipt pipeline, a concurrent session write — are
      // still rethrown so the queue replays them.
      if (e?.retryTurn || e?.code === "CONFLICT") throw e;
      log.error?.("[conversation] turn failed", state, e?.message);
      return reply(state, [copy(cid, "something_went_wrong")]);
    }

    // ------------------------------------------------------- claim / opt-out
    /** Winner claim leg (FR-27). Returns null when this is not a claim after all. */
    function claimTurn() {
      if (!winners || !participant) return claimRef ? null : reply(state, [copy(cid, "claim_not_found")]);
      const w = db.prepare(`select w.id, w.published_fields_json from winners w join draws d on d.id = w.draw_id
        where w.participant_id=? and d.campaign_id=? and w.status in ('notified','verified','accepted') order by w.rank limit 1`).get(participant.id, cid);
      if (!w) return claimRef ? null : reply(state, [copy(cid, "claim_not_found")]);
      // The reference is a bearer secret, so it is only ever checked against
      // the winner row belonging to THIS phone, and a mismatch (or an expired
      // token) is answered with the same neutral message as "nothing to claim"
      // — the reply never reveals whether a reference is valid for someone.
      const ok = claimRef ? winners.verifyClaimToken(w.id, claimRef) : true;
      domain.audit({ actorType: "participant", actorId: participant.id, action: ok ? "winner.claim_ack" : "winner.claim_rejected", targetType: "winner", targetId: w.id, payload: { withReference: !!claimRef } });
      if (!ok) return reply(state, [copy(cid, "claim_not_found")]);
      const prize = (() => { try { return JSON.parse(w.published_fields_json || "{}").prize || ""; } catch { return ""; } })();
      return reply(state, [copy(cid, "claim_ack", { first_name: participant.first_name, prize })]);
    }
    function optOut() {
      if (!participant || participant.status !== "active") { save("HOME", {}); return reply("HOME", [copy(cid, "opted_out_none", { campaign: campaign.name })]); }
      domain.withdrawParticipant(pUid, null, "participant replied STOP");
      save("HOME", {});
      return reply("HOME", [copy(cid, "opted_out", { campaign: campaign.name })]);
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
        if (intent === "IMAGE") return homeImage();
        return intent === "GREETING" || intent === "BACK" ? home() : reply("HOME", [copy(cid, "unknown_input", { menu: menu(campaign) })]);
      }
      return home();
    }
    /**
     * A receipt photo sent from HOME — the state every successful submission
     * returns to, and exactly what the "you can enter again" copy invites —
     * used to be answered "Please send a PHOTO of your receipt" and the image
     * dropped. The outlet from the previous entry is remembered (ctx.lastOutletId),
     * so the common case now submits; otherwise the reply matches reality.
     */
    function homeImage() {
      if (!participant || participant.status !== "active" || !enrollment || enrollment.withdrawn_at) return reply("HOME", [copy(cid, "not_registered_for_entry")]);
      if (campaign.status === "paused" || pause.intake) return reply("HOME", [copy(cid, "campaign_paused")]);
      if (!ctx.lastOutletId) return reply("HOME", [copy(cid, "need_outlet_first")]);
      ctx.selectedOutletId = ctx.lastOutletId;
      return receiptFlow();
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
      // When the campaign version does not collect the ID at registration the
      // confirmation must not offer "3 ID": pressing it silently redisplayed
      // the same screen.
      const collectsIdentity = regFlags().identityStage === "registration";
      const confirmKey = collectsIdentity ? "confirm_details" : "confirm_details_no_identity";
      const prompts = { REG_FIRST: "ask_first_name", REG_SURNAME: "ask_surname", REG_IDENTITY: "ask_identity", REG_LOCATION: "ask_location", REG_CONFIRM: confirmKey, REG_TERMS: "ask_terms" };
      const ask = (st) => { save(st, { ...ctx, reg }); return reply(st, [copy(cid, prompts[st], regVars(reg))]); };
      if (intent === "BACK") return state === "REG_FIRST" ? home() : ask(back[state]);
      if (isImage) return reply(state, [copy(cid, prompts[state], regVars(reg))]);
      switch (state) {
        // cleanField(): the name, surname and town are published in the winners
        // list, so a value containing a newline could forge an extra winner
        // line there. `reg.update &&` is gone from REG_FIRST: without it, a
        // first-time registrant correcting "1 name" at the confirmation was
        // asked for the surname again instead of going back to the confirmation.
        case "REG_FIRST": { const v = cleanField(val, 60); if (v.length < 2 || /\d/.test(v)) return reply(state, [copy(cid, "ask_retry_short")]); reg.firstName = v; return reg.returnTo ? confirmAfter(reg) : ask("REG_SURNAME"); }
        case "REG_SURNAME": { const v = cleanField(val, 60); if (v.length < 2) return reply(state, [copy(cid, "ask_retry_short")]); reg.surname = v; return reg.returnTo ? confirmAfter(reg) : ask(collectsIdentity ? "REG_IDENTITY" : "REG_LOCATION"); }
        // The raw national ID must not survive in channel_events: it is stored
        // encrypted on the participant and masked everywhere else, but the
        // inbound message that carried it was kept in cleartext for ever and
        // served to support and campaign_manager through the transcript views.
        case "REG_IDENTITY": if (!/^[A-Za-z0-9-]{5,20}$/.test(val)) return reply(state, [copy(cid, "ask_identity_retry")]); reg.identity = val.toUpperCase(); reg.identityMasked = maskId(reg.identity); redactInbound = true; return reg.returnTo ? confirmAfter(reg) : ask("REG_LOCATION");
        case "REG_LOCATION": { const v = cleanField(val, 80); if (v.length < 2) return reply(state, [copy(cid, "ask_retry_short")]); reg.location = v; return confirmAfter(reg); }
        case "REG_CONFIRM": {
          if (intent === "YES") return ask("REG_TERMS");
          const fields = collectsIdentity ? { 1: "REG_FIRST", 2: "REG_SURNAME", 3: "REG_IDENTITY", 4: "REG_LOCATION" } : { 1: "REG_FIRST", 2: "REG_SURNAME", 3: "REG_LOCATION" };
          const field = number != null ? fields[number] : null;
          if (field) { reg.returnTo = "REG_CONFIRM"; return ask(field); }
          return ask("REG_CONFIRM");
        }
        case "REG_TERMS": {
          if (intent === "NO") { save("HOME", {}); return reply("HOME", [copy(cid, "terms_declined")]); }
          if (intent !== "YES") return ask("REG_TERMS");
          // registerParticipant throws "participant not active" for a withdrawn
          // profile. That threw out of the turn: no reply at all, the event
          // dead-lettered, the session stayed at REG_TERMS and the person could
          // never come back. Restoring a withdrawal is a staff decision, so say
          // so instead of silently re-activating from the participant channel.
          if (participant && participant.status !== "active") { save("HOME", {}); return reply("HOME", [copy(cid, "registration_withdrawn", { campaign: campaign.name })]); }
          const c = domain.versionContent(cid); const v = domain.getActiveVersion(cid);
          const res = domain.registerParticipant({ phoneUid: pUid, firstName: reg.firstName || participant?.first_name, surname: reg.surname ?? participant?.surname, identity: reg.identity || null, location: reg.location || participant?.location, campaignId: cid, campaignVersionId: v?.id, termsVersion: c.terms_version || `V${v?.version_no || 1}`, privacyVersion: c.privacy_version || `V${v?.version_no || 1}`, marketingConsent: false });
          const p = res.participant;
          // Self-service re-registration rewrites name, surname, town and the
          // national ID that winner verification depends on. The staff path
          // (updateParticipant) audits exactly that change; the participant
          // path did not, so the tamper-evident chain held no record of who
          // changed what or when — including an ID swapped between selection
          // and verification. Audited here with masked before/after values.
          if (participant && !res.created) {
            const changed = [];
            if (participant.first_name !== p.first_name) changed.push("firstName");
            if ((participant.surname || "") !== (p.surname || "")) changed.push("surname");
            if ((participant.location || "") !== (p.location || "")) changed.push("location");
            if ((participant.identity_fp || null) !== (p.identity_fp || null)) changed.push("identity");
            if (changed.length) domain.audit({ actorType: "participant", actorId: p.id, action: "participant.update", targetType: "participant", targetId: p.id, reason: "self-service update over WhatsApp", payload: { fields: changed, before: { first_name: participant.first_name, surname: participant.surname, location: participant.location, identity_masked: participant.identity_masked }, after: { first_name: p.first_name, surname: p.surname, location: p.location, identity_masked: p.identity_masked } } });
          }
          crm?.emit({ entityType: "participant", entityId: p.id, entityVersion: p.row_version || 1, payload: { firstName: p.first_name, surname: p.surname, phone: domain.maskPhone(p.wa_phone_uid), location: p.location, status: p.status }, correlationId });
          if (res.enrollment) crm?.emit({ entityType: "enrollment", entityId: p.id + ":" + cid, entityVersion: 1, payload: { participantId: p.id, campaignCode: campaign.code, termsVersion: res.enrollment.terms_version, privacyVersion: res.enrollment.privacy_version, marketingConsent: !!res.enrollment.marketing_consent, enrolledAt: res.enrollment.enrolled_at }, correlationId });
          save("HOME", { lastReceiptId: ctx.lastReceiptId }, { participantId: p.id });
          return reply("HOME", [copy(cid, "registered", { first_name: p.first_name }), menu(campaign)], { participantId: p.id });
        }
        default: return home();
      }
      function confirmAfter(r) { delete r.returnTo; save("REG_CONFIRM", { ...ctx, reg: r }); return reply("REG_CONFIRM", [copy(cid, confirmKey, regVars(r))]); }
    }
    function regVars(reg) { const c = domain.versionContent(cid); return { first_name: reg.firstName || participant?.first_name || "", surname: reg.surname || participant?.surname || "", identity_masked: reg.identityMasked || participant?.identity_masked || (regFlags().identityStage === "registration" ? "(not given)" : "(asked from winners)"), location: reg.location || participant?.location || "", phone: `+${pUid}`, terms_version: c.terms_version || "unversioned", privacy_version: c.privacy_version || "unversioned", terms_url: c.terms_url || "(link to be supplied)" }; }
    function maskId(v) { const s = String(v); return s.length > 6 ? s.slice(0, 2) + "*".repeat(s.length - 4) + s.slice(-2) : "******"; }

    // -------------------------------------------------------------- entry / outlet
    function startEntry() {
      if (!participant) return reply("HOME", [copy(cid, "not_registered_for_entry")]);
      // A withdrawn profile cannot be re-enrolled from this channel: sending it
      // into the terms flow only ends in registerParticipant throwing out of
      // the turn (no reply, event dead-lettered) — and re-consent after a
      // withdrawal must be a deliberate, staff-recorded act.
      if (participant.status !== "active") { save("HOME", {}); return reply("HOME", [copy(cid, "registration_withdrawn", { campaign: campaign.name })]); }
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
    /** Search results page like the browse lists, and say how many matched. */
    function showSearch(q, page) {
      const all = outletSearch(cid, q);
      if (!all.length) return reply(state, [copy(cid, "outlet_no_match", { query: q.slice(0, 40) })]);
      const { options } = paged(all, page);
      save("OUTLET_SEARCH", { ...ctx, nav: { ...(ctx.nav || {}), page, options, query: q } });
      const shownFrom = page * PAGE + 1, shownTo = Math.min(all.length, page * PAGE + PAGE);
      return reply("OUTLET_SEARCH", [copy(cid, "outlet_search_results", { options: fmtOptions(options), shown: all.length > PAGE ? `${shownFrom}-${shownTo}` : String(all.length), total: all.length })]);
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
      const q = String(text || "").trim();
      // The list labels the next page "More…", so the WORD has to work too —
      // typing it used to be treated as a search and answered "No branch
      // matched \"More\"".
      const moreIdx = /^(more|next)$/i.test(q) ? (nav.options || []).findIndex((o) => o.kind === "more") : -1;
      const idx = number != null ? number - 1 : moreIdx;
      if (idx >= 0 && nav.options) {
        const pick = nav.options[idx];
        if (!pick) return reply(state, [copy(cid, "outlet_choose_number")]);
        if (pick.kind === "more") { const p = (nav.page || 0) + 1; return state === "OUTLET_RETAILER" ? showRetailers(p) : state === "OUTLET_TOWN" ? showTowns(nav.retailer, p) : state === "OUTLET_SEARCH" ? showSearch(nav.query || "", p) : showBranches(nav.retailer, nav.town, p); }
        if (pick.kind === "retailer") return showTowns(pick.value, 0);
        if (pick.kind === "town") return showBranches(nav.retailer, pick.value, 0);
        if (pick.kind === "outlet") return selectOutlet(pick.value);
      }
      if (q.length >= 2) return showSearch(q, 0);
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
        try {
          save("HOME", { lastReceiptId: res.receiptId, lastOutletId: ctx.selectedOutletId }, { activeReceiptId: res.receiptId });
        } catch (e) {
          // The receipt IS accepted and will be judged. If something else wrote
          // the session while the image was being stored (an operator claim, a
          // second inbound message from the same phone), the versioned save
          // threw and the whole turn was retried from the NEW state — HOME —
          // which answers "please send a photo" for a receipt that is already
          // credited, and the reference is never sent. Re-apply the transition
          // without the version check and still acknowledge.
          if (e?.code !== "CONFLICT") throw e;
          const fresh = domain.getSession(cid, pUid);
          domain.setSession(cid, pUid, { state: "HOME", context: { ...ctxOf(fresh), lastReceiptId: res.receiptId, lastOutletId: ctx.selectedOutletId, nav: null }, participantId: participant.id, activeReceiptId: res.receiptId });
        }
        if (res.replay) return reply("HOME", [copy(cid, "processing_wait", { reference: res.reference })], { receiptId: res.receiptId });
        return reply("HOME", [copy(cid, "received", { reference: res.reference })], { receiptId: res.receiptId });
      } catch (e) {
        if (["BAD_TYPE", "TOO_LARGE", "TOO_SMALL", "EMPTY"].includes(e.code)) return reply("ENTRY_RECEIPT", [copy(cid, "media_rejected", { reason: e.message })]);
        log.error?.("[conversation] submit failed", e.message);
        // retryTurn: this one really is retryable, so it must survive the
        // turn-level guard in handle() and reach intake's backoff.
        throw Object.assign(e, { retryTurn: true }); // the participant is not told a false outcome
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
        // cleanField() again at render: rows captured before the fields were
        // sanitised at capture could still carry a newline, which would show
        // every reader a fabricated extra winner line.
        const lines = rows.map((w) => copy(cid, "winners_line", { rank: w.rank, name: cleanField(w.name, 60), location: cleanField(w.location || "", 80), prize: cleanField(w.prize || "", 120) })).join("\n") || "(none)";
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
