import { id, nowIso } from "./db.mjs";

/**
 * Winner + claim lifecycle (DEF-03, REQ-20/21/22, G-14).
 * Materialised when a draw is published: one `winners` row per winner in the
 * draw's output, an initial `claims` row (awaiting_response), and an outbound
 * WhatsApp notification via the transactional outbox. Publishing again is an
 * idempotent no-op. Every claim transition appends a new `claims` row and
 * updates `winners.history_json`.
 */
export function createWinnerService(db, { outbox, now = nowIso } = {}) {
  const insertWinner = db.prepare(
    `insert or ignore into winners (id, draw_id, rank, entry_id, participant_id, prize_code, status, notify_state, history_json, published_fields_json)
     values (?,?,?,?,?,?,?,?,?,?)`);
  const insertClaim = db.prepare(
    `insert into claims (id, winner_id, state, detail_json, transitioned_at) values (?,?,?,?,?)`);
  const getDraw = db.prepare(`select * from draws where id = ?`);
  const getWinner = db.prepare(`select * from winners where id = ?`);
  const listWinners = db.prepare(`select * from winners`);
  const listByDraw = db.prepare(`select * from winners where draw_id = ? order by rank`);
  const listClaims = db.prepare(`select * from claims where winner_id = ? order by transitioned_at`);
  const setWinnerStatus = db.prepare(`update winners set status=?, history_json=?, notify_state=? where id=?`);

  /** Materialise winners for a published/approved draw. Idempotent. */
  function materialise(drawId, { force = false } = {}) {
    const d = getDraw.get(drawId);
    if (!d) throw new Error("draw not found");
    const existing = listByDraw.all(drawId);
    if (existing.length && !force) return { winners: existing, created: 0, idempotent: true };

    let output;
    try { output = JSON.parse(d.output_json || "{}"); } catch { output = {}; }
    // P0-07: only the resolved winners (respecting per_week prize counts) are
    // materialised — never every entry. Alternates stay in output.alternates.
    const wins = output.winners || [];
    const created = [];
    wins.forEach((w, i) => {
      const entryId = w.entryId ?? w.entry_id;
      const rank = i + 1;
      const wid = id("win");
      const entry = db.prepare(`select * from entries where id=?`).get(entryId);
      const phone = entry?.participant_id ? db.prepare(`select wa_phone_uid from participants where id=?`).get(entry.participant_id)?.wa_phone_uid || "" : "";
      insertWinner.run(
        wid, drawId, rank, entryId, entry?.participant_id || null, w.prize_code || "P1", "pending",
        JSON.stringify({ attempts: 0, notified: false }), "[]", JSON.stringify({ draw_period: d.draw_period }),
      );
      insertClaim.run(id("clm"), wid, "awaiting_response", JSON.stringify({ created_by: "draw_publish" }), now());
      if (outbox && phone) {
        outbox.enqueueWhatsApp({
          waPhoneUid: phone,
          kind: "text",
          payload: `🎉 Congratulations! You're a winner in the ${d.draw_period} draw (prize ${w.prize_code || "P1"}). Reply to claim your prize.`,
          idempotencyKey: `winner:${wid}:notify`,
        });
      }
      created.push(getWinner.get(wid));
    });
    return { winners: created, created: created.length, idempotent: false };
  }

  /** Transition a winner through the claim lifecycle. */
  function transition(winnerId, { status, note, reason, actorId }) {
    const w = getWinner.get(winnerId);
    if (!w) throw new Error("winner not found");
    const ALLOWED = ["notified", "verified", "accepted", "collected", "expired", "rejected", "replaced"];
    if (!ALLOWED.includes(status)) throw new Error(`invalid winner status "${status}"`);
    const history = JSON.parse(w.history_json || "[]");
    history.push({ from: w.status, to: status, at: now(), by: actorId || "admin", note: note || null, reason: reason || null });
    setWinnerStatus.run(status, JSON.stringify(history), w.notify_state, winnerId);
    insertClaim.run(id("clm"), winnerId, status, JSON.stringify({ note, reason, actor: actorId }), now());
    // replacement: if replaced, materialise the next non-winner alternate
    if (status === "replaced") {
      const d = getDraw.get(w.draw_id);
      let output = {};
      try { output = JSON.parse(d?.output_json || "{}"); } catch { /* ignore */ }
      const altCandidates = output.alternates || [];
      const alreadyWinner = new Set(db.prepare(`select entry_id from winners where draw_id=?`).all(w.draw_id).map((r) => r.entry_id));
      const alt = altCandidates.map((a) => a.entryId ?? a.entry_id).find((id) => !alreadyWinner.has(id));
      if (alt) {
        const { winners } = materialiseAsAlternate(d, alt, w);
        return { winner: getWinner.get(winnerId), replacement: winners[0] };
      }
    }
    return { winner: getWinner.get(winnerId), replacement: null };
  }

  function materialiseAsAlternate(d, entryId, original) {
    let output = {};
    try { output = JSON.parse(d.output_json || "{}"); } catch { /* ignore */ }
    const existing = db.prepare(`select * from winners where entry_id=? and draw_id=?`).get(entryId, d.id);
    if (existing) return { winners: [existing] };
    const wid = id("win");
    const entry = db.prepare(`select * from entries where id=?`).get(entryId);
    const rank = (output.sequence || []).indexOf(entryId) + 1;
    insertWinner.run(wid, d.id, rank, entryId, entry?.participant_id || null, "P1", "pending",
      JSON.stringify({ attempts: 0, notified: false }), JSON.stringify([{ from: "alternate", to: "pending", at: now(), note: `replacement for ${original.id}` }]),
      JSON.stringify({ draw_period: d.draw_period }));
    insertClaim.run(id("clm"), wid, "awaiting_response", JSON.stringify({ note: "alternate to replaced winner" }), now());
    return { winners: [getWinner.get(wid)] };
  }

  return {
    materialise,
    transition,
    get: (id) => getWinner.get(id),
    list: listWinners.all.bind(listWinners),
    listByDraw: (drawId) => listByDraw.all(drawId),
    claims: (winnerId) => listClaims.all(winnerId),
    /** Public winners view (REQ-20): published draws, disclosure fields only. */
    listPublic() {
      const rows = db.prepare(
        `select w.id, w.draw_id, w.rank, w.prize_code, d.draw_period,
                pk.first_name, pk.surname, pk.location, pk.wa_phone_uid
         from winners w
         join draws d on d.id = w.draw_id
         left join participants pk on pk.id = w.participant_id
         where d.status='published' and w.status in ('notified','verified','accepted','collected')
         order by d.draw_period, w.rank limit 500`).all();
      return rows.map((r) => ({
        draw_period: r.draw_period,
        rank: r.rank,
        prize_code: r.prize_code,
        // disclosure fields only — no full phone / national identity
        winner: r.wa_phone_uid ? `***${String(r.wa_phone_uid).slice(-4)}` : null,
        name: r.first_name ? `${r.first_name} ${String(r.surname || "").slice(0, 1)}.` : null,
        location: r.location || null,
      }));
    },
  };
}