import { id, normalizePhone, nowIso } from "./db.mjs";

/**
 * Conversation state machine (G-03, spec 6.1). Explicit persisted state per
 * campaign + normalized WhatsApp identity; never inferred from message text.
 * Resumable after restart / provider retry / interruption. Participant-facing
 * copy is versioned in campaign content (with English defaults here).
 */
export const STATES = {
  HOME: "HOME",
  REGISTER_NAME: "REGISTER_NAME",
  REGISTER_IDENTITY: "REGISTER_IDENTITY",
  REGISTER_LOCATION: "REGISTER_LOCATION",
  REGISTER_CONSENT: "REGISTER_CONSENT",
  ENTRY_OUTLET: "ENTRY_OUTLET",
  ENTRY_RECEIPT: "ENTRY_RECEIPT",
  PROCESSING: "PROCESSING",
  QUALIFIED: "QUALIFIED",
  NOT_QUALIFIED: "NOT_QUALIFIED",
  DUPLICATE: "DUPLICATE",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  ERROR: "ERROR",
};

const DEFAULT_COPY = {
  menu_home: "Welcome! 1) Register  2) Enter Promotion  3) How it works  4) Terms  5) Prizes  6) Winners  7) Status  9) Help  (reply MENU anytime)",
  menu_entry: "Send another qualifying receipt (reply ENTER), or MENU.",
  ask_name: "Let's set you up. Reply with your FIRST NAME and SURNAME, e.g. Tapiwa Moyo",
  ask_name_retry: "Please reply with your first name and surname.",
  ask_identity: "Reply with your ID / passport number (numbers and letters only).",
  ask_identity_retry: "That doesn't look like a valid ID. Reply with numbers/letters only, or CANCEL.",
  ask_location: "Which town/city are you in? (e.g. Harare)",
  ask_location_retry: "Please reply with your town or city.",
  consent: "Reply YES to confirm you are 18 or older and that you agree to the current Promotion Terms and Privacy Notice, or NO to cancel.",
  consent_declined: "No problem — you're not registered. No entry was created. Reply MENU to start over.",
  registered: "You're registered! ✅",
  welcome_back: "Welcome back!",
  ask_outlet: "Which participating outlet did you buy from? Reply with the outlet CODE (e.g. OK-HRE-01) or town name.",
  ask_outlet_retry: "I couldn't match that outlet. Reply with an outlet code or town, or MENU.",
  ask_receipt: "Send ONE clear photo of your full receipt (front). It must show the date, receipt number and total.",
  need_image: "Please send a photo of your receipt (image), not text.",
  media_missing: "I didn't receive the image. Please try again.",
  processing: "Receipt received — processing now. Reply STATUS to check.",
  campaign_paused: "The promotion is currently paused. Please try again later.",
  error: "Sorry, something went wrong. Try again, or reply MENU.",
  no_campaign: "There is no active promotion right now.",
  help: "Options: REGISTER, ENTER, MENU, STATUS, BACK, CANCEL. For help, reply MENU.",
  cancel: "Cancelled. Reply MENU to start over.",
  mechanics: "Buy at least 2 x 2kg packs of the qualifying product at a participating outlet, send your receipt, and get one draw entry per qualifying receipt.",
  terms: "Terms & Conditions: one entry per qualifying receipt; duplicates are rejected; winners verified before prizes. Full terms: <link>",
  prizes: "Weekly prizes are published under WINNERS. Check back each week.",
  winners: "Latest approved winners are grouped by week. A new draw runs each Monday.",
  qualified: "✅ Entry confirmed! You're in the draw. Reply ENTER to submit another receipt.",
  duplicate: "This receipt has already been used for an entry. You cannot enter with it again.",
  not_qualified: "Thanks, but this receipt does not qualify. Send another qualifying receipt or reply MENU.",
  needs_review: "Receipt received — it's being reviewed and we'll update you. Reply MENU meanwhile.",
  status: "You have {count} active entr{ies} this week.",
};

export function parseIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  // P1-01: numbers must match the menu the participant actually sees:
  // 1 Register  2 Enter  3 How it works  4 Terms  5 Prizes  6 Winners
  // 7 Status  8 Help
  if (["register", "sign up", "1"].includes(t)) return "REGISTER";
  if (["enter", "enter promotion", "2"].includes(t)) return "ENTER";
  if (["mechanics", "how it works", "3"].includes(t)) return "MECHANICS";
  if (["terms", "4"].includes(t)) return "TERMS";
  if (["prizes", "5"].includes(t)) return "PRIZES";
  if (["winners", "6"].includes(t)) return "WINNERS";
  if (["status", "7"].includes(t)) return "STATUS";
  if (["menu", "main menu", "0"].includes(t)) return "MENU";
  if (["help", "9"].includes(t)) return "HELP";
  if (["back", "b"].includes(t)) return "BACK";
  if (["cancel"].includes(t)) return "CANCEL";
  if (["yes", "accept", "agree", "y"].includes(t)) return "YES";
  if (["no", "decline", "n", "skip"].includes(t)) return "NO";
  return null;
}

