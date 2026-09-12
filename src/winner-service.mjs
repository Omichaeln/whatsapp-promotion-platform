import crypto from "node:crypto";
import { id, tx, nowIso } from "./db.mjs";
import { renderCopy } from "./copy.mjs";

/**
 * Winner, alternate, claim and publication lifecycle (spec §15).
 * status: selected -> notified -> verified -> accepted -> collected
 *         | unreachable | declined | ineligible | expired | disputed | replaced
 * publication_state: unpublished | published | withdrawn (separate from prize verification)
 * Winner rows are materialised only from an APPROVED draw's stored output;
 * notification is queued to the outbox (template-eligibility is checked at
 * dispatch by the worker). Alternates are promoted by an audited action under
 * the configured rules — never by a fresh random draw.
 */
const TRANSITIONS = {
  selected: ["notified", "unreachable", "ineligible", "expired", "replaced", "declined"],
  notified: ["verified", "unreachable", "declined", "ineligible", "expired", "disputed", "replaced"],
  verified: ["accepted", "declined", "ineligible", "expired", "disputed", "replaced"],
  accepted: ["collected", "expired", "ineligible", "disputed", "replaced"],
  disputed: ["verified", "ineligible", "replaced"],
  unreachable: ["notified", "expired", "replaced"],
  collected: [], declined: ["replaced"], ineligible: ["replaced"], expired: ["replaced"], replaced: [],
};

/** Statuses that move a winner TOWARDS a prize; they must not run on a disqualified entry. */
const ADVANCING = ["notified", "verified", "accepted", "collected"];
/** Outbound states that prove the winner was NOT reached (the send is finished and failed). */
const NOT_CONTACTED = ["retryable_failure", "permanent_failure", "unknown_outcome"];

