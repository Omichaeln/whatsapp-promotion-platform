import { id, tx, nowIso } from "./db.mjs";
import { evaluateEligibility, DISPOSITION, REASONS } from "./eligibility.mjs";
import { canonicalKeyOf, normaliseReceiptNo } from "./duplicates.mjs";
import { renderCopy, reasonLabel, shortRef } from "./copy.mjs";

/**
 * Receipt pipeline (spec §10, §11).
 *   submit()   durable intake: validate + store media privately, create the
 *              submission row (status received) — fast, inside the inbound job.
 *   process()  extraction (real OCR) -> deterministic rules -> canonical
 *              receipt claim -> ATOMIC commit {decision, entry, audit, outbox, CRM}.
 *   review()   reviewer decisions through the SAME integrity path, with an
 *              optimistic version check (stale reviewers reload, never double-credit).
 * Invariants: one credited canonical receipt per campaign (UNIQUE), one active
 * entry per canonical receipt (UNIQUE), a transient extractor failure never
 * becomes a rejection (status delayed + retry), a reviewer cannot bypass the
 * unique award.
 */
export const RECEIPT_STATUS = { RECEIVED: "received", PROCESSING: "processing", DELAYED: "delayed", ...DISPOSITION };
const TERMINAL = new Set(["QUALIFIED", "NOT_QUALIFIED", "DUPLICATE", "REVIEW_REQUIRED", "REUPLOAD_REQUIRED"]);
const REVIEW_SLA_HOURS = 24;

