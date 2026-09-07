import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const bool = (v) => v === "1" || v === "true" || v === true;
  return {
    host: env.HOST || "127.0.0.1",
    port: num(env.PORT, 5191),
    database: abs(env.DATABASE || "./data/promotions.db"),
    mediaDir: abs(env.MEDIA_DIR || "./data/media"),
    logLevel: env.LOG_LEVEL || "info",
    // bootstrap admin
    adminEmail: (env.ADMIN_EMAIL || "admin@example.com").toLowerCase().trim(),
    adminPassword: env.ADMIN_PASSWORD || "change-me-now",
    // WhatsApp transport
    whatsappTransport: env.WHATSAPP_TRANSPORT || "simulator", // simulator | cloud-api | linked-device
    meta: {
      apiVersion: env.META_API_VERSION || "v21.0",
      phoneNumberId: env.META_PHONE_NUMBER_ID || "",
      wabaId: env.META_WABA_ID || "",
      appId: env.META_APP_ID || "",
      appSecret: env.META_APP_SECRET || "",
      accessToken: env.META_ACCESS_TOKEN || "",
    },
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    webhookToken: env.WHATSAPP_WEBHOOK_TOKEN || "",
    baileysAuthDir: abs(env.BAILEYS_AUTH_DIR || "./data/baileys"),
    // receipt intelligence
    receiptExtractor: env.RECEIPT_EXTRACTOR || "simulator", // simulator | vision | none
    receipt: {
      openaiApiKey: env.RECEIPT_PROVIDER_OPENAI_API_KEY || "",
      openaiModel: env.RECEIPT_PROVIDER_OPENAI_MODEL || "gpt-4o",
      baseUrl: env.RECEIPT_PROVIDER_BASE_URL || "https://api.openai.com/v1",
      autoQualifyMinConfidence: Number(env.RECEIPT_AUTO_QUALIFY_MIN_CONFIDENCE || 0.9),
      autoReviewRateCap: Number(env.RECEIPT_AUTO_QUALIFY_MAX_REVIEW_RATE || 0.35),
    },
    // original desk AI wrapper (optional)
    ai: {
      provider: env.AI_PROVIDER || "none",
      apiKey: env.AI_PROVIDER_API_KEY || "",
      model: env.AI_MODEL || "",
      monthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD, 0),
    },
    crm: {
      provider: env.CRM_PROVIDER || "none", // none | webhook
      webhookUrl: env.CRM_WEBHOOK_URL || "",
      webhookToken: env.CRM_WEBHOOK_TOKEN || "",
    },
    drawRandomBytes: num(env.DRAW_RANDOM_BYTES, 32),
    retention: {
      rawReceiptsDays: num(env.RETENTION_RAW_RECEIPTS_DAYS, 90),
      factsDays: num(env.RETENTION_FACTS_DAYS, 180),
    },
    exportWatermark: bool(env.EXPORT_WATERMARK ?? true),
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}