export function createWinnerService(db, { outbox, domain, crm = null, now = nowIso, claimDays = 7 } = {}) {
  const getWinner = db.prepare(`select * from winners where id = ?`);
  const getEntry = db.prepare(`select id, status from entries where id = ?`);
  const lastNotifyMessage = db.prepare(`select status, attempts, error_code, last_error from outbound_messages where idempotency_key like ? order by created_at desc limit 1`);
  const getDraw = db.prepare(`select d.*, coalesce(cp.code, d.draw_period) as period_code, cp.label as period_label from draws d left join campaign_periods cp on cp.id = d.period_id where d.id = ?`);
  const listByDraw = db.prepare(`select * from winners where draw_id = ? order by rank`);

  function materialise(drawId, actorId) {
    const d = getDraw.get(drawId); if (!d) throw Object.assign(new Error("draw not found"), { code: "NOT_FOUND" });
    if (!["approved", "published"].includes(d.status)) throw Object.assign(new Error("winners exist only for approved draws"), { code: "CONFLICT" });
    const existing = listByDraw.all(drawId);
    if (existing.length) return { winners: existing, created: 0, idempotent: true };
    const output = JSON.parse(d.output_json || "{}");
    const campaign = domain.getCampaign(d.campaign_id);
    const content = domain.versionContent(d.campaign_id);
    return tx(db, () => {
      const created = [];
      for (const [i, w] of (output.winners || []).entries()) {
        const entry = db.prepare(`select * from entries where id=?`).get(w.entryId);
        const p = entry ? domain.getParticipant(entry.participant_id) : null;
        const wid = id("win");
        const tier = (output.plan?.tiers || []).find((t) => t.code === w.prize_code);
        db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, notify_state, history_json, published_fields_json, publication_state, display_name, row_version)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(wid, drawId, i + 1, w.entryId, entry?.participant_id || null, w.prize_code || "P1", "selected", JSON.stringify({ attempts: 0 }), JSON.stringify([{ to: "selected", at: now(), by: actorId }]), JSON.stringify({ draw_period: d.period_code, prize: tier?.label || w.prize_code }), "unpublished", p ? `${p.first_name} ${String(p.surname || "").slice(0, 1)}.` : null, 1);
        db.prepare(`insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`).run(id("clm"), wid, "selected", JSON.stringify({ by: actorId }), now());
        // The draw's stored output is hash-verified and exported in the audit
        // bundle, so the row is ALWAYS created — dropping it would put the
        // winners table at odds with the verified bundle. But an entry
        // disqualified after the draw must not quietly walk the claim path, so
        // raise it here; transitionInTx and publish() refuse to advance it.
        if (entry && entry.status !== "active") domain.alert({ kind: "winners.entry_not_active", severity: "critical", runbook: "docs/runbooks/winners-claims.md",
          message: `winner ${wid} (draw ${drawId}, rank ${i + 1}) was materialised from entry ${w.entryId} which is ${entry.status}`, detail: { winnerId: wid, entryId: w.entryId, entryStatus: entry.status } });
        domain.audit({ actorType: "admin", actorId, action: "winner.selected", targetType: "winner", targetId: wid, payload: { drawId, entryId: w.entryId, prize: w.prize_code, entryStatus: entry?.status || null } });
        crm?.emit({ entityType: "winner", entityId: wid, entityVersion: 1, payload: { participantId: entry?.participant_id, campaignCode: campaign?.code, period: d.period_code, prize: tier?.label || w.prize_code, rank: i + 1, status: "selected" } });
        created.push(getWinner.get(wid));
      }
      return { winners: created, created: created.length, idempotent: false };
    });
  }

  /** Queue the approved winner message (only after draw approval; template eligibility checked at dispatch). */
  function notify(winnerId, actorId) {
    const w = getWinner.get(winnerId); if (!w) throw Object.assign(new Error("winner not found"), { code: "NOT_FOUND" });
    const d = getDraw.get(w.draw_id);
    if (!["approved", "published"].includes(d.status)) throw Object.assign(new Error("draw is not approved"), { code: "CONFLICT" });
    if (!["selected", "unreachable"].includes(w.status)) throw Object.assign(new Error(`winner is ${w.status}`), { code: "CONFLICT" });
    const p = domain.getParticipant(w.participant_id); if (!p || p.status !== "active") throw Object.assign(new Error("participant not active"), { code: "CONFLICT" });
    const campaign = domain.getCampaign(d.campaign_id); const content = domain.versionContent(d.campaign_id);
    const token = crypto.randomBytes(8).toString("hex").toUpperCase();
    const claimRef = `${token.slice(0, 4)}-${token.slice(4, 8)}`;
    const deadline = new Date(Date.now() + claimDays * 86400_000).toISOString();
    const prize = JSON.parse(w.published_fields_json || "{}").prize || w.prize_code;
    return tx(db, () => {
      db.prepare(`update winners set claim_token_hash=?, claim_expires_at=?, contact_attempts=contact_attempts+1 where id=?`).run(hashToken(claimRef), deadline, winnerId);
      const attempt = w.contact_attempts + 1;
      outbox.enqueueWhatsApp({ waPhoneUid: p.wa_phone_uid, kind: content.winner_template_name ? "template" : "text", templateName: content.winner_template_name || null, purpose: "winner_contact", campaignId: d.campaign_id,
        payload: content.winner_template_name ? { name: content.winner_template_name, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: p.first_name }, { type: "text", text: prize }, { type: "text", text: claimRef }] }] }
          : renderCopy(content, "winner_contact", { first_name: p.first_name, campaign: campaign?.name, period: d.period_label || d.period_code, prize, claim_ref: claimRef, deadline: deadline.slice(0, 10) }),
        idempotencyKey: `winner:${winnerId}:notify:${attempt}` });
      transitionInTx(w, "notified", { actorId, note: `contact attempt ${attempt}` });
      return { winnerId, claimRef, deadline };
    });
  }

  function transition(winnerId, { status, actorId, note = null, reason = null, expectedVersion = null, collectionOutletId = null, fulfilmentRef = null, evidence = null }) {
    return tx(db, () => {
      const w = getWinner.get(winnerId); if (!w) throw Object.assign(new Error("winner not found"), { code: "NOT_FOUND" });
      if (expectedVersion != null && w.row_version !== Number(expectedVersion)) throw Object.assign(new Error("winner changed since you loaded it; reload"), { code: "CONFLICT" });
      if (!(TRANSITIONS[w.status] || []).includes(status)) throw Object.assign(new Error(`cannot move winner from ${w.status} to ${status}`), { code: "CONFLICT" });
      if (status === "collected" && !collectionOutletId && !w.collection_outlet_id) throw Object.assign(new Error("collection outlet required"), { code: "VALIDATION" });
      // Validate at 'accepted' too: that is where the collection point is agreed
      // with the winner, so an outlet that cannot distribute must be refused
      // before the winner is sent there, not at hand-over.
      if (["accepted", "collected"].includes(status) && (collectionOutletId || w.collection_outlet_id)) assertCollectionPoint(w, collectionOutletId || w.collection_outlet_id);
      if (status === "collected" && w.fulfilled_at) throw Object.assign(new Error("already fulfilled"), { code: "CONFLICT" });
      const out = transitionInTx(w, status, { actorId, note, reason, collectionOutletId, fulfilmentRef, evidence });
      if (status === "replaced") return { ...out, replacement: promoteAlternate(w, actorId, reason || "replaced") };
      return out;
    });
  }
  /** A prize may only be handed over at an outlet THIS CAMPAIGN lists as a collection point. */
  function assertCollectionPoint(w, outletId) {
    const o = domain.getOutlet(outletId);
    if (!o || !o.collection_enabled || !o.active) throw Object.assign(new Error("outlet cannot distribute prizes"), { code: "VALIDATION" });
    // The master flag is not the flag the console shows. campaign_outlets carries
    // its own collection_enabled and membership window, which is what Campaign ->
    // Outlets renders; validating only outlets.collection_enabled let ops record a
    // collection at a branch the campaign had explicitly excluded.
    const d = getDraw.get(w.draw_id);
    const m = db.prepare(`select collection_enabled, active_from, active_to from campaign_outlets where campaign_id=? and outlet_id=?`).get(d.campaign_id, outletId);
    if (!m || !m.collection_enabled) throw Object.assign(new Error("outlet is not a prize collection point for this campaign"), { code: "VALIDATION" });
    const today = now().slice(0, 10);
    if (String(m.active_from || "1970-01-01").slice(0, 10) > today || String(m.active_to || "9999-12-31").slice(0, 10) < today) throw Object.assign(new Error("outlet is outside its collection window for this campaign"), { code: "VALIDATION" });
  }
  function transitionInTx(w, status, { actorId, note = null, reason = null, collectionOutletId = null, fulfilmentRef = null, evidence = null }) {
    const allowed = TRANSITIONS[w.status] || [];
    if (!allowed.includes(status)) throw Object.assign(new Error(`cannot move winner from ${w.status} to ${status}`), { code: "CONFLICT" });
    // An entry disqualified AFTER the draw (a forged receipt proven on Tuesday)
    // must not keep walking towards a prize: nothing here used to read the entry,
    // so the fraudulent winner could be notified, verified, accepted, collected
    // and published. Terminal moves (ineligible/replaced/expired/declined) stay
    // open — they are how such a winner is taken out.
    if (ADVANCING.includes(status)) {
      const e = getEntry.get(w.entry_id);
      if (e && e.status !== "active") throw Object.assign(new Error(`the winning entry is ${e.status}; the winner cannot be ${status}`), { code: "CONFLICT" });
    }
    const history = JSON.parse(w.history_json || "[]"); history.push({ from: w.status, to: status, at: now(), by: actorId, note, reason });
    const sets = { verified: "verified_at=?, verified_by=?", accepted: "accepted_at=?", collected: "fulfilled_at=?, fulfilled_by=?, fulfilment_ref=?" }[status];
    const base = `update winners set status=?, history_json=?, row_version=row_version+1, collection_outlet_id=coalesce(?, collection_outlet_id)`;
    const ts = now();
    let changed;
    if (status === "verified") changed = db.prepare(`${base}, verified_at=?, verified_by=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, actorId, w.id, w.row_version);
    else if (status === "accepted") changed = db.prepare(`${base}, accepted_at=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, w.id, w.row_version);
    else if (status === "collected") changed = db.prepare(`${base}, fulfilled_at=?, fulfilled_by=?, fulfilment_ref=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, actorId, fulfilmentRef, w.id, w.row_version);
    else changed = db.prepare(`${base}${["replaced", "ineligible", "expired", "declined"].includes(status) ? ", publication_state=case when publication_state='published' then 'withdrawn' else publication_state end" : ""} where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, w.id, w.row_version);
    // The row_version guard was inert: nobody looked at .changes, so a write
    // that matched NO row still wrote a claims row, an audit event and CRM
    // events. The expiry job, which reads its rows outside the transaction,
    // could therefore record "expired" for a prize that had just been collected.
    if (!changed.changes) throw Object.assign(new Error("winner changed since it was read; reload"), { code: "CONFLICT" });
    void sets;
    db.prepare(`insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`).run(id("clm"), w.id, status, JSON.stringify({ by: actorId, note, reason, collectionOutletId, fulfilmentRef, evidence }), ts);
    domain.audit({ actorType: "admin", actorId, action: `winner.${status}`, targetType: "winner", targetId: w.id, reason, payload: { from: w.status, collectionOutletId, fulfilmentRef, evidence } });
    const d = getDraw.get(w.draw_id);
    // Version the CRM events from the row as it now stands, not from the stale
    // copy: publish()/unpublish() also bump row_version, so w.row_version + 1
    // could collide with a version the CRM had already seen and be dropped.
    const after = getWinner.get(w.id);
    crm?.emit({ entityType: "claim", entityId: w.id, entityVersion: after.row_version, payload: { winnerId: w.id, state: status, collectionOutlet: domain.getOutlet(collectionOutletId || w.collection_outlet_id)?.outlet_code || null, fulfilledAt: status === "collected" ? ts : null } });
    crm?.emit({ entityType: "winner", entityId: w.id, entityVersion: after.row_version, payload: { participantId: w.participant_id, campaignCode: domain.getCampaign(d.campaign_id)?.code, period: d.period_code, prize: JSON.parse(w.published_fields_json || "{}").prize, rank: w.rank, status } });
    return { winner: after };
  }
  /** Promote the next unused alternate from the draw's stored output (audited; no new randomness). */
  function promoteAlternate(replaced, actorId, reason) {
    const d = getDraw.get(replaced.draw_id);
    const output = JSON.parse(d.output_json || "{}");
    const used = new Set(db.prepare(`select entry_id from winners where draw_id=?`).all(d.id).map((r) => r.entry_id));
    const usedP = new Set(db.prepare(`select participant_id from winners where draw_id=? and status not in ('replaced','ineligible','expired','declined')`).all(d.id).map((r) => r.participant_id));
    const skipped = [];
    const alt = (output.alternates || []).find((a) => {
      if (used.has(a.entryId)) return false;
      if (output.plan?.onePrizePerParticipant && usedP.has(a.participantId)) return false;
      // An alternate whose entry has since been disqualified must not be
      // promoted into a paid prize: pass over it, record why, and fall through
      // to the no-alternate alert when none is left.
      const e = getEntry.get(a.entryId);
      if (e && e.status !== "active") { skipped.push({ entryId: a.entryId, position: a.position, entryStatus: e.status }); return false; }
      return true;
    });
    if (skipped.length) domain.audit({ actorType: "admin", actorId, action: "winner.alternate_skipped", targetType: "winner", targetId: replaced.id, reason, payload: { skipped, drawId: d.id } });
    if (!alt) { domain.alert({ kind: "winners.no_alternate", severity: "warning", message: `no alternate left for draw ${d.id}${skipped.length ? ` (${skipped.length} skipped: entry not active)` : ""}`, detail: { drawId: d.id, replaced: replaced.id, skipped }, runbook: "docs/runbooks/winners-claims.md" }); return null; }
    const wid = id("win");
    // winners(draw_id, rank) is UNIQUE (v1 schema): the replacement takes the next free rank and keeps the
    // replaced winner's prize tier; the link is `replaces` in history + winners.replaced_by on the old row.
    const nextRank = (db.prepare(`select coalesce(max(rank), 0) as m from winners where draw_id=?`).get(d.id).m || 0) + 1;
    db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, notify_state, history_json, published_fields_json, publication_state, display_name, row_version)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(wid, d.id, nextRank, alt.entryId, alt.participantId, replaced.prize_code, "selected", JSON.stringify({ attempts: 0 }), JSON.stringify([{ from: "alternate", to: "selected", at: now(), by: actorId, reason, replaces: replaced.id }]), replaced.published_fields_json, "unpublished", (() => { const p = domain.getParticipant(alt.participantId); return p ? `${p.first_name} ${String(p.surname || "").slice(0, 1)}.` : null; })(), 1);
    db.prepare(`update winners set replaced_by=? where id=?`).run(wid, replaced.id);
    db.prepare(`insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`).run(id("clm"), wid, "selected", JSON.stringify({ by: actorId, replaces: replaced.id, reason }), now());
    domain.audit({ actorType: "admin", actorId, action: "winner.alternate_promoted", targetType: "winner", targetId: wid, reason, payload: { replaces: replaced.id, replacedRank: replaced.rank, rank: nextRank, entryId: alt.entryId, altPosition: alt.position } });
    // Emit the selection materialise() emits for every other winner: without it
    // the CRM showed the replaced winner and no successor, and first learned of
    // the real winner (if ever) at version 2 as 'notified', with no 'selected'.
    // The prize comes from the copied published_fields_json, which is what
    // transitionInTx will report next — anything else makes v1 and v2 disagree.
    crm?.emit({ entityType: "winner", entityId: wid, entityVersion: 1, payload: { participantId: alt.participantId, campaignCode: domain.getCampaign(d.campaign_id)?.code, period: d.period_code, prize: JSON.parse(replaced.published_fields_json || "{}").prize, rank: nextRank, status: "selected" } });
    return getWinner.get(wid);
  }
  /**
   * Claim token check for a participant reply (expiring; NOT single-use — the
   * hash is not cleared on a successful check and notify() rotates it on the
   * next contact attempt). No production path calls this yet: the documented
   * identity control at collection is Reveal ID plus the receipt trace.
   */
  function verifyClaimToken(winnerId, claimRef) {
    const w = getWinner.get(winnerId); if (!w?.claim_token_hash) return false;
    if (w.claim_expires_at && Date.parse(w.claim_expires_at) < Date.now()) return false;
    return crypto.timingSafeEqual(Buffer.from(w.claim_token_hash, "hex"), Buffer.from(hashToken(String(claimRef).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2")), "hex"));
  }
  /** Expire winners past their claim deadline (job); mutually consistent with fulfilment via row_version. */
  function expireDue() {
    const rows = db.prepare(`select id from winners where claim_expires_at < ? and status in ('notified','verified','accepted','unreachable')`).all(now());
    let n = 0, notContacted = 0, skipped = 0;
    for (const row of rows) {
      // The clock starts when the notification is ENQUEUED. If that send then
      // finished in a failure state (template paused, recipient not allowed,
      // campaign outbound blocked), the winner was never reached — expiring
      // them is irreversible ('expired' only moves to 'replaced'), so raise it
      // for re-notification instead of taking the prize away silently.
      const msg = lastNotifyMessage.get(`winner:${row.id}:notify:%`);
      if (msg && NOT_CONTACTED.includes(msg.status)) {
        notContacted++;
        domain.alert({ kind: "winners.not_contacted", severity: "critical", runbook: "docs/runbooks/winners-claims.md",
          message: `winner ${row.id} reached its claim deadline but the notification never left (${msg.status}${msg.error_code ? ` ${msg.error_code}` : ""}); not expired`,
          detail: { winnerId: row.id, outboundStatus: msg.status, attempts: msg.attempts, errorCode: msg.error_code, lastError: msg.last_error } });
        continue;
      }
      try {
        // Re-read INSIDE the transaction: the row was selected outside it, so a
        // fulfilment committed in between would otherwise be overwritten (or,
        // before the row_version guard was enforced, recorded as expired while
        // the winner stayed collected).
        const done = tx(db, () => {
          const w = getWinner.get(row.id);
          if (!w || !["notified", "verified", "accepted", "unreachable"].includes(w.status) || !(w.claim_expires_at && w.claim_expires_at < now())) return false;
          transitionInTx(w, "expired", { actorId: "system", reason: "claim deadline passed" });
          return true;
        });
        if (done) {
          n++;
          domain.alert({ kind: "winners.expired", severity: "warning", runbook: "docs/runbooks/winners-claims.md",
            message: `winner ${row.id} expired: claim deadline passed${msg ? ` (notification ${msg.status})` : ""}`, detail: { winnerId: row.id, outboundStatus: msg?.status || null } });
        } else skipped++;
      } catch { skipped++; /* concurrent fulfilment won */ }
    }
    return { expired: n, notContacted, skipped };
  }
  /** Publication is a separate permission from verification (§15). */
  function publish(winnerId, actorId) {
    const w = getWinner.get(winnerId); if (!w) throw Object.assign(new Error("winner not found"), { code: "NOT_FOUND" });
    const d = getDraw.get(w.draw_id);
    if (d.status !== "published") throw Object.assign(new Error("draw results are not published"), { code: "CONFLICT" });
    if (!["verified", "accepted", "collected"].includes(w.status)) throw Object.assign(new Error(`winner must be verified before publication (status=${w.status})`), { code: "CONFLICT" });
    // display_name is a frozen copy taken at materialise. Publishing it after the
    // participant withdrew or was erased would put a deleted person's name on the
    // unauthenticated public list for the first time, which no erasure can undo.
    const p = domain.getParticipant(w.participant_id);
    if (!p || p.status !== "active") throw Object.assign(new Error(`participant is ${p?.status || "missing"}; the winner cannot be published`), { code: "CONFLICT" });
    // A winner whose entry was disqualified must not be presented publicly as a winner.
    const e = getEntry.get(w.entry_id);
    if (e && e.status !== "active") throw Object.assign(new Error(`the winning entry is ${e.status}; the winner cannot be published`), { code: "CONFLICT" });
    db.prepare(`update winners set publication_state='published', row_version=row_version+1 where id=?`).run(winnerId);
    domain.audit({ actorType: "admin", actorId, action: "winner.published", targetType: "winner", targetId: winnerId });
    return getWinner.get(winnerId);
  }
  function unpublish(winnerId, actorId, reason) {
    db.prepare(`update winners set publication_state='withdrawn', row_version=row_version+1 where id=?`).run(winnerId);
    domain.audit({ actorType: "admin", actorId, action: "winner.unpublished", targetType: "winner", targetId: winnerId, reason });
    return getWinner.get(winnerId);
  }
  /** Safe public projection (server-side; never the participant entity). */
  function listPublic(campaignId = null, periodCode = null) {
    const rows = db.prepare(`select w.rank, w.display_name, w.published_fields_json, p.location, p.status as participant_status, coalesce(cp.code, d.draw_period) as period_code, d.campaign_id from winners w join draws d on d.id=w.draw_id left join campaign_periods cp on cp.id=d.period_id left join participants p on p.id=w.participant_id
      where d.status='published' and w.publication_state='published' ${campaignId ? "and d.campaign_id=?" : ""} ${periodCode ? "and coalesce(cp.code, d.draw_period)=?" : ""} order by period_code, w.rank limit 500`).all(...[campaignId, periodCode].filter(Boolean));
    // The name is served from a frozen copy on the winner row, which erasure and
    // withdrawal never visited: a deleted participant's name stayed on the
    // unauthenticated public list (and in the WhatsApp winners menu) for ever.
    // Derive it from the LIVE participant status; the rank and prize stay on the
    // list, because a published winner list is a promotional-compliance record.
    return rows.map((r) => ({ period: r.period_code, rank: r.rank, name: r.participant_status === "active" ? r.display_name : "[removed]", location: r.participant_status === "active" ? r.location || null : null, prize: JSON.parse(r.published_fields_json || "{}").prize || null }));
  }
  function publishedPeriods(campaignId) {
    return db.prepare(`select distinct coalesce(cp.code, d.draw_period) as code, coalesce(cp.label, d.draw_period) as label from winners w join draws d on d.id=w.draw_id left join campaign_periods cp on cp.id=d.period_id where d.status='published' and w.publication_state='published' and d.campaign_id=? order by code`).all(campaignId);
  }
  function listWinners({ campaignId = null, drawId = null, status = null, limit = 200 } = {}) {
    return db.prepare(`select w.*, coalesce(cp.code, d.draw_period) as draw_period, d.campaign_id, p.first_name, p.surname, p.wa_phone_uid from winners w join draws d on d.id=w.draw_id left join campaign_periods cp on cp.id=d.period_id left join participants p on p.id=w.participant_id
      where 1=1 ${campaignId ? "and d.campaign_id=?" : ""} ${drawId ? "and w.draw_id=?" : ""} ${status ? "and w.status=?" : ""} order by draw_period desc, w.rank limit ?`).all(...[campaignId, drawId, status].filter(Boolean), limit)
      .map((w) => ({ ...w, wa_phone_uid: domain.maskPhone(w.wa_phone_uid), claim_token_hash: undefined, history: JSON.parse(w.history_json || "[]"), published_fields: JSON.parse(w.published_fields_json || "{}") }));
  }
  return { materialise, notify, transition, promoteAlternate, verifyClaimToken, expireDue, publish, unpublish, listPublic, publishedPeriods, list: listWinners, get: (i) => getWinner.get(i), claims: (i) => db.prepare(`select * from claims where winner_id=? order by transitioned_at`).all(i), listByDraw: (i) => listByDraw.all(i) };
}
function hashToken(t) { return crypto.createHash("sha256").update(`claim:${t}`).digest("hex"); }