export function createConversationService({ db, domain, receiptPipeline, outbox, now = nowIso }) {
  const activeCampaignId = () => {
    const row = db.prepare(`select id from campaigns where status='active' order by created_at limit 1`).get();
    return row?.id || null;
  };
  function content(campaignId, key) {
    const v = campaignId ? domain.getActiveVersion(campaignId) : null;
    try {
      const c = v ? JSON.parse(v.content_json || "{}") : {};
      return c[key] || DEFAULT_COPY[key] || key;
    } catch { return DEFAULT_COPY[key] || key; }
  }
  function resolveOutlet(text) {
    const t = String(text || "").toLowerCase().trim();
    const outlets = domain.listOutlets();
    return outlets.find((o) =>
      String(o.outlet_code).toLowerCase() === t || (o.town && String(o.town).toLowerCase() === t) || o.id === t)?.id || null;
  }
  const ctxOf = (s) => { try { return JSON.parse(s?.context_json || "{}"); } catch { return {}; } };
  function outcome(decision) {
    return decision === "QUALIFIED" ? STATES.QUALIFIED
      : decision === "DUPLICATE" ? STATES.DUPLICATE
      : decision === "NEEDS_REVIEW" ? STATES.NEEDS_REVIEW
      : STATES.NOT_QUALIFIED;
  }

  async function handle({ providerMessageId, phoneUid, type, text, mediaBytes, mime, confirmedParticipantId }) {
    if (!providerMessageId) throw new Error("missing provider message id");
    const campaignId = activeCampaignId();
    if (!campaignId) return { replies: [content(null, "no_campaign")], state: STATES.ERROR };

    // Durable, idempotent intake (G-02): persist BEFORE processing; a replay
    // of the same provider message returns no reply and creates no second entry.
    const pUid = normalizePhone(phoneUid) || phoneUid;
    const evId = `evt_${providerMessageId}`;
    const inserted = db.prepare(
      `insert or ignore into inbound_events (id, provider_message_id, campaign_id, wa_phone_uid, provider, payload_json, status, received_at)
       values (?,?,?,?,?,?,?,?)`).run(evId, providerMessageId, campaignId, pUid, "mixed", "", "received", nowIso());
    if (inserted.changes === 0) return { replies: [], alreadySeen: true };

    const session = domain.getSession(campaignId, pUid);
    const state = session?.state || STATES.HOME;
    const intent = parseIntent(text);
    const pidThere = session?.participant_id || confirmedParticipantId || null;
    const participant = pidThere ? pidThere : domain.getParticipantByPhone(pUid)?.id || null;

    const send = (key, state) => ({ replies: [content(campaignId, key)], state });
    const setSession = (st, ctx) => domain.setSession(campaignId, pUid, { state: st, context: ctx, participantId: ctx?.participantId || participant });

    // Requests to interrupt/leave
    if (intent === "CANCEL" || intent === "BACK") { setSession(STATES.HOME, { back: true }); return send("menu_home", STATES.HOME); }
    if (intent === "HELP") return send("help", state);
    if (intent === "MENU") { setSession(STATES.HOME, {}); return send("menu_home", STATES.HOME); }

    switch (state) {
      case STATES.HOME:
        if (!participant || intent === "REGISTER") { setSession(STATES.REGISTER_NAME, {}); return send("ask_name", STATES.REGISTER_NAME); }
        if (intent === "ENTER") { setSession(STATES.ENTRY_OUTLET, {}); return send("ask_outlet", STATES.ENTRY_OUTLET); }
        // P1-01: STATUS must return status, never start an entry.
        if (intent === "STATUS") {
          const pid = participant;
          const n = pid ? domain.countWeeklyEntries(pid, campaignId) : 0;
          return { replies: [content(campaignId, "status").replace("{count}", String(n)).replace("{ies}", n === 1 ? "y" : "ies")], state };
        }
        if (intent === "MECHANICS") return send("mechanics", state);
        if (intent === "TERMS") return send("terms", state);
        if (intent === "PRIZES") return send("prizes", state);
        if (intent === "WINNERS") return send("winners", state);
        if (intent === null) { setSession(STATES.REGISTER_NAME, {}); return send("ask_name", STATES.REGISTER_NAME); }
        return send("menu_home", state);

      case STATES.REGISTER_NAME: {
        if (!text || text.trim().length < 3) return send("ask_name_retry", state);
        const [fn, ...rest] = text.trim().split(/\s+/);
        setSession(STATES.REGISTER_IDENTITY, { ...ctxOf(session), firstName: fn, surname: rest.join(" ") });
        return send("ask_identity", STATES.REGISTER_IDENTITY);
      }
      case STATES.REGISTER_IDENTITY: {
        const v = String(text || "").trim();
        // P1-01: identity is OPTIONAL (D-06 open) — NO/SKIP moves on without it.
        if (intent === "NO") { setSession(STATES.REGISTER_LOCATION, { ...ctxOf(session), identity: null }); return send("ask_location", STATES.REGISTER_LOCATION); }
        if (!/^[A-Za-z0-9-]{6,}$/.test(v)) return send("ask_identity_retry", state);
        setSession(STATES.REGISTER_LOCATION, { ...ctxOf(session), identity: v });
        return send("ask_location", STATES.REGISTER_LOCATION);
      }
      case STATES.REGISTER_LOCATION: {
        const v = String(text || "").trim();
        if (v.length < 2) return send("ask_location_retry", state);
        setSession(STATES.REGISTER_CONSENT, { ...ctxOf(session), location: v });
        return send("consent", STATES.REGISTER_CONSENT);
      }
      case STATES.REGISTER_CONSENT: {
        if (intent === "NO") { setSession(STATES.HOME, {}); return send("consent_declined", STATES.HOME); }
        if (intent !== "YES") return send("consent", state);
        const c = ctxOf(session);
        // P1-01: consent binds to the ACTIVE campaign version, not hardcoded T1/P1.
        const v = domain.getActiveVersion(campaignId);
        const termsVersion = v?.content_json ? (() => { try { return JSON.parse(v.content_json).terms_version; } catch { return null; } })() : null;
        const tv = termsVersion || (v ? `V${v.version_no}` : "T1");
        const res = domain.registerParticipant({ phoneUid: pUid, firstName: c.firstName, surname: c.surname || "", identity: c.identity || null, location: c.location || null, ageConfirmed: true, termsVersion: tv, privacyVersion: tv });
        const pid = res.participant.id;
        setSession(STATES.ENTRY_OUTLET, { participantId: pid });
        return { replies: [content(campaignId, res.created ? "registered" : "welcome_back"), content(campaignId, "ask_outlet")], state: STATES.ENTRY_OUTLET };
      }
      case STATES.ENTRY_OUTLET: {
        const pid = session?.participant_id || participant;
        if (!pid) { setSession(STATES.HOME, {}); return send("menu_home", STATES.HOME); }
        const outletId = resolveOutlet(text);
        if (!outletId) return send("ask_outlet_retry", state);
        setSession(STATES.ENTRY_RECEIPT, { selectedOutletId: outletId, participantId: pid });
        return send("ask_receipt", STATES.ENTRY_RECEIPT);
      }
      case STATES.ENTRY_RECEIPT: {
        const pid = session?.participant_id || participant;
        if (type !== "message.image" && type !== "message.document") { console.error("[conv] ENTRY_RECEIPT not image", type); return send("need_image", state); }
        if (!mediaBytes) { console.error("[conv] ENTRY_RECEIPT no mediaBytes"); return send("media_missing", state); }
        const version = domain.getActiveVersion(campaignId);
        if (!version) { console.error("[conv] ENTRY_RECEIPT no version"); return send("campaign_paused", STATES.ERROR); }
        setSession(STATES.PROCESSING, ctxOf(session));
        try {
          const result = await receiptPipeline.process({
            campaignId, campaignVersionId: version.id, participantId: pid, phoneUid: pUid,
            selectedOutletId: ctxOf(session).selectedOutletId, providerMessageId, imageBytes: mediaBytes, mime,
          });
          const st = outcome(result.decision);
          setSession(st, {});
          return { replies: [content(campaignId, result.decision === "QUALIFIED" ? "qualified" : result.decision === "DUPLICATE" ? "duplicate" : result.decision === "NEEDS_REVIEW" ? "needs_review" : "not_qualified")], state: st, receiptId: result.receiptId };
        } catch (e) {
          console.error("[conv] ENTRY_RECEIPT process error:", e.message);
          setSession(STATES.ERROR, {});
          return send("error", STATES.ERROR);
        }
      }
      case STATES.PROCESSING: return send("processing", state);
      default:
        setSession(STATES.HOME, {});
        return send("menu_home", STATES.HOME);
    }
  }

  return { handle };
}