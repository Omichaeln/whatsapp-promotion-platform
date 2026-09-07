/**
 * ReceiptExtractor contract (spec 12.3, gaps G-07).
 *
 * OCR/vision output is always EVIDENCE. The deterministic eligibility engine
 * (src/eligibility.mjs) or an authorized reviewer makes the DECISION. Never
 * let raw extraction directly qualify a receipt.
 *
 * Contract returned by extract():
 *   {
 *     extracted: {
 *       outlet, date, receiptNo, currency, total, lineItems: [{description, sku, quantity, unitWeightKg, amount}]
 *     },
 *     confidence: 0..1,
 *     provider, model,     // provider + model/version used
 *     hint: "decide" | "review",
 *     raw: provided facts for audit,
 *   }
 */

export class ReceiptExtractor {
  async extract({ receiptId, providerMessageId, campaignVersionId, participantId, mediaAssetId, selectedOutletId, imageBytes }) {
    throw new Error("not implemented");
  }
}