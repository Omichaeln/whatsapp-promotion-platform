// Shared test harness: in-memory sqlite, migrated schema, seeded campaign.
import { test, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb, migrate, nowIso } from "../src/db.mjs";
import { createDomain } from "../src/services.mjs";
import { createReceiptPipeline } from "../src/receipt-pipeline.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { createDuplicateDetector } from "../src/duplicates.mjs";
import { createMediaStore } from "../src/media.mjs";
import { SimulatorExtractor, encodeReceiptFacts } from "../src/extract/simulator.mjs";
import { createDrawService } from "../src/draw.mjs";
import { createConversationService } from "../src/conversation.mjs";

export function buildTestApp() {
  const db = openDb(":memory:");
  migrate(db, undefined, () => {});
  const mediaStore = createMediaStore({ dir: "/tmp/wpp-test-media", db });
  const domain = createDomain(db, "test-key");
  const outbox = createOutbox(db);
  const duplicates = createDuplicateDetector({ db });
  const extractor = new SimulatorExtractor({ minConfidence: 0.6 });
  const pipeline = createReceiptPipeline({ db, mediaStore, extractor, duplicates, outbox, domain, minConfidence: 0.6 });
  const conversation = createConversationService({ db, domain, receiptPipeline: pipeline, outbox });
  const drawService = createDrawService(db);

  return { db, domain, pipeline, outbox, duplicates, extractor, mediaStore, conversation, drawService };
}

export function seedCampaign(ctx) {
  const start = "2026-09-01T00:00:00Z";
  const end = "2026-11-30T23:59:59Z";
  const c = ctx.domain.createCampaign({ code: "TEST", name: "Test Promo", startAt: start, endAt: end });
  ctx.domain.setCampaignStatus(c.id, "active", "test");
  ctx.domain.upsertOutlet({ outlet_code: "OK-HRE-01", retailer: "OK Mart", branch: "Westgate", town: "Harare", province: "Harare" });
  ctx.domain.upsertOutlet({ outlet_code: "TM-HRE-01", retailer: "TM", branch: "Avondale", town: "Harare", province: "Harare" });
  ctx.domain.upsertProduct({ sku: "ZSB-2KG", brand: "ZimSweet", name: "Brown Sugar 2kg", aliases: ["brown sugar"], pack_weight_kg: 2 });
  const vid = ctx.domain.createVersion(c.id, {
    rules: {
      products: [{ sku: "ZSB-2KG", aliases: ["brown sugar", "zimsweet"], pack_weight_kg: 2 }],
      min_packs: 2, min_total_qty_kg: 4, weekly_caps: { participant: 5 },
    },
  });
  ctx.domain.activateVersion(c.id, vid, "test");
  return { campaign: c, versionId: vid };
}

export function validReceiptFacts(outlet = "OK-HRE-01") {
  return {
    outlet, date: "2026-10-05T14:22:00Z", receiptNo: "R-1001",
    total: 12.5, currency: "USD", _confidence: 0.95,
    lineItems: [
      { description: "ZimSweet Brown Sugar 2kg", quantity: 2, amount: 5.0 },
      { description: "Bread", quantity: 1, amount: 2.5 },
    ],
  };
}

export function registerParticipant(ctx, phone = "0771234567") {
  return ctx.domain.registerParticipant({ phoneUid: phone, firstName: "Tapiwa", surname: "Moyo", identity: "63-1234567F12", location: "Harare", ageConfirmed: true, termsVersion: "T1", privacyVersion: "P1" });
}

export { test, before, after, describe, it, assert, encodeReceiptFacts, nowIso };