export function createReceiptPipeline({ db, mediaStore, extractor, duplicates, outbox, domain, crm = null, log = console, now = nowIso }) {
  const getReceipt = db.prepare(`select * from receipts where id = ?`);
  const insertReceipt = db.prepare(`insert into receipts (id, provider_message_id, participant_id, campaign_id, campaign_version_id, media_asset_id, selected_outlet_id, status, created_at, intake_at, event_at, period_code, reupload_of, channel_event_id, correlation_id, quality_json)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertValidation = db.prepare(`insert into validation_results (id, receipt_id, attempt_no, extractor_provider, extractor_version, facts_json, confidence, rule_results_json, risk_signals_json, decision, error, created_at, ocr_text, raw_result_json, schema_version, latency_ms)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItem = db.prepare(`insert into receipt_items (id, receipt_id, description, sku, quantity, unit_weight_kg, amount, evidence_json) values (?,?,?,?,?,?,?,?)`);
  const insertEntry = db.prepare(`insert into entries (id, receipt_id, participant_id, campaign_id, campaign_version_id, draw_period, entry_no, status, created_at, period_code, weight_units, canonical_receipt_id) values (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertCandidate = db.prepare(`insert or ignore into duplicate_candidates (id, receipt_id, candidate_receipt_id, kind, score, resolution, created_at) values (?,?,?,?,?,?,?)`);
  // A receipt can RE-ENTER review: reprocess() decides the open task, and the
  // re-run of a deterministic pipeline on the same image decides REVIEW again.
  // review_tasks.receipt_id is UNIQUE, so `insert or ignore` silently did
  // nothing: the receipt sat in REVIEW_REQUIRED behind a task marked 'decided'
  // — invisible in the queue, refused by review() as "already decided", with no
  // route back through any API. The upsert reopens a decided task instead.
  // An open or assigned task is left alone (only row_version moves) so a re-run
  // can neither steal it from its reviewer nor extend its SLA deadline.
  const insertReview = db.prepare(`insert into review_tasks (id, receipt_id, state, sla_due_at, created_at) values (?,?,?,?,?)
    on conflict(receipt_id) do update set
      state=case when review_tasks.state='decided' then 'open' else review_tasks.state end,
      assignee=case when review_tasks.state='decided' then null else review_tasks.assignee end,
      assigned_at=case when review_tasks.state='decided' then null else review_tasks.assigned_at end,
      escalated=case when review_tasks.state='decided' then 0 else review_tasks.escalated end,
      sla_due_at=case when review_tasks.state='decided' then excluded.sla_due_at else review_tasks.sla_due_at end,
      decision=null, reason_code=null, note=null, decided_by=null, decided_at=null,
      row_version=review_tasks.row_version+1`);
  const attemptsFor = db.prepare(`select count(*) n from validation_results where receipt_id=?`);
  // Draws already frozen for a period: their candidate snapshot is immutable,
  // so an entry awarded into that period afterwards can never enter any draw.
  const closedDrawsForPeriod = db.prepare(`select d.id, d.status from draws d left join campaign_periods cp on cp.id = d.period_id
    where d.campaign_id = ? and coalesce(cp.code, d.draw_period) = ? and d.status in ('frozen','executing','executed','approved','published')`);
  const periodAlreadyDrawn = (r) => (r.period_code ? closedDrawsForPeriod.all(r.campaign_id, r.period_code) : []);
  // The CRM versions an entry by the number of decisions taken on it: the award
  // is 1 and every entry_event after it is the next version. disqualifyEntry
  // used a literal 2, so disqualify -> reinstate -> disqualify re-emitted
  // version 2 with a byte-identical payload; crm.emit's INSERT OR IGNORE drops
  // it and the collision alarm cannot fire on an identical payload, leaving the
  // CRM permanently out of step with the ledger. Count the events instead.
  const entryVersion = (entryId) => db.prepare(`select count(*) n from entry_events where entry_id=?`).get(entryId).n + 1;

  const content = (campaignId) => domain.versionContent(campaignId);
  // The decision is judged with the version PINNED to the receipt, so the
  // message about that decision has to be rendered from the same version. Both
  // helpers resolved the currently ACTIVE version, so a receipt submitted under
  // v1 and reviewed after v2 was activated was answered in v2's wording, with
  // v2's reason labels and v2's participant_status flag — copy the participant
  // never saw. Fall back to the active version only when the pin is unusable.
  const versionJson = (r, field, fallback) => {
    const v = r?.campaign_version_id ? domain.getVersion(r.campaign_version_id) : null;
    try { return v ? JSON.parse(v[field] || "{}") : fallback(); } catch { return fallback(); }
  };
  const pinnedContent = (r) => versionJson(r, "content_json", () => content(r.campaign_id));
  const pinnedFlags = (r) => versionJson(r, "flags_json", () => domain.versionFlags(r.campaign_id));
  const ruleVars = (rules) => ({ min_packs: rules.primary_rule?.min_packs, pack_label: `${(rules.primary_rule?.pack_grams || 0) / 1000}kg pack`, product: rules.products?.[0]?.name || "the qualifying product" });

  // ---------------------------------------------------------------------------
  async function submit({ campaignId, participantId, phoneUid, selectedOutletId, providerMessageId, channelEventId = null, imageBytes, correlationId = null, eventAt = null, reuploadOf = null }) {
    const version = domain.getActiveVersion(campaignId);
    if (!version) throw Object.assign(new Error("no active campaign version"), { code: "NO_VERSION" });
    const media = await mediaStore.store({ bytes: imageBytes, campaignId });   // throws BAD_TYPE/TOO_LARGE/TOO_SMALL
    const intakeAt = now();
    const period = domain.periodAt(campaignId, intakeAt);
    const rid = id("rcpt");
    try {
      insertReceipt.run(rid, providerMessageId, participantId, campaignId, version.id, media.assetId, selectedOutletId, RECEIPT_STATUS.RECEIVED, intakeAt, intakeAt, eventAt || intakeAt, period?.code || null, reuploadOf, channelEventId, correlationId, JSON.stringify(media.quality || null));
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) { const ex = db.prepare(`select * from receipts where provider_message_id=?`).get(providerMessageId); if (ex) return { receipt: ex, receiptId: ex.id, reference: shortRef(ex.id), replay: true }; }
      throw e;
    }
    domain.audit({ actorType: "participant", actorId: participantId, action: "receipt.submitted", targetType: "receipt", targetId: rid, correlationId, payload: { mediaAssetId: media.assetId, selectedOutletId, periodCode: period?.code || null, existingMedia: media.existing } });
    domain.metric("receipt.submitted", 1, { campaignId });
    db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at, correlation_id) values (?,?,?,?,?,?,?)`).run(id("job"), "receipt.process", JSON.stringify({ receiptId: rid }), "pending", now(), now(), correlationId);
    return { receipt: getReceipt.get(rid), receiptId: rid, reference: shortRef(rid), media };
  }

  // ---------------------------------------------------------------------------
  async function process(receiptId, { correlationId = null } = {}) {
    const r = getReceipt.get(receiptId);
    if (!r) throw new Error("receipt not found");
    if (TERMINAL.has(r.status)) return { receiptId, decision: r.status, alreadyDecided: true };
    const claimed = db.prepare(`update receipts set status=? , row_version=row_version+1 where id=? and status in ('received','delayed','processing')`).run(RECEIPT_STATUS.PROCESSING, receiptId);
    if (!claimed.changes) return { receiptId, decision: getReceipt.get(receiptId).status, alreadyDecided: true };
    const campaign = domain.getCampaign(r.campaign_id);
    const version = domain.getVersion(r.campaign_version_id);
    const rules = JSON.parse(version.rules_json || "{}");
    const asset = mediaStore.get(r.media_asset_id);
    const quality = asset?.quality_json ? JSON.parse(asset.quality_json) : {};
    const bytes = mediaStore.readBytes(asset);
    const normalised = mediaStore.readBytes(asset, { normalised: true });
    if (!bytes) { return delay(receiptId, "media_unavailable", r); }
    const outlets = domain.listCampaignOutlets(r.campaign_id);
    const attemptNo = attemptsFor.get(receiptId).n + 1;

    // 1. extraction (real OCR); transient failures -> delayed + retry, never a rejection
    let x;
    try { x = await extractor.extract({ imageBytes: bytes, normalisedBytes: normalised, context: { outlets, dateOrder: rules.date_order || "DMY", quality } }); }
    catch (e) {
      log.error?.("[pipeline] extractor failed", receiptId, e.code || e.message);
      domain.alert({ kind: "receipt.extractor", severity: "critical", message: `extractor failure: ${e.message}`, runbook: "docs/runbooks/media-and-extraction.md" });
      return delay(receiptId, e.code || "extractor_failed", r, e.transient !== false);
    }

    // 2. deterministic rules
    const selectedOutlet = r.selected_outlet_id ? domain.getOutlet(r.selected_outlet_id) : null;
    const member = outlets.find((o) => o.id === r.selected_outlet_id);
    const period = r.period_code ? domain.getPeriodByCode(r.campaign_id, r.period_code) : null;
    const pause = domain.getPauseFlags(r.campaign_id);
    const enrollment = domain.getEnrollment(r.participant_id, r.campaign_id);
    const participant = domain.getParticipant(r.participant_id);
    // FR-13/FR-22: whether the promotion was open is a fact about INTAKE time,
    // but the campaign row is read here, at PROCESSING time. Pausing or closing
    // the campaign (a first-class operator control) while a receipt sat in the
    // queue therefore retro-rejected an on-time submission as "the promotion
    // was not open at the time" — a false reason, and terminal.
    const intakeMs = Date.parse(r.intake_at);
    const openAtIntake = !["draft", "archived"].includes(campaign.status)
      && (!campaign.start_at || intakeMs >= Date.parse(campaign.start_at))
      && (!campaign.end_at || intakeMs < Date.parse(campaign.end_at));
    const ctx = {
      intakeAt: r.intake_at, campaignOpen: !!period && openAtIntake,
      windowStart: rules.purchase_window?.start || campaign.start_at, windowEnd: rules.purchase_window?.end || campaign.end_at,
      selectedOutletId: r.selected_outlet_id, selectedOutletParticipating: !!(selectedOutlet && (outlets.length === 0 || member)),
      enrolled: !!enrollment && !enrollment.withdrawn_at, participantBlocked: participant?.status !== "active",
      periodEntryCount: domain.countPeriodEntries(r.participant_id, r.campaign_id, r.period_code), imageQuality: quality,
    };
    const v = evaluateEligibility(x, rules, ctx);
    let disposition = v.disposition, reason = v.reason;
    if (pause.auto_qualify && disposition === DISPOSITION.QUALIFIED) { disposition = DISPOSITION.REVIEW; reason = "auto_qualification_paused"; }

    // 3. duplicate evidence (candidates recorded; canonical claim decides)
    const key = canonicalKeyOf({ outletId: r.selected_outlet_id, date: x.transaction.date, receiptNo: x.transaction.receiptNo, totalMinor: x.transaction.totalMinor });
    const exact = duplicates.exactImageMatches({ sha256: asset.sha256, campaignId: r.campaign_id, excludeReceiptId: receiptId });
    const visual = duplicates.visualCandidates({ phash: asset.phash, dhash: asset.dhash, campaignId: r.campaign_id, excludeReceiptId: receiptId });

    // 4. ATOMIC commit
    const out = tx(db, () => {
      for (const c of exact) insertCandidate.run(id("dup"), receiptId, c.receiptId, c.kind, c.score, "open", now());
      for (const c of visual) insertCandidate.run(id("dup"), receiptId, c.receiptId, c.kind, c.score, "open", now());
      // Resolve on the STABLE identity (outlet + date + number), not on the key
      // alone: the key embeds the total, so one unreadable or misread TOTAL on
      // one of two photographs of the same slip used to mint a second canonical
      // row and credit the same purchase twice.
      let canonical = duplicates.claim(r.campaign_id, { outletId: r.selected_outlet_id, date: x.transaction.date, receiptNo: x.transaction.receiptNo, totalMinor: x.transaction.totalMinor });
      let dupOf = null;
      if (canonical && canonical.first_receipt_id !== receiptId) {
        const firstR = getReceipt.get(canonical.first_receipt_id);
        if (canonical.status === "credited") dupOf = canonical.credited_receipt_id || canonical.first_receipt_id;
        // the same purchase presented by a different participant: never auto-credit the second presenter.
        // If the first presentation is still undecided, or the second would qualify, a reviewer decides ownership.
        else if (firstR && firstR.participant_id !== r.participant_id && (["REVIEW_REQUIRED", "received", "processing", "delayed"].includes(firstR.status) || disposition === DISPOSITION.QUALIFIED)) { disposition = DISPOSITION.REVIEW; reason = "ownership_dispute"; }
        // same participant, not credited: treated as a re-upload of their own earlier attempt
        else if (firstR && firstR.participant_id === r.participant_id && !r.reupload_of) db.prepare(`update receipts set reupload_of=? where id=?`).run(firstR.id, receiptId);
      }
      if (exact.length && !dupOf) {
        const credited = exact.map((c) => getReceipt.get(c.receiptId)).find((rr) => rr?.status === "QUALIFIED");
        if (credited) dupOf = credited.id;
      }
      // One physical receipt, two outlet SELECTIONS. The canonical key embeds
      // the outlet the participant chose, so choosing another branch mints a
      // second identity for the same purchase and credits it twice. The printed
      // identity (date + number + total) belongs to the receipt, so check it
      // independently of the selection. Route to review rather than rejecting:
      // two different shops can legitimately print the same number on the same
      // day for the same total, and a person should decide which is which.
      if (!canonical && !dupOf && key) {
        const others = duplicates.crossOutletClaims({ campaignId: r.campaign_id, date: x.transaction.date, receiptNo: x.transaction.receiptNo, totalMinor: x.transaction.totalMinor, outletId: r.selected_outlet_id });
        if (others.length) {
          disposition = DISPOSITION.REVIEW; reason = "possible_duplicate_other_outlet";
          for (const o of others) insertCandidate.run(id("dup"), receiptId, o.credited_receipt_id || o.first_receipt_id, "printed_identity", 0.9, "open", now());
        }
      }

      // Visual-hash candidates are recorded for reviewers (search signal only).
      // Receipts from one till look alike at 8x8, so they never decide on their
      // own: the deterministic identity (outlet|date|number|total) does.
      if (dupOf) { disposition = DISPOSITION.DUPLICATE; reason = "duplicate_receipt"; insertCandidate.run(id("dup"), receiptId, dupOf, "canonical", 1, "same_purchase", now()); }

      // The period's draw is already frozen: its candidate snapshot is fixed,
      // so an entry awarded now would sit in NO draw for the life of the
      // campaign while the participant is told "ONE entry has been added to the
      // draw". A person decides (void + rerun, or a goodwill outcome) instead.
      // Checked before the canonical claim below so the claim is not recorded
      // as 'credited' for an award that is not made.
      if (disposition === DISPOSITION.QUALIFIED && periodAlreadyDrawn(r).length) { disposition = DISPOSITION.REVIEW; reason = "period_already_drawn"; }

      // canonical claim (UNIQUE guarded; a concurrent loser becomes DUPLICATE)
      let canonicalId = canonical?.id || null;
      if (key && !canonical && disposition !== DISPOSITION.DUPLICATE) {
        canonicalId = id("can");
        try {
          db.prepare(`insert into canonical_receipts (id, campaign_id, canonical_key, outlet_id, txn_date, receipt_no, receipt_no_norm, total_minor, currency, first_receipt_id, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(canonicalId, r.campaign_id, key, r.selected_outlet_id, x.transaction.date, x.transaction.receiptNo, normaliseReceiptNo(x.transaction.receiptNo), x.transaction.totalMinor, x.transaction.currency, receiptId, disposition === DISPOSITION.QUALIFIED ? "credited" : "pending", now());
        } catch (e) {
          if (!String(e.message).includes("UNIQUE")) throw e;
          const winner = duplicates.canonical(r.campaign_id, key);
          canonicalId = winner.id;
          if (winner.status === "credited" || winner.first_receipt_id !== receiptId) { disposition = DISPOSITION.DUPLICATE; reason = "duplicate_receipt"; insertCandidate.run(id("dup"), receiptId, winner.first_receipt_id, "canonical", 1, "same_purchase", now()); }
        }
      }
      return commit({ r, receiptId, version, x, v, disposition, reason, canonicalId, key, attemptNo, correlationId, rules, decidedBy: "system" });
    });
    domain.metric("receipt.decided", 1, { disposition: out.decision, campaignId: r.campaign_id });
    return out;
  }

  function delay(receiptId, why, r, transient = true) {
    // The receipt always parks as 'delayed' — a platform-side extraction fault
    // is never the participant's fault and must stay reprocessable — but a
    // failure the caller marked permanent (a provider rejecting our
    // credentials) cannot succeed on a retry. Re-queueing it burned an hour of
    // provider calls and worker slots and, worse, delayed the alert that is the
    // only thing that can fix it. The `transient` flag used to be dead (both
    // arms of a ternary were 'delayed'); now it decides retry vs alert.
    db.prepare(`update receipts set status=?, reason_code=?, row_version=row_version+1 where id=?`).run(RECEIPT_STATUS.DELAYED, why, receiptId);
    domain.audit({ actorType: "system", actorId: "pipeline", action: "receipt.delayed", targetType: "receipt", targetId: receiptId, reason: why });
    const phone = domain.getParticipant(r.participant_id)?.wa_phone_uid;
    if (phone) outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "receipt_outcome", campaignId: r.campaign_id, payload: renderCopy(pinnedContent(r), "delayed", { reference: shortRef(receiptId) }), idempotencyKey: `receipt:${receiptId}:delayed` });
    // retry job with backoff (bounded: 6 attempts ~ 1h). Attempts are the
    // receipt.process jobs queued for THIS receipt — one monotonic count.
    // Adding the validation_results count meant a receipt that had already been
    // extracted once entered the ladder a step early and exhausted its budget
    // before the schedule intended.
    const attempts = Number(db.prepare(`select count(*) n from jobs where kind='receipt.process' and payload_json=?`).get(JSON.stringify({ receiptId })).n);
    if (transient && attempts < 6) db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) values (?,?,?,?,?,?)`).run(id("job"), "receipt.process", JSON.stringify({ receiptId }), "pending", new Date(Date.now() + Math.min(2 ** attempts, 20) * 60_000).toISOString(), now());
    else domain.alert({ kind: "receipt.stuck", severity: "critical", message: transient ? `receipt ${receiptId} delayed after ${attempts} attempts` : `receipt ${receiptId} delayed: ${why} is not retryable — extraction needs an operator fix`, runbook: "docs/runbooks/media-and-extraction.md" });
    return { receiptId, decision: RECEIPT_STATUS.DELAYED, reason: why };
  }

  /** Shared integrity path for automatic and reviewer decisions (inside a tx). */
  function commit({ r, receiptId, version, x, v, disposition, reason, canonicalId, key, attemptNo, correlationId, rules, decidedBy, note = null }) {
    const isReview = decidedBy !== "system";
    if (x) {
      insertValidation.run(id("val"), receiptId, attemptNo, x.provider, `${x.model}|${x.promptVersion || ""}`, JSON.stringify({ document: x.document, merchant: x.merchant, transaction: x.transaction, lineItems: x.lineItems, quality: x.quality, schemaVersion: x.schemaVersion }), x.quality?.confidence ?? null, JSON.stringify(v?.rules || []), JSON.stringify({ canonicalKey: key }), disposition, null, now(), (x.ocrText || "").slice(0, 20_000), x.raw ? JSON.stringify(x.raw).slice(0, 8000) : null, x.schemaVersion, x.latencyMs);
      db.prepare(`delete from receipt_items where receipt_id=?`).run(receiptId);
      for (const li of (x.lineItems || [])) insertItem.run(id("itm"), receiptId, String(li.description || "").slice(0, 200), li.productMatch?.code || null, li.quantity ?? null, li.packGrams ? li.packGrams / 1000 : null, li.amountMinor != null ? li.amountMinor / 100 : null, JSON.stringify({ raw: li.rawText, packGrams: li.packGrams, voided: !!li.voided }));
      db.prepare(`update receipts set fingerprint=?, extracted_outlet_text=?, outlet_match_json=? where id=?`).run(key, x.merchant?.rawText || null, JSON.stringify(x.merchant?.candidates || []), receiptId);
    }
    db.prepare(`update receipts set status=?, reason_code=?, decided_by=?, decided_at=?, canonical_receipt_id=coalesce(?, canonical_receipt_id), row_version=row_version+1 where id=?`).run(disposition, reason, decidedBy, now(), canonicalId, receiptId);
    // The CRM versions a submission by the receipt's DECISION counter, not by
    // the extraction attempt. attemptNo counts validation_results rows, and a
    // reviewer's decision writes none, so an automatic pass and the reviewer's
    // decision that followed it both emitted entity_version = 1. crm_events has
    // UNIQUE (entity_type, entity_id, entity_version, event_type) and emit()
    // uses INSERT OR IGNORE, so every human decision was silently dropped and
    // the CRM kept the receipt as REVIEW_REQUIRED for ever. row_version is
    // bumped on every decision, so it is monotonic and collision-free.
    const decisionVersion = getReceipt.get(receiptId).row_version;

    let entryId = null;
    if (disposition === DISPOSITION.QUALIFIED) {
      if (!canonicalId) throw new Error("integrity: a qualified receipt must have a canonical identity");
      // uq_entries_canonical is unconditional (any status), so the guard must be
      // too: filtering on status='active' let a second award reach the INSERT
      // and fail as a raw UNIQUE error inside the pipeline transaction instead
      // of a clean decision.
      const existing = db.prepare(`select id from entries where canonical_receipt_id=?`).get(canonicalId);
      if (existing) throw Object.assign(new Error("integrity: canonical receipt already credited"), { code: "ALREADY_CREDITED" });
      const entryNo = domain.countActiveEntries(r.participant_id, r.campaign_id) + 1;
      entryId = id("ent");
      insertEntry.run(entryId, receiptId, r.participant_id, r.campaign_id, version.id, r.period_code || "unassigned", entryNo, "active", now(), r.period_code || null, Number(rules?.award?.entries_per_receipt || 1), canonicalId);
      db.prepare(`update canonical_receipts set status='credited', credited_receipt_id=?, credited_entry_id=? where id=?`).run(receiptId, entryId, canonicalId);
      domain.audit({ actorType: isReview ? "admin" : "system", actorId: decidedBy, action: "entry.awarded", targetType: "entry", targetId: entryId, correlationId, payload: { receiptId, canonicalId, periodCode: r.period_code, rulesVersion: version.config_hash } });
      crm?.emit({ entityType: "entry", entityId: entryId, entityVersion: 1, payload: { participantId: r.participant_id, campaignCode: domain.getCampaign(r.campaign_id)?.code, period: r.period_code, outletCode: domain.getOutlet(r.selected_outlet_id)?.outlet_code, reference: shortRef(receiptId), status: "active", createdAt: now() }, correlationId });
    } else if (disposition === DISPOSITION.REVIEW) {
      insertReview.run(id("rvw"), receiptId, "open", new Date(Date.now() + REVIEW_SLA_HOURS * 3600_000).toISOString(), now());
    } else if (canonicalId && !isReview) {
      db.prepare(`update canonical_receipts set status=case when status='credited' then status else 'pending' end where id=?`).run(canonicalId);
    }
    domain.audit({ actorType: isReview ? "admin" : "system", actorId: decidedBy, action: `receipt.${disposition.toLowerCase()}`, targetType: "receipt", targetId: receiptId, reason, correlationId, payload: { entryId, canonicalId, note, rules: v?.rules?.filter((rr) => rr.outcome !== "pass").map((rr) => `${rr.rule}:${rr.outcome}`) } });
    crm?.emit({ entityType: "submission", entityId: receiptId, entityVersion: decisionVersion, payload: { participantId: r.participant_id, campaignCode: domain.getCampaign(r.campaign_id)?.code, reference: shortRef(receiptId), outletCode: domain.getOutlet(r.selected_outlet_id)?.outlet_code, status: disposition, reason, intakeAt: r.intake_at }, correlationId });

    // participant outcome message (single, idempotent per decision)
    const phone = domain.getParticipant(r.participant_id)?.wa_phone_uid;
    if (phone) outbox.enqueueWhatsApp({ waPhoneUid: phone, kind: "text", purpose: "receipt_outcome", campaignId: r.campaign_id, correlationId, payload: outcomeCopy(r, disposition, reason, isReview, rules), idempotencyKey: `receipt:${receiptId}:outcome:${attemptNo}:${isReview ? "review" : "auto"}` });
    return { receiptId, decision: disposition, reason, entryId, canonicalId, receipt: getReceipt.get(receiptId) };
  }

  function outcomeCopy(r, disposition, reason, isReview, rules) {
    const c = pinnedContent(r); const reference = shortRef(r.id);
    const flags = pinnedFlags(r);
    const countLine = flags.participant_status ? renderCopy(c, "qualified_count_line", { count: domain.countActiveEntries(r.participant_id, r.campaign_id) }) : "";
    const vars = { reference, campaign: domain.getCampaign(r.campaign_id)?.name || "the promotion", reason: reasonLabel(c, reason, ruleVars(rules || {})), count_line: countLine };
    const k = { QUALIFIED: isReview ? "review_result_qualified" : "qualified", NOT_QUALIFIED: isReview ? "review_result_not_qualified" : "not_qualified", DUPLICATE: isReview ? "review_result_duplicate" : "duplicate", REVIEW_REQUIRED: "under_review", REUPLOAD_REQUIRED: isReview ? "review_result_reupload" : "reupload" }[disposition] || "under_review";
    return renderCopy(c, k, vars);
  }

  // ---------------------------------------------------------------------------
  /** Reviewer decision: same integrity path; optimistic version check; audited; notifies participant. */
  function review(receiptId, { reviewer, decision, reasonCode = null, note = null, expectedVersion = null }) {
    if (!["QUALIFIED", "NOT_QUALIFIED", "DUPLICATE", "REUPLOAD_REQUIRED"].includes(decision)) throw Object.assign(new Error("invalid decision"), { code: "BAD_DECISION" });
    return tx(db, () => {
      const r = getReceipt.get(receiptId); if (!r) throw Object.assign(new Error("receipt not found"), { code: "NOT_FOUND" });
      if (expectedVersion != null && r.row_version !== Number(expectedVersion)) throw Object.assign(new Error("receipt changed since you loaded it; reload"), { code: "CONFLICT" });
      const task = db.prepare(`select * from review_tasks where receipt_id=?`).get(receiptId);
      if (task?.state === "decided") throw Object.assign(new Error("already decided"), { code: "CONFLICT" });
      if (r.status === "QUALIFIED") throw Object.assign(new Error("receipt already credited; use disqualification"), { code: "CONFLICT" });
      const version = domain.getVersion(r.campaign_version_id);
      const rules = JSON.parse(version.rules_json || "{}");
      const last = db.prepare(`select facts_json from validation_results where receipt_id=? order by attempt_no desc limit 1`).get(receiptId);
      const facts = last ? JSON.parse(last.facts_json || "{}") : {};
      let canonicalId = r.canonical_receipt_id;
      let disposition = decision, reason = reasonCode || (decision === "QUALIFIED" ? REASONS.OK : "reviewer_decision");
      if (decision === "QUALIFIED") {
        // The period's draw is already frozen/executed: its candidate snapshot
        // is immutable, so this entry could never enter any draw while the
        // participant would be told "ONE entry has been added to the draw".
        // Refuse, naming the draw, rather than awarding an orphan entry.
        const drawn = periodAlreadyDrawn(r);
        if (drawn.length) throw Object.assign(new Error(`period ${r.period_code} has already been drawn (draw ${drawn[0].id} is ${drawn[0].status}); an entry awarded now could enter no draw — void and rerun that draw first, or decide another outcome`), { code: "CONFLICT", draws: drawn.map((d) => d.id) });
        const identity = { outletId: r.selected_outlet_id, date: facts.transaction?.date, receiptNo: facts.transaction?.receiptNo, totalMinor: facts.transaction?.totalMinor };
        const key = r.fingerprint || canonicalKeyOf(identity);
        if (!key) throw Object.assign(new Error("cannot credit: receipt identity (outlet, date, number) is incomplete — resolve the fields first"), { code: "IDENTITY_INCOMPLETE" });
        // Same stable identity as process(): crediting a receipt whose total was
        // unreadable must not mint a second claim on a purchase already claimed.
        const can = duplicates.claim(r.campaign_id, identity) || duplicates.canonical(r.campaign_id, key);
        // A reviewer's explicit QUALIFIED used to be rewritten to DUPLICATE in
        // silence: the participant was told "already used" and nothing told the
        // reviewer their decision had not been applied. Name the holder so the
        // credit can be moved (disqualify it first) or DUPLICATE chosen
        // deliberately.
        if (can && can.status === "credited" && can.credited_receipt_id !== receiptId) {
          throw Object.assign(new Error(`this purchase is already credited to receipt ${shortRef(can.credited_receipt_id || can.first_receipt_id)}; disqualify that entry first, or record this one as DUPLICATE`), { code: "CONFLICT", creditedReceiptId: can.credited_receipt_id || can.first_receipt_id });
        } else if (!can) {
          canonicalId = id("can");
          // receipt_no_norm is what the outlet-independent and total-independent
          // identity lookups match on; a row created here without it was
          // invisible to both.
          db.prepare(`insert into canonical_receipts (id, campaign_id, canonical_key, outlet_id, txn_date, receipt_no, receipt_no_norm, total_minor, currency, first_receipt_id, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(canonicalId, r.campaign_id, key, r.selected_outlet_id, facts.transaction?.date || null, facts.transaction?.receiptNo || null, facts.transaction?.receiptNo ? normaliseReceiptNo(facts.transaction.receiptNo) : null, facts.transaction?.totalMinor ?? null, facts.transaction?.currency || null, receiptId, "pending", now());
        } else canonicalId = can.id;
      }
      db.prepare(`update review_tasks set state='decided', decision=?, reason_code=?, note=?, decided_by=?, decided_at=?, row_version=row_version+1 where receipt_id=?`).run(disposition, reason, note, reviewer, now(), receiptId);
      const out = commit({ r, receiptId, version, x: null, v: null, disposition, reason, canonicalId, key: r.fingerprint, attemptNo: attemptsFor.get(receiptId).n, correlationId: null, rules, decidedBy: reviewer, note });
      return out;
    });
  }

  /** Resolve an open duplicate candidate (same_purchase | different_purchase). */
  function resolveDuplicate(candidateId, resolution, reviewer, note = null) {
    if (!["same_purchase", "different_purchase"].includes(resolution)) throw new Error("invalid resolution");
    const c = db.prepare(`select * from duplicate_candidates where id=?`).get(candidateId); if (!c) throw new Error("candidate not found");
    db.prepare(`update duplicate_candidates set resolution=?, resolved_by=?, resolved_at=?, note=? where id=?`).run(resolution, reviewer, now(), note, candidateId);
    domain.audit({ actorType: "admin", actorId: reviewer, action: "duplicate.resolve", targetType: "receipt", targetId: c.receipt_id, reason: resolution, payload: { candidate: c.candidate_receipt_id, note } });
    return db.prepare(`select * from duplicate_candidates where id=?`).get(candidateId);
  }

  /** Authorised disqualification event: award history preserved; current eligibility derives from events. */
  function disqualifyEntry(entryId, { actorId, reason, approvedBy = null, note = null }) {
    return tx(db, () => {
      const e = db.prepare(`select * from entries where id=?`).get(entryId); if (!e) throw new Error("entry not found");
      if (e.status !== "active") throw Object.assign(new Error(`entry is ${e.status}`), { code: "CONFLICT" });
      if (!reason) throw new Error("reason required");
      const frozen = db.prepare(`select d.id, d.status from draw_candidates c join draws d on d.id=c.draw_id where c.entry_id=? and d.status in ('frozen','executing','executed','approved','published')`).all(entryId);
      if (frozen.length && !approvedBy) throw Object.assign(new Error("entry is in a frozen or executed draw: independent approval required"), { code: "APPROVAL_REQUIRED" });
      if (approvedBy && approvedBy === actorId) throw Object.assign(new Error("approver must differ from the actor"), { code: "SOD" });
      db.prepare(`update entries set status='excluded' where id=?`).run(entryId);
      db.prepare(`insert into entry_events (id, entry_id, type, reason, actor_id, approved_by, effective_at, note, created_at) values (?,?,?,?,?,?,?,?,?)`).run(id("eev"), entryId, "disqualified", reason, actorId, approvedBy, now(), note, now());
      domain.audit({ actorType: "admin", actorId, action: "entry.disqualified", targetType: "entry", targetId: entryId, reason, payload: { approvedBy, affectedDraws: frozen.map((d) => d.id) } });
      crm?.emit({ entityType: "entry", entityId: entryId, entityVersion: entryVersion(entryId), payload: { participantId: e.participant_id, campaignCode: domain.getCampaign(e.campaign_id)?.code, period: e.period_code, status: "excluded", reference: shortRef(e.receipt_id) } });
      return { entryId, affectedDraws: frozen };
    });
  }
  /**
   * Reversal of a disqualification. It carries the same controls as the
   * decision it undoes: a single actor could otherwise unilaterally put back an
   * entry that two people agreed to remove, with no reason recorded, no
   * approver checked and nothing told to the CRM.
   */
  function reinstateEntry(entryId, { actorId, reason, approvedBy = null, note = null }) {
    return tx(db, () => {
      const e = db.prepare(`select * from entries where id=?`).get(entryId); if (!e || e.status !== "excluded") throw new Error("entry not excluded");
      // A missing reason used to surface as "NOT NULL constraint failed" from
      // inside the transaction — a 500 where a validation message belongs.
      if (!reason) throw Object.assign(new Error("reason required"), { code: "VALIDATION" });
      // An approver that is never checked is worse than none: the ledger shows
      // a second name that nobody verified.
      if (approvedBy && approvedBy === actorId) throw Object.assign(new Error("approver must differ from the actor"), { code: "SOD" });
      const undoing = db.prepare(`select * from entry_events where entry_id=? and type='disqualified' order by created_at desc, id desc limit 1`).get(entryId);
      if (undoing?.approved_by && !approvedBy) throw Object.assign(new Error("this entry was disqualified under independent approval: reinstating it requires an independent approver too"), { code: "APPROVAL_REQUIRED" });
      db.prepare(`update entries set status='active' where id=?`).run(entryId);
      db.prepare(`insert into entry_events (id, entry_id, type, reason, actor_id, approved_by, effective_at, note, created_at) values (?,?,?,?,?,?,?,?,?)`).run(id("eev"), entryId, "reinstated", reason, actorId, approvedBy, now(), note, now());
      domain.audit({ actorType: "admin", actorId, action: "entry.reinstated", targetType: "entry", targetId: entryId, reason, payload: { approvedBy, note } });
      // Without this the CRM kept reporting a prize-eligible entry as excluded
      // for ever: nothing else ever re-emits an entry.
      crm?.emit({ entityType: "entry", entityId: entryId, entityVersion: entryVersion(entryId), payload: { participantId: e.participant_id, campaignCode: domain.getCampaign(e.campaign_id)?.code, period: e.period_code, status: "active", reference: shortRef(e.receipt_id) } });
      return { entryId, approvedBy };
    });
  }

  /** Safe reprocessing: only non-credited receipts; a new validation attempt is recorded. */
  function reprocess(receiptId, actorId, reason = "operator reprocess") {
    const r = getReceipt.get(receiptId); if (!r) throw new Error("receipt not found");
    if (r.status === "QUALIFIED") throw Object.assign(new Error("credited receipts are not reprocessed; use disqualification"), { code: "CONFLICT" });
    db.prepare(`update receipts set status='received', row_version=row_version+1 where id=?`).run(receiptId);
    db.prepare(`update review_tasks set state='decided', decision='reprocessed', decided_by=?, decided_at=? where receipt_id=? and state!='decided'`).run(actorId, now(), receiptId);
    db.prepare(`insert into jobs (id, kind, payload_json, status, run_after, created_at) values (?,?,?,?,?,?)`).run(id("job"), "receipt.process", JSON.stringify({ receiptId }), "pending", now(), now());
    domain.audit({ actorType: "admin", actorId, action: "receipt.reprocess", targetType: "receipt", targetId: receiptId, reason });
    return { receiptId, queued: true };
  }

  return { submit, process, review, resolveDuplicate, disqualifyEntry, reinstateEntry, reprocess, get: (rid) => getReceipt.get(rid), shortRef };
}
export { shortRef };
