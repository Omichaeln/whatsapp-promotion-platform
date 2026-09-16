import { E, page, str } from "../http.mjs";
import { shortRef } from "../copy.mjs";

const T = (tag) => ({ tag });

/**
 * The promotion team's API (the simplified console).
 *
 * A deliberately separate namespace from /api/*: the technical console's
 * contract is depended on by the audited views, the smoke script and the
 * contract document, and reshaping it to suit a second audience would put all
 * of that at risk for no gain. Everything here is a READ over the same tables
 * plus the two entry decisions the promotion administrator is entitled to make.
 *
 * Two rules govern this file:
 *  1. Plain language. The promotion team does not know what REVIEW_REQUIRED or
 *     outlet_selection_mismatch mean, and should not have to. Every status and
 *     reason is translated here, once, server-side — not in the browser, where a
 *     second copy would drift from the codes the pipeline actually writes.
 *  2. No identifiers as the answer. A row names the shop, the town, the person
 *     and the quantity. Internal ids travel too, because the detail panel and
 *     the decision routes need them, but nothing in the UI has to read one.
 */
export function registerPromoRoutes(r, S) {
  const { db, domain, auth, pipeline, conversation, outbox } = S;
  const ADMIN = ["promotion_admin"];
  const TEAM = ["promotion_admin", "promotion_assistant"];

  const activeCampaignId = () => db.prepare(`select id from campaigns where status in ('active','paused') order by created_at desc limit 1`).get()?.id || null;
  const campaignFor = (q) => {
    const id = q?.get("campaign") || activeCampaignId();
    if (!id) throw E.notFound("no campaign is running yet");
    const c = db.prepare(`select id, code, name, status, start_at, end_at from campaigns where id=?`).get(id);
    if (!c) throw E.notFound("campaign not found");
    return c;
  };

  /**
   * What the promotion team sees instead of a disposition code. The wording is
   * the answer to "what happened to this receipt?", not a translation of the
   * enum: "Needs a look" is what a reviewer must do about REVIEW_REQUIRED.
   */
  const STATUS_LABEL = {
    QUALIFIED: "Earned an entry",
    REVIEW_REQUIRED: "Needs a look",
    NOT_QUALIFIED: "Did not qualify",
    DUPLICATE: "Already claimed",
    REUPLOAD_REQUIRED: "Photo unreadable",
    received: "Just arrived",
    processing: "Being read",
    delayed: "Waiting to be read again",
  };
  /** The bucket a submission belongs in, for counting and for the filter chips. */
  const CATEGORY = {
    QUALIFIED: "qualified", REVIEW_REQUIRED: "needs_look", NOT_QUALIFIED: "rejected",
    DUPLICATE: "duplicate", REUPLOAD_REQUIRED: "unreadable",
    received: "in_progress", processing: "in_progress", delayed: "in_progress",
  };
  const ENTRY_STATUS_LABEL = { active: "Counts for the draw", excluded: "Disqualified", withdrawn: "Withdrawn by the participant" };
  /**
   * Why, in a sentence the promotion team can repeat to a shopper. Codes not
   * listed here fall back to the code itself with underscores removed, so a new
   * reason code shows up as readable text rather than disappearing.
   */
  const REASON_LABEL = {
    ok: "Everything checked out",
    not_a_valid_receipt: "The photo is not a till receipt",
    image_quality_insufficient: "The photo is too blurred or dark to read",
    campaign_not_open: "The promotion was not running when this was sent",
    participant_not_enrolled: "They had not accepted the terms yet",
    participant_not_eligible: "This person cannot take part",
    missing_receipt_number: "No receipt number could be read",
    missing_transaction_date: "No purchase date could be read",
    transaction_date_unclear: "The purchase date could not be read with confidence",
    receipt_date_outside_campaign: "Bought outside the promotion dates",
    outlet_not_readable: "The shop name could not be read from the receipt",
    outlet_selection_mismatch: "The shop chosen does not match the receipt",
    outlet_not_participating: "That shop is not part of the promotion",
    no_qualifying_product: "No qualifying product on the receipt",
    quantity_unclear: "The quantity could not be read",
    below_minimum_quantity: "Fewer packs than the promotion requires",
    entry_limit_reached: "They have reached the entry limit for this period",
    total_unclear: "The receipt total could not be read",
    duplicate_receipt: "This receipt has already been used",
    possible_duplicate_other_outlet: "The same receipt number was sent for another branch",
    possible_duplicate_same_outlet: "The same receipt number was sent from this shop already",
    ownership_dispute: "Two people sent the same receipt",
    auto_qualification_paused: "Automatic decisions are paused, so a person must decide",
    period_already_drawn: "This week's draw has already been made",
    reviewer_decision: "Decided by a member of the team",
  };
  const label = (map, code, fallback = "—") => map[code] || (code ? String(code).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : fallback);

  /**
   * How confident the system was in reading this receipt, as a word. The
   * promotion team's question is "can I trust this reading, or should I open the
   * photo?" — a confidence of 0.63 does not answer that and invites a false
   * precision. The thresholds mirror the review_thresholds the rules use.
   */
  const quality = (row) => {
    const q = (() => { try { return JSON.parse(row.quality_json || "{}"); } catch { return {}; } })();
    const conf = row.confidence != null ? Number(row.confidence) : (q.confidence != null ? Number(q.confidence) : null);
    const flags = [];
    if (q.blurred) flags.push("blurred");
    if (q.dark) flags.push("dark");
    if (q.cropped) flags.push("cut off");
    if (q.glare) flags.push("glare");
    const band = conf == null ? "Not measured" : conf >= 0.85 ? "Read clearly" : conf >= 0.6 ? "Read, worth a glance" : "Hard to read";
    return { confidence: conf, band, flags, decided_by: row.decided_by === "system" || !row.decided_by ? "Automatic" : "A person", decided_at: row.decided_at };
  };

  /** Shared WHERE builder. Every filter the promotion console offers. */
  function filters(q, { alias = "r" } = {}) {
    const where = [], args = [];
    const eq = (col, v) => { where.push(`${col}=?`); args.push(v); };
    if (q.get("period")) eq(`${alias}.period_code`, q.get("period"));
    if (q.get("store")) eq(`${alias}.selected_outlet_id`, q.get("store"));
    if (q.get("retailer")) eq(`o.retailer`, q.get("retailer"));
    if (q.get("town")) eq(`o.town`, q.get("town"));
    if (q.get("province")) eq(`o.province`, q.get("province"));
    // Quantity purchased. A null (never read) must not satisfy "at least 1", so
    // the column is compared directly rather than coalesced to zero.
    const num = (k) => { const v = q.get(k); if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    const pmin = num("packs_min"), pmax = num("packs_max");
    if (pmin != null) { where.push(`${alias}.qualifying_packs is not null and ${alias}.qualifying_packs >= ?`); args.push(pmin); }
    if (pmax != null) { where.push(`${alias}.qualifying_packs is not null and ${alias}.qualifying_packs <= ?`); args.push(pmax); }
    // How many receipts this participant has sent to this campaign, in total —
    // the signal the promotion team uses to spot both the enthusiast and the
    // person working the promotion.
    const rmin = num("receipts_min"), rmax = num("receipts_max");
    if (rmin != null || rmax != null) {
      const having = [rmin != null ? "count(*) >= ?" : null, rmax != null ? "count(*) <= ?" : null].filter(Boolean).join(" and ");
      where.push(`${alias}.participant_id in (select participant_id from receipts where campaign_id=${alias}.campaign_id group by participant_id having ${having})`);
      if (rmin != null) args.push(rmin);
      if (rmax != null) args.push(rmax);
    }
    const search = str(q.get("q") || "", 60).trim();
    if (search) {
      where.push(`(p.first_name like ? or p.surname like ? or p.wa_phone_uid like ? or ${alias}.id like ?)`);
      const like = `%${search}%`; args.push(like, like, like, like);
    }
    return { where, args };
  }

  const submittedCount = db.prepare(`select count(*) n from receipts where campaign_id=? and participant_id=?`);
  const personOf = (row) => ({
    id: row.participant_id,
    name: `${row.first_name || ""} ${row.surname || ""}`.trim() || "—",
    phone: domain.maskPhone(row.wa_phone_uid),
    town: row.person_location || null,
    receipts_submitted: submittedCount.get(row.campaign_id, row.participant_id).n,
  });
  const storeOf = (row) => (row.outlet_code ? { id: row.selected_outlet_id, code: row.outlet_code, retailer: row.retailer, branch: row.branch, town: row.town, province: row.province } : null);

  /* ------------------------------------------------------------ overview */

  /**
   * The landing screen: what happened, and what needs a person. Deliberately
   * counts rather than charts — the promotion team's first question every
   * morning is "is anything waiting for me?".
   */
  r.add("GET", "/api/promo/summary", { roles: TEAM, ...T("promo") }, ({ url }) => {
    const c = campaignFor(url.searchParams);
    const period = url.searchParams.get("period") || null;
    const scope = period ? `and period_code=?` : "";
    const a = period ? [c.id, period] : [c.id];
    const byStatus = db.prepare(`select status, count(*) n from receipts where campaign_id=? ${scope} group by status`).all(...a);
    const bucket = { qualified: 0, needs_look: 0, rejected: 0, duplicate: 0, unreadable: 0, in_progress: 0 };
    for (const row of byStatus) { const k = CATEGORY[row.status] || "in_progress"; bucket[k] += row.n; }
    const entries = db.prepare(`select status, count(*) n from entries where campaign_id=? ${period ? "and period_code=?" : ""} group by status`).all(...a);
    const e = { active: 0, excluded: 0, withdrawn: 0 };
    for (const row of entries) if (row.status in e) e[row.status] = row.n;
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return {
      campaign: { id: c.id, code: c.code, name: c.name, status: c.status, start_at: c.start_at, end_at: c.end_at },
      period,
      periods: domain.listPeriods(c.id).map((p) => ({ code: p.period_code, label: p.label || p.period_code })),
      submissions: { ...bucket, total: Object.values(bucket).reduce((x, y) => x + y, 0) },
      entries: { counting: e.active, disqualified: e.excluded, withdrawn: e.withdrawn },
      people: db.prepare(`select count(distinct participant_id) n from receipts where campaign_id=? ${scope}`).get(...a).n,
      needs_attention: {
        receipts_to_check: db.prepare(`select count(*) n from review_tasks t join receipts r on r.id=t.receipt_id where r.campaign_id=? and t.state!='decided'`).get(c.id).n,
        queries_waiting: db.prepare(`select count(*) n from conversation_sessions where campaign_id=? and handoff_owner is not null`).get(c.id).n,
      },
      last_24h: {
        submissions: db.prepare(`select count(*) n from receipts where campaign_id=? and created_at>=?`).get(c.id, since).n,
        entries: db.prepare(`select count(*) n from entries where campaign_id=? and created_at>=?`).get(c.id, since).n,
      },
    };
  });

  /** The values the filter dropdowns offer — only shops this campaign actually uses. */
  r.add("GET", "/api/promo/filters", { roles: TEAM, ...T("promo") }, ({ url }) => {
    const c = campaignFor(url.searchParams);
    const stores = db.prepare(`select o.id, o.outlet_code, o.retailer, o.branch, o.town, o.province
      from campaign_outlets co join outlets o on o.id=co.outlet_id where co.campaign_id=? order by o.retailer, o.town, o.branch`).all(c.id);
    const uniq = (k) => [...new Set(stores.map((s) => s[k]).filter(Boolean))].sort();
    const packs = db.prepare(`select max(qualifying_packs) m from receipts where campaign_id=?`).get(c.id)?.m ?? null;
    return {
      stores, retailers: uniq("retailer"), towns: uniq("town"), provinces: uniq("province"),
      periods: domain.listPeriods(c.id).map((p) => ({ code: p.period_code, label: p.label || p.period_code })),
      categories: [
        { key: "qualified", label: STATUS_LABEL.QUALIFIED }, { key: "needs_look", label: STATUS_LABEL.REVIEW_REQUIRED },
        { key: "rejected", label: STATUS_LABEL.NOT_QUALIFIED }, { key: "duplicate", label: STATUS_LABEL.DUPLICATE },
        { key: "unreadable", label: STATUS_LABEL.REUPLOAD_REQUIRED }, { key: "in_progress", label: "Still being read" },
      ],
      max_packs: packs,
    };
  });

  /* ------------------------------------------------------------- entries */

  /**
   * Entries: the awards that count for the draw. The promotion team's working
   * list. Every column is something they can act on or explain to a shopper.
   */
  r.add("GET", "/api/promo/entries", { roles: TEAM, ...T("promo"),
    query: { campaign: "", period: "", status: "", store: "", retailer: "", town: "", province: "", packs_min: "", packs_max: "", receipts_min: "", receipts_max: "", q: "" } },
  ({ url }) => {
    const c = campaignFor(url.searchParams); const q = url.searchParams; const pg = page(url);
    const f = filters(q, { alias: "r" });
    const where = [`e.campaign_id=?`, ...f.where]; const args = [c.id, ...f.args];
    if (q.get("status")) { where.push(`e.status=?`); args.push(q.get("status")); }
    const sql = `from entries e
      join receipts r on r.id=e.receipt_id
      join participants p on p.id=e.participant_id
      left join outlets o on o.id=r.selected_outlet_id
      where ${where.join(" and ")}`;
    const rows = db.prepare(`select e.id as entry_id, e.status as entry_status, e.created_at as awarded_at, e.period_code, e.entry_no,
        r.id as receipt_id, r.status as receipt_status, r.reason_code, r.selected_outlet_id, r.qualifying_packs, r.qualifying_grams,
        r.quality_json, r.decided_by, r.decided_at, r.campaign_id, r.participant_id,
        p.first_name, p.surname, p.wa_phone_uid, p.location as person_location,
        o.outlet_code, o.retailer, o.branch, o.town, o.province
      ${sql} order by e.created_at desc limit ? offset ?`).all(...args, pg.limit, pg.offset);
    return {
      total: db.prepare(`select count(*) n ${sql}`).get(...args).n,
      rows: rows.map((x) => ({
        entry_id: x.entry_id, receipt_id: x.receipt_id, reference: shortRef(x.receipt_id), entry_no: x.entry_no,
        period: x.period_code, awarded_at: x.awarded_at,
        standing: x.entry_status, standing_label: label(ENTRY_STATUS_LABEL, x.entry_status),
        person: personOf(x), store: storeOf(x),
        packs: x.qualifying_packs, grams: x.qualifying_grams,
        reason: x.reason_code, reason_label: label(REASON_LABEL, x.reason_code, "Everything checked out"),
        quality: quality(x),
      })),
      next: pg.next(rows),
    };
  });

  /**
   * Submissions: every receipt sent in, whatever happened to it. This is where
   * "which entries are in what category" is actually answered — an entry only
   * exists for the ones that qualified, so a list of entries can never show the
   * team why the others did not.
   */
  r.add("GET", "/api/promo/submissions", { roles: TEAM, ...T("promo"),
    query: { campaign: "", period: "", category: "", store: "", retailer: "", town: "", province: "", packs_min: "", packs_max: "", receipts_min: "", receipts_max: "", q: "" } },
  ({ url }) => {
    const c = campaignFor(url.searchParams); const q = url.searchParams; const pg = page(url);
    const f = filters(q, { alias: "r" });
    const where = [`r.campaign_id=?`, ...f.where]; const args = [c.id, ...f.args];
    const cat = q.get("category");
    if (cat) {
      const statuses = Object.entries(CATEGORY).filter(([, v]) => v === cat).map(([k]) => k);
      if (!statuses.length) throw E.badRequest(`unknown category "${cat}"`);
      where.push(`r.status in (${statuses.map(() => "?").join(",")})`); args.push(...statuses);
    }
    const sql = `from receipts r
      join participants p on p.id=r.participant_id
      left join outlets o on o.id=r.selected_outlet_id
      where ${where.join(" and ")}`;
    const rows = db.prepare(`select r.id as receipt_id, r.status, r.reason_code, r.created_at, r.period_code, r.selected_outlet_id,
        r.qualifying_packs, r.qualifying_grams, r.quality_json, r.decided_by, r.decided_at, r.campaign_id, r.participant_id,
        p.first_name, p.surname, p.wa_phone_uid, p.location as person_location,
        o.outlet_code, o.retailer, o.branch, o.town, o.province,
        (select id from entries where receipt_id=r.id) as entry_id,
        (select status from entries where receipt_id=r.id) as entry_status
      ${sql} order by r.created_at desc limit ? offset ?`).all(...args, pg.limit, pg.offset);
    return {
      total: db.prepare(`select count(*) n ${sql}`).get(...args).n,
      rows: rows.map((x) => ({
        receipt_id: x.receipt_id, reference: shortRef(x.receipt_id), sent_at: x.created_at, period: x.period_code,
        category: CATEGORY[x.status] || "in_progress", outcome: label(STATUS_LABEL, x.status),
        reason: x.reason_code, reason_label: label(REASON_LABEL, x.reason_code, x.status === "QUALIFIED" ? "Everything checked out" : "—"),
        person: personOf(x), store: storeOf(x),
        packs: x.qualifying_packs, grams: x.qualifying_grams, quality: quality(x),
        entry_id: x.entry_id, entry_standing: x.entry_status ? label(ENTRY_STATUS_LABEL, x.entry_status) : null,
      })),
      next: pg.next(rows),
    };
  });

  /** One submission in full: the story of this receipt, in order, in plain words. */
  r.add("GET", "/api/promo/submissions/:id", { roles: TEAM, ...T("promo") }, ({ params }) => {
    const x = db.prepare(`select r.*, p.first_name, p.surname, p.wa_phone_uid, p.location as person_location,
        o.outlet_code, o.retailer, o.branch, o.town, o.province
      from receipts r join participants p on p.id=r.participant_id
      left join outlets o on o.id=r.selected_outlet_id where r.id=?`).get(params.id);
    if (!x) throw E.notFound("submission not found");
    const entry = db.prepare(`select * from entries where receipt_id=?`).get(x.id);
    const checks = (() => {
      const v = db.prepare(`select rule_results_json, confidence from validation_results where receipt_id=? order by attempt_no desc limit 1`).get(x.id);
      try {
        return (JSON.parse(v?.rule_results_json || "[]")).map((c) => ({
          check: String(c.key || "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
          outcome: c.outcome === "pass" ? "Met" : c.outcome === "fail" ? "Not met" : "Could not tell",
          why: c.reason ? label(REASON_LABEL, c.reason) : null,
        }));
      } catch { return []; }
    })();
    return {
      submission: {
        receipt_id: x.id, reference: shortRef(x.id), sent_at: x.created_at, period: x.period_code,
        category: CATEGORY[x.status] || "in_progress", outcome: label(STATUS_LABEL, x.status),
        reason: x.reason_code, reason_label: label(REASON_LABEL, x.reason_code, x.status === "QUALIFIED" ? "Everything checked out" : "—"),
        person: personOf(x), store: storeOf(x),
        packs: x.qualifying_packs, grams: x.qualifying_grams, quality: quality(x),
      },
      entry: entry ? { id: entry.id, entry_no: entry.entry_no, period: entry.period_code, standing: entry.status, standing_label: label(ENTRY_STATUS_LABEL, entry.status), awarded_at: entry.created_at } : null,
      checks,
      items: db.prepare(`select description, sku, quantity, unit_weight_kg, amount from receipt_items where receipt_id=? order by rowid`).all(x.id),
      history: db.prepare(`select action, actor_id, reason, created_at from audit_events where target_type='receipt' and target_id=? order by id`).all(x.id)
        .map((h) => ({ what: String(h.action).replace(/[._]/g, " "), who: h.actor_id === "pipeline" ? "Automatic" : h.actor_id, why: h.reason ? label(REASON_LABEL, h.reason) : null, at: h.created_at })),
    };
  });

  /**
   * The receipt photo, fetched with the signed-in session.
   *
   * Judging "is this reading trustworthy?" means looking at the picture, so the
   * promotion team needs it. Served here rather than by widening the technical
   * /api/media route's role list: that route is reached by a signed URL and is
   * covered by the audit's tamper tests, and adding roles to it would change a
   * surface two other things depend on. An authenticated fetch is also the
   * pattern the console already uses — no URL that works without a session.
   */
  r.add("GET", "/api/promo/submissions/:id/photo", { roles: TEAM, produces: ["image/jpeg", "image/png"], ...T("promo") }, ({ params, url, res }) => {
    const rec = db.prepare(`select media_asset_id from receipts where id=?`).get(params.id);
    if (!rec) throw E.notFound("submission not found");
    const a = rec.media_asset_id ? S.mediaStore.get(rec.media_asset_id) : null;
    const normalised = url.searchParams.get("v") === "normalised";
    const bytes = a ? S.mediaStore.readBytes(a, { normalised }) : null;
    // A purged image is the expected end state once retention has run, not a
    // fault: say so plainly so the console can show "the photo has been deleted"
    // rather than a broken picture.
    if (!bytes) throw E.notFound("the photo is no longer stored");
    res.writeHead(200, { "content-type": normalised ? "image/png" : a.mime, "content-length": bytes.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" });
    res.end(bytes);
  });

  /* ------------------------------------------------------------- queries */

  /**
   * Participant queries: the people waiting for a human. The technical console
   * makes an operator type a phone number to find one, which is only usable if
   * you already know who is waiting. This is the list.
   */
  r.add("GET", "/api/promo/queries", { roles: TEAM, ...T("promo") }, ({ url }) => {
    const c = campaignFor(url.searchParams);
    const openOnly = url.searchParams.get("state") !== "all";
    const rows = db.prepare(`select s.wa_phone_uid, s.state, s.handoff_owner, s.handoff_since, s.updated_at,
        p.id as participant_id, p.first_name, p.surname
      from conversation_sessions s left join participants p on p.wa_phone_uid=s.wa_phone_uid
      where s.campaign_id=? ${openOnly ? "and s.handoff_owner is not null" : ""}
      order by s.handoff_since is null, s.handoff_since, s.updated_at desc limit 200`).all(c.id);
    return {
      rows: rows.map((s) => {
        const last = db.prepare(`select payload_json, received_at from channel_events where wa_phone_uid=? and event_kind like 'message.%' order by received_at desc limit 1`).get(s.wa_phone_uid);
        let text = null; try { text = JSON.parse(last?.payload_json || "{}").text || null; } catch { /* unparsable */ }
        return {
          phone: domain.maskPhone(s.wa_phone_uid), phone_uid: s.wa_phone_uid,
          participant_id: s.participant_id,
          name: `${s.first_name || ""} ${s.surname || ""}`.trim() || "Not registered",
          waiting: !!s.handoff_owner, waiting_since: s.handoff_since,
          owner: s.handoff_owner === "queue" ? null : s.handoff_owner,
          claimed: !!s.handoff_owner && s.handoff_owner !== "queue",
          last_message: text ? String(text).slice(0, 160) : null, last_message_at: last?.received_at || null,
          where_they_are: s.state,
        };
      }),
    };
  });

  /* ----------------------------------------------------------- decisions */

  /**
   * Disqualify or reinstate an entry. Administrator only: an assistant answers
   * queries and reads, and must not be able to take a shopper's entry away.
   * Both delegate to the audited pipeline, so dual control, the frozen-draw
   * guard and the hash-chained audit trail all still apply — this route adds no
   * privilege, it only presents the action in plain language.
   */
  r.add("POST", "/api/promo/entries/:id/disqualify", { roles: ADMIN, ...T("promo") }, async ({ user, params, body }) => {
    const b = await body();
    const reason = str(b.reason, 300);
    if (!reason) throw E.badRequest("say why this entry is being disqualified — it is recorded and shown to auditors");
    return pipeline.disqualifyEntry(params.id, { actorId: user.id, reason, approvedBy: str(b.approved_by, 60), note: str(b.note, 500) });
  });
  r.add("POST", "/api/promo/entries/:id/reinstate", { roles: ADMIN, ...T("promo") }, async ({ user, params, body }) => {
    const b = await body();
    const reason = str(b.reason, 300);
    if (!reason) throw E.badRequest("say why this entry is being put back");
    return pipeline.reinstateEntry(params.id, { actorId: user.id, reason, approvedBy: str(b.approved_by, 60) });
  });

  /** Answer a query. Both roles: replying to a shopper is the assistant's job. */
  r.add("POST", "/api/promo/queries/:phone/claim", { roles: TEAM, ...T("promo") }, ({ user, params }) => {
    const cid = activeCampaignId(); if (!cid) throw E.conflict("no campaign is running");
    conversation.claimHandoff(cid, params.phone, user.id); return { ok: true };
  });
  r.add("POST", "/api/promo/queries/:phone/release", { roles: TEAM, ...T("promo") }, ({ user, params }) => {
    const cid = activeCampaignId(); if (!cid) throw E.conflict("no campaign is running");
    conversation.releaseHandoff(cid, params.phone, user.id); return { ok: true };
  });
  r.add("POST", "/api/promo/queries/:phone/send", { roles: TEAM, ...T("promo") }, async ({ user, params, body }) => {
    const b = await body();
    const text = str(b.text, 900);
    if (!text) throw E.badRequest("type a message to send");
    const cid = activeCampaignId(); if (!cid) throw E.conflict("no campaign is running");
    // Same path as the technical console's support reply: the durable outbox,
    // never the provider directly, so the message survives a restart and the
    // consent and service-window rules still apply to it.
    const p = domain.getParticipantByPhone(params.phone);
    const out = outbox.enqueueWhatsApp({ waPhoneUid: p?.wa_phone_uid || params.phone, kind: "text", purpose: "support", campaignId: cid, payload: text, idempotencyKey: `support:${user.id}:${Date.now()}` });
    domain.audit({ actorType: "admin", actorId: user.id, action: "support.message", targetType: "conversation", targetId: domain.maskPhone(params.phone), payload: { len: text.length } });
    return out;
  });

  /** Who am I, and what may I do — so the console renders only reachable actions. */
  r.add("GET", "/api/promo/me", { roles: TEAM, ...T("promo") }, ({ user }) => ({
    name: user.name || user.email, email: user.email,
    can_decide_entries: auth.hasRole(user, "promotion_admin"),
    can_answer_queries: true,
  }));
}
