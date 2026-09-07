import { id, tx, nowIso, sha256hex } from "./db.mjs";
import { evaluateEligibility, drawPeriodOf } from "./eligibility.mjs";
import { fingerprintOf } from "./duplicates.mjs";

/**
 * Receipt pipeline (G-06..G-10, spec 11.2-11.4).
 * Invariants (10.4):
 *  - one active receipt per provider message (unique constraint)
 *  - final decision + qualified ENTRY commit atomically (tx)
 *  - retry / replay / concurrent submit can never create a second entry
 *  - OCR output is evidence; deterministic rules or a reviewer decide
 *
 * Order: store media -> extract evidence -> insert receipt (UNIQUE guard) ->
 * exact/fingerprint duplicate finalization -> similar -> eligibility ->
 * atomic commit of decision (+entry/+review task) + audit + outbox.
 */
export function createReceiptPipeline({ db, mediaStore, extractor, duplicates, outbox, domain, minConfidence = 0.6 }) {
  const now = nowIso;

  const insertReceipt = db.prepare(
    `insert into receipts (id, provider_message_id, participant_id, campaign_id, campaign_version_id,
       media_asset_id, selected_outlet_id, fingerprint, status, reason_code, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertValidation = db.prepare(
    `insert into validation_results (id, receipt_id, attempt_no, extractor_provider, extractor_version,
       facts_json, confidence, rule_results_json, risk_signals_json, decision, error, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItems = db.prepare(
    `insert into receipt_items (id, receipt_id, description, sku, quantity, unit_weight_kg, amount, evidence_json)
     values (?,?,?,?,?,?,?,?)`);
  const insertEntry = db.prepare(
    `insert into entries (id, receipt_id, participant_id, campaign_id, campaign_version_id, draw_period, entry_no, status, created_at)
     values (?,?,?,?,?,?,?,?,?)`);
  const updateReceipt = db.prepare(
    `update receipts set status=?, reason_code=?, decided_by=?, decided_at=? where id=?`);
  const getReceipt = db.prepare(`select * from receipts where id = ?`);
  const getByProviderMsg = db.prepare(`select * from receipts where provider_message_id = ?`);
  const getByMediaAsset = db.prepare(`select * from receipts where media_asset_id = ? order by created_at limit 1`);
  const insertReviewTask = db.prepare(
    `insert into review_tasks (id, receipt_id, state, sla_due_at, created_at) values (?,?,?,?,?)`);
  const insertAudit = db.prepare(
    `insert into audit_events (actor_type, actor_id, action, target_type, target_id, reason, request_id,
       prev_hash, entry_hash, payload_json, created_at) values (?,?,?,?,?,?,?,?,?,?,?)`);
  const lastAudit = db.prepare(`select entry_hash from audit_events order by id desc limit 1`);
  const countThisWeek = db.prepare(
    `select count(*) n from entries where participant_id=? and campaign_id=? and created_at >= ?`);

  function auditEvent(actorType, actorId, action, targetType, targetId, reason, payload) {
    const prev = lastAudit.get()?.entry_hash || "";
    const body = JSON.stringify({ action, targetType, targetId, payload: payload ?? null, when: now() });
    const h = sha256hex(prev + body);
    insertAudit.run(actorType, actorId, action, targetType, targetId, reason || null, null, prev, h, body, now());
  }
  function weekStartIso() {
    const d = new Date();
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }

  async function process({ campaignId, participantId, phoneUid, selectedOutletId, providerMessageId, imageBytes, mime, campaignVersionId }) {
    // 1 - private media storage + integrity hashes (G-06)
    const media = await mediaStore.store({ bytes: imageBytes, mime, campaignId });

    // 2 - immutable campaign version; evidence extraction
    const version = campaignVersionId
      ? db.prepare(`select * from campaign_versions where id=?`).get(campaignVersionId)
      : domain.getActiveVersion(campaignId);
    if (!version) throw new Error("no active campaign version");
    let extractResult;
    try {
      extractResult = await extractor.extract({ receiptId: null, providerMessageId, campaignVersionId: version.id, participantId, mediaAssetId: media.assetId, selectedOutletId, imageBytes });
    } catch (e) {
      extractResult = { extracted: null, confidence: 0, provider: "unknown", model: "unknown", hint: "error", error: String(e.message) };
    }
    const facts = extractResult.extracted || { lineItems: [], total: 0 };
    const fingerprint = fingerprintOf(facts, selectedOutletId);

    // 3 - receipt row first (UNIQUE provider_message_id = replay guard)
    const receiptId = id("rcpt");
    try {
      insertReceipt.run(receiptId, providerMessageId, participantId, campaignId, version.id,
        media.assetId, selectedOutletId, fingerprint, "processing", null, now());
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) {
        const existing = getByProviderMsg.get(providerMessageId);
        if (existing) return { receipt: existing, kind: "idempotent_replay", decision: existing.status };
      }
      throw e;
    }

    // 4 - exact duplicate controls (G-09): only meaningful against a PRIOR
    // stored asset. A brand-new asset (existing:false) can never be a dup.
    if (media.existing) {
      const exact = duplicates.checkExact({ providerMessageId, sha256: media.sha256 });
      if (exact.duplicate) {
        const original = getByProviderMsg.get(providerMessageId) || getByMediaAsset.get(media.assetId);
        if (original && original.id !== receiptId) {
          return finalizeDuplicate(receiptId, providerMessageId, participantId, version.id, facts, extractResult, phoneUid, original.id);
        }
      }
    }

    // 5 - normalized receipt fingerprint duplicate (exclude this row itself)
    const fp = duplicates.checkFingerprint(fingerprint, receiptId);
    if (fp.duplicate) return finalizeDuplicate(receiptId, providerMessageId, participantId, version.id, facts, extractResult, phoneUid, fp.original);

    // 6 - probable perceptual similarity -> review, never auto-duplicate
    const similar = duplicates.probableSimilar(media.phash);

    // 7 - deterministic eligibility against frozen rules (G-08)
    const rules = JSON.parse(version.rules_json || "{}");
    const outlet = selectedOutletId ? db.prepare(`select * from outlets where id=?`).get(selectedOutletId) : null;
    const weeklyCount = countThisWeek.get(participantId, campaignId, weekStartIso()).n;
    const campaign = db.prepare(`select * from campaigns where id=?`).get(campaignId);
    const context = {
      campaignStart: campaign?.start_at, campaignEnd: campaign?.end_at,
      selectedOutletId,
      outletParticipating: outlet ? () => !(rules.exclude_outlets || []).includes(selectedOutletId) : () => false,
      participantBlocked: false, consentValid: true, weeklyEntryCount: weeklyCount,
    };
    const factsWithConf = { ...facts, confidence: extractResult.confidence };
    let verdict = evaluateEligibility(factsWithConf, rules, context, { minConfidence });
    let decision = verdict.decision, reasonCode = verdict.reason;
    if (similar.probable && decision === "QUALIFIED") { decision = "NEEDS_REVIEW"; reasonCode = "similar_receipt"; }
    else if (extractResult.confidence < 0.25 && decision !== "NOT_QUALIFIED") { decision = "NEEDS_REVIEW"; reasonCode = "low_confidence"; }

    // 8 - ATOMIC commit (spec 14: at most one transaction creates the entry)
    return commitDecision({ receiptId, providerMessageId, participantId, version, media, facts, extractResult, verdict, decision, reasonCode, phoneUid, campaignId });
  }

  function finalizeDuplicate(receiptId, providerMessageId, participantId, versionId, facts, extractResult, phoneUid, originalReceiptId) {
    return tx(db, () => {
      insertValidation.run(id("val"), receiptId, 1, extractResult.provider || "simulator", extractResult.model || "v1",
        JSON.stringify(facts), extractResult.confidence, JSON.stringify([]), JSON.stringify({ duplicate_of: originalReceiptId }), "DUPLICATE", null, now());
      updateReceipt.run("DUPLICATE", "duplicate_receipt", "system", now(), receiptId);
      auditEvent("system", "system", "receipt.duplicate", "receipt", receiptId, "duplicate_receipt", { originalReceiptId });
      outbox.enqueueWhatsApp({ waPhoneUid: phoneUid, kind: "text", payload: "This receipt has already been used for an entry. You cannot enter with it again.", idempotencyKey: `receipt:${receiptId}:outcome` });
      return { receiptId, decision: "DUPLICATE", receipt: getReceipt.get(receiptId) };
    });
  }

  function commitDecision({ receiptId, providerMessageId, participantId, version, media, facts, extractResult, verdict, decision, reasonCode, phoneUid, campaignId }) {
    const out = tx(db, () => {
      insertValidation.run(id("val"), receiptId, 1, extractResult.provider || "simulator", extractResult.model || "v1",
        JSON.stringify({ ...facts, confidence: extractResult.confidence }), extractResult.confidence,
        JSON.stringify(verdict.ruleResults), JSON.stringify({}), decision, extractResult.error || null, now());
      for (const li of (facts.lineItems || [])) {
        insertItems.run(id("itm"), receiptId, String(li.description || ""), li.sku || null, li.quantity || 1, li.unitWeightKg ?? null, li.amount ?? null, JSON.stringify({
        }));
      }
      updateReceipt.run(decision, reasonCode, "system", now(), receiptId);

      let entryId = null;
      if (decision === "QUALIFIED") {
        const period = drawPeriodOf(facts.date || now());
        const entryNo = countThisWeek.get(participantId, campaignId, weekStartIso()).n + 1;
        entryId = id("ent");
        insertEntry.run(entryId, receiptId, participantId, campaignId, version.id, period, entryNo, "active", now());
        auditEvent("system", "system", "entry.created", "entry", entryId, null, { receiptId, period });
        outbox.enqueueCrm({ entityType: "entry", entityId: entryId, eventType: "upsert", payload: { entryId, receiptId, participantId, campaignId, drawPeriod: period } });
      } else if (decision === "NEEDS_REVIEW") {
        insertReviewTask.run(id("rvw"), receiptId, "open", new Date(Date.parse(now()) + 24 * 3600_000).toISOString(), now());
        auditEvent("system", "system", "receipt.needs_review", "receipt", receiptId, reasonCode, {});
      } else if (decision === "NOT_QUALIFIED") {
        auditEvent("system", "system", "receipt.not_qualified", "receipt", receiptId, reasonCode, {});
      }
      outbox.enqueueWhatsApp({
        waPhoneUid: phoneUid, kind: "text",
        payload: outcomeCopy(decision, reasonCode, receiptId),
        idempotencyKey: `receipt:${receiptId}:outcome`,
      });
      return { receiptId, decision, reasonCode, entryId };
    });
    return { ...out, receipt: getReceipt.get(receiptId) };
  }

  /** Reviewer decision (G-11) — flips an open review task + optional entry. */
  function reviewDecision(receiptId, reviewer, decision, reasonCode, note) {
    return tx(db, () => {
      const r = getReceipt.get(receiptId);
      if (!r) throw new Error("receipt not found");
      if (!["QUALIFIED", "NOT_QUALIFIED", "DUPLICATE", "REQUIRES_REUPLOAD"].includes(decision)) throw new Error("invalid decision");
      updateReceipt.run(decision, reasonCode || "reviewer_decision", reviewer, now(), receiptId);
            db.prepare(`update review_tasks set state='decided', decision=?, reason_code=?, note=?, decided_by=?, decided_at=? where receipt_id=?`)
              .run(decision, reasonCode || null, note || null, reviewer, now(), receiptId);
      let entryId = null;
      if (decision === "QUALIFIED" && !db.prepare(`select 1 from entries where receipt_id=?`).get(receiptId)) {
        const version = db.prepare(`select * from campaign_versions where id=?`).get(r.campaign_version_id);
        const period = drawPeriodOf(r.created_at);
        entryId = id("ent");
        insertEntry.run(entryId, receiptId, r.participant_id, r.campaign_id, version?.id || r.campaign_version_id, period, 1, "active", now());
        outbox.enqueueCrm({ entityType: "entry", entityId: entryId, eventType: "upsert", payload: { receiptId, participantId: r.participant_id, campaignId: r.campaign_id, drawPeriod: period } });
      }
      auditEvent("admin", reviewer, `review.${decision.toLowerCase()}`, "receipt", receiptId, reasonCode || null, { reviewer, decision, entryId });
      return { receipt: getReceipt.get(receiptId), entryId };
    });
  }

  return { process, reviewDecision, get: (rid) => getReceipt.get(rid) };
}

// ---- helpers --------------------------------------------------------------
function outcomeCopy(decision, reasonCode, receiptId) {
  const ref = String(receiptId).slice(0, 8);
  switch (decision) {
    case "QUALIFIED": return `Entry confirmed! Reference ${ref}. You're in the weekly draw. Reply ENTER to submit another receipt.`;
    case "DUPLICATE": return "This receipt has already been used for an entry. You cannot enter with it again.";
    case "NOT_QUALIFIED": return `Thanks, but this receipt does not qualify (${reasonCode || "not eligible"}). You can still send another valid receipt.`;
    case "NEEDS_REVIEW": return `Receipt ${ref} received — it is being reviewed and we will update you. Reply MENU for options.`;
    default: return `Receipt ${ref} received. Status: processing.`;
  }
}
export { id, tx, sha256hex };