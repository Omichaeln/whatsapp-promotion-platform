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

export function createWinnerService(db, { outbox, domain, crm = null, now = nowIso, claimDays = 7 } = {}) {
  const getWinner = db.prepare(`select * from winners where id = ?`);
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
        domain.audit({ actorType: "admin", actorId, action: "winner.selected", targetType: "winner", targetId: wid, payload: { drawId, entryId: w.entryId, prize: w.prize_code } });
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
      if (status === "collected") {
        if (!collectionOutletId && !w.collection_outlet_id) throw Object.assign(new Error("collection outlet required"), { code: "VALIDATION" });
        const o = domain.getOutlet(collectionOutletId || w.collection_outlet_id);
        if (!o || !o.collection_enabled) throw Object.assign(new Error("outlet cannot distribute prizes"), { code: "VALIDATION" });
        if (w.fulfilled_at) throw Object.assign(new Error("already fulfilled"), { code: "CONFLICT" });
      }
      const out = transitionInTx(w, status, { actorId, note, reason, collectionOutletId, fulfilmentRef, evidence });
      if (status === "replaced") return { ...out, replacement: promoteAlternate(w, actorId, reason || "replaced") };
      return out;
    });
  }
  function transitionInTx(w, status, { actorId, note = null, reason = null, collectionOutletId = null, fulfilmentRef = null, evidence = null }) {
    const allowed = TRANSITIONS[w.status] || [];
    if (!allowed.includes(status)) throw Object.assign(new Error(`cannot move winner from ${w.status} to ${status}`), { code: "CONFLICT" });
    const history = JSON.parse(w.history_json || "[]"); history.push({ from: w.status, to: status, at: now(), by: actorId, note, reason });
    const sets = { verified: "verified_at=?, verified_by=?", accepted: "accepted_at=?", collected: "fulfilled_at=?, fulfilled_by=?, fulfilment_ref=?" }[status];
    const base = `update winners set status=?, history_json=?, row_version=row_version+1, collection_outlet_id=coalesce(?, collection_outlet_id)`;
    const ts = now();
    if (status === "verified") db.prepare(`${base}, verified_at=?, verified_by=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, actorId, w.id, w.row_version);
    else if (status === "accepted") db.prepare(`${base}, accepted_at=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, w.id, w.row_version);
    else if (status === "collected") db.prepare(`${base}, fulfilled_at=?, fulfilled_by=?, fulfilment_ref=? where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, ts, actorId, fulfilmentRef, w.id, w.row_version);
    else db.prepare(`${base}${["replaced", "ineligible", "expired", "declined"].includes(status) ? ", publication_state=case when publication_state='published' then 'withdrawn' else publication_state end" : ""} where id=? and row_version=?`).run(status, JSON.stringify(history), collectionOutletId, w.id, w.row_version);
    void sets;
    db.prepare(`insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`).run(id("clm"), w.id, status, JSON.stringify({ by: actorId, note, reason, collectionOutletId, fulfilmentRef, evidence }), ts);
    domain.audit({ actorType: "admin", actorId, action: `winner.${status}`, targetType: "winner", targetId: w.id, reason, payload: { from: w.status, collectionOutletId, fulfilmentRef, evidence } });
    const d = getDraw.get(w.draw_id);
    crm?.emit({ entityType: "claim", entityId: w.id, entityVersion: w.row_version + 1, payload: { winnerId: w.id, state: status, collectionOutlet: domain.getOutlet(collectionOutletId || w.collection_outlet_id)?.outlet_code || null, fulfilledAt: status === "collected" ? ts : null } });
    crm?.emit({ entityType: "winner", entityId: w.id, entityVersion: w.row_version + 1, payload: { participantId: w.participant_id, campaignCode: domain.getCampaign(d.campaign_id)?.code, period: d.period_code, prize: JSON.parse(w.published_fields_json || "{}").prize, rank: w.rank, status } });
    if (status === "collected" && w.collection_outlet_id || collectionOutletId) { /* collection instructions sent on accepted */ }
    return { winner: getWinner.get(w.id) };
  }
  /** Promote the next unused alternate from the draw's stored output (audited; no new randomness). */
  function promoteAlternate(replaced, actorId, reason) {
    const d = getDraw.get(replaced.draw_id);
    const output = JSON.parse(d.output_json || "{}");
    const used = new Set(db.prepare(`select entry_id from winners where draw_id=?`).all(d.id).map((r) => r.entry_id));
    const usedP = new Set(db.prepare(`select participant_id from winners where draw_id=? and status not in ('replaced','ineligible','expired','declined')`).all(d.id).map((r) => r.participant_id));
    const alt = (output.alternates || []).find((a) => !used.has(a.entryId) && !(output.plan?.onePrizePerParticipant && usedP.has(a.participantId)));
    if (!alt) { domain.alert({ kind: "winners.no_alternate", severity: "warning", message: `no alternate left for draw ${d.id}`, runbook: "docs/runbooks/winners-claims.md" }); return null; }
    const wid = id("win");
    // winners(draw_id, rank) is UNIQUE (v1 schema): the replacement takes the next free rank and keeps the
    // replaced winner's prize tier; the link is `replaces` in history + winners.replaced_by on the old row.
    const nextRank = (db.prepare(`select coalesce(max(rank), 0) as m from winners where draw_id=?`).get(d.id).m || 0) + 1;
    db.prepare(`insert into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, notify_state, history_json, published_fields_json, publication_state, display_name, row_version)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(wid, d.id, nextRank, alt.entryId, alt.participantId, replaced.prize_code, "selected", JSON.stringify({ attempts: 0 }), JSON.stringify([{ from: "alternate", to: "selected", at: now(), by: actorId, reason, replaces: replaced.id }]), replaced.published_fields_json, "unpublished", (() => { const p = domain.getParticipant(alt.participantId); return p ? `${p.first_name} ${String(p.surname || "").slice(0, 1)}.` : null; })(), 1);
    db.prepare(`update winners set replaced_by=? where id=?`).run(wid, replaced.id);
    db.prepare(`insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`).run(id("clm"), wid, "selected", JSON.stringify({ by: actorId, replaces: replaced.id, reason }), now());
    domain.audit({ actorType: "admin", actorId, action: "winner.alternate_promoted", targetType: "winner", targetId: wid, reason, payload: { replaces: replaced.id, replacedRank: replaced.rank, rank: nextRank, entryId: alt.entryId, altPosition: alt.position } });
    return getWinner.get(wid);
  }
  /** Claim token check for a participant reply (single-use, expiring). */
  function verifyClaimToken(winnerId, claimRef) {
    const w = getWinner.get(winnerId); if (!w?.claim_token_hash) return false;
    if (w.claim_expires_at && Date.parse(w.claim_expires_at) < Date.now()) return false;
    return crypto.timingSafeEqual(Buffer.from(w.claim_token_hash, "hex"), Buffer.from(hashToken(String(claimRef).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2")), "hex"));
  }
  /** Expire winners past their claim deadline (job); mutually consistent with fulfilment via row_version. */
  function expireDue() {
    const rows = db.prepare(`select * from winners where claim_expires_at < ? and status in ('notified','verified','accepted','unreachable')`).all(now());
    let n = 0;
    for (const w of rows) { try { tx(db, () => transitionInTx(w, "expired", { actorId: "system", reason: "claim deadline passed" })); n++; } catch { /* concurrent fulfilment won */ } }
    return { expired: n };
  }
  /** Publication is a separate permission from verification (§15). */
  function publish(winnerId, actorId) {
    const w = getWinner.get(winnerId); if (!w) throw Object.assign(new Error("winner not found"), { code: "NOT_FOUND" });
    const d = getDraw.get(w.draw_id);
    if (d.status !== "published") throw Object.assign(new Error("draw results are not published"), { code: "CONFLICT" });
    if (!["verified", "accepted", "collected"].includes(w.status)) throw Object.assign(new Error(`winner must be verified before publication (status=${w.status})`), { code: "CONFLICT" });
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
    const rows = db.prepare(`select w.rank, w.display_name, w.published_fields_json, p.location, coalesce(cp.code, d.draw_period) as period_code, d.campaign_id from winners w join draws d on d.id=w.draw_id left join campaign_periods cp on cp.id=d.period_id left join participants p on p.id=w.participant_id
      where d.status='published' and w.publication_state='published' ${campaignId ? "and d.campaign_id=?" : ""} ${periodCode ? "and coalesce(cp.code, d.draw_period)=?" : ""} order by period_code, w.rank limit 500`).all(...[campaignId, periodCode].filter(Boolean));
    return rows.map((r) => ({ period: r.period_code, rank: r.rank, name: r.display_name, location: r.location || null, prize: JSON.parse(r.published_fields_json || "{}").prize || null }));
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
