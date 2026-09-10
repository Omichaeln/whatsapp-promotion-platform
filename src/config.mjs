import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Configuration schema: name, default, description, secret. Used by preflight and docs. */
export const CONFIG_SCHEMA = [
  ["ENVIRONMENT", "local", "local | test | staging | production (stored in schema_meta on first boot; production enables activation gates)"],
  ["HOST", "127.0.0.1", "bind address (0.0.0.0 on Railway)"],
  ["PORT", "5191", "HTTP port"],
  ["DATABASE", "./data/promotions.db", "SQLite file (WAL). Railway: /app/data/promotions.db on the mounted volume"],
  ["MEDIA_DIR", "./data/media", "private receipt media directory (never served publicly)"],
  ["PUBLIC_BASE_URL", "", "public HTTPS base of this service (webhook + console links)"],
  ["ADMIN_EMAIL", "admin@example.com", "bootstrap platform_admin (first run only)"],
  ["ADMIN_PASSWORD", "", "bootstrap password (>=12 chars); required on public deployments", true],
  ["IDENTITY_KEY", "", "AES-256-GCM key material for identity numbers; required outside local", true],
  ["AUDIT_CHECKPOINT_KEY", "", "HMAC key for signed audit checkpoints (draw bundles)", true],
  ["DEFAULT_COUNTRY_CODE", "263", "country code prefixed to local numbers (test assumption D-04)"],
  ["WHATSAPP_TRANSPORT", "simulator", "simulator | cloud-api | linked-device (linked-device is dev only)"],
  ["META_API_VERSION", "v21.0", "Graph API version"],
  ["META_PHONE_NUMBER_ID", "", "Cloud API phone number id"],
  ["META_WABA_ID", "", "WhatsApp Business Account id"],
  ["META_APP_ID", "", "Meta app id"],
  ["META_APP_SECRET", "", "Meta app secret (webhook signature)", true],
  ["META_ACCESS_TOKEN", "", "system-user access token", true],
  ["WHATSAPP_WEBHOOK_TOKEN", "", "verify token for the webhook handshake; also seeds media-link signing", true],
  ["BAILEYS_AUTH_DIR", "./data/baileys", "linked-device session dir (dev only)"],
  ["RECEIPT_EXTRACTOR", "tesseract", "tesseract (real, offline) | vision (real, needs key) | simulator (TEST ONLY)"],
  ["RECEIPT_PROVIDER_OPENAI_API_KEY", "", "vision-LLM key (OpenAI-compatible)", true],
  ["RECEIPT_PROVIDER_OPENAI_MODEL", "gpt-4o", "vision model"],
  ["RECEIPT_PROVIDER_BASE_URL", "https://api.openai.com/v1", "vision endpoint base"],
  ["RECEIPT_OCR_TIMEOUT_MS", "45000", "per-image extraction timeout"],
  ["CRM_PROVIDER", "none", "none | webhook (generic contract; use scripts/crm-receiver.mjs locally)"],
  ["CRM_WEBHOOK_URL", "", "CRM endpoint base (POST /events, GET /records/:type/:key, GET /health)"],
  ["CRM_WEBHOOK_TOKEN", "", "bearer for the CRM endpoint", true],
  ["CRM_TIMEOUT_MS", "10000", "CRM call timeout"],
  ["DRAW_RANDOM_BYTES", "32", "CSPRNG seed length committed at freeze"],
  ["RETENTION_RAW_RECEIPTS_DAYS", "90", "raw receipt image retention (D-22 pending)"],
  ["RETENTION_FACTS_DAYS", "180", "extracted facts retention (D-22 pending)"],
  ["AI_PROVIDER", "none", "legacy desk AI wrapper (optional)"],
  ["AI_PROVIDER_API_KEY", "", "legacy desk AI key", true],
  ["AI_MONTHLY_BUDGET_USD", "0", "legacy desk AI budget"],
  ["LOG_LEVEL", "info", "log level"],
];

export function loadConfig(env = process.env) {
  const abs = (p) => (p === ":memory:" || path.isAbsolute(p) ? p : path.join(ROOT, p));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  const railwayPaths = onRailway ? { database: "/app/data/promotions.db", mediaDir: "/app/data/media" } : null;
  const environment = env.ENVIRONMENT || (onRailway ? "staging" : "local");
  return {
    onRailway, environment,
    host: env.HOST || (onRailway ? "0.0.0.0" : "127.0.0.1"),
    port: num(env.PORT, 5191),
    database: abs(env.DATABASE || railwayPaths?.database || "./data/promotions.db"),
    mediaDir: abs(env.MEDIA_DIR || railwayPaths?.mediaDir || "./data/media"),
    logLevel: env.LOG_LEVEL || "info",
    adminEmail: (env.ADMIN_EMAIL || "admin@example.com").toLowerCase().trim(),
    adminPassword: env.ADMIN_PASSWORD || (environment === "local" ? "change-me-now-local" : null),
    identityKey: env.IDENTITY_KEY || (environment === "local" ? "dev-only-key" : ""),
    auditCheckpointKey: env.AUDIT_CHECKPOINT_KEY || "",
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || "263",
    whatsappTransport: env.WHATSAPP_TRANSPORT || "simulator",
    meta: { apiVersion: env.META_API_VERSION || "v21.0", phoneNumberId: env.META_PHONE_NUMBER_ID || "", wabaId: env.META_WABA_ID || "", appId: env.META_APP_ID || "", appSecret: env.META_APP_SECRET || "", accessToken: env.META_ACCESS_TOKEN || "" },
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    webhookToken: env.WHATSAPP_WEBHOOK_TOKEN || "",
    baileysAuthDir: abs(env.BAILEYS_AUTH_DIR || "./data/baileys"),
    receiptExtractor: env.RECEIPT_EXTRACTOR || "tesseract",
    receipt: { openaiApiKey: env.RECEIPT_PROVIDER_OPENAI_API_KEY || "", openaiModel: env.RECEIPT_PROVIDER_OPENAI_MODEL || "gpt-4o", baseUrl: env.RECEIPT_PROVIDER_BASE_URL || "https://api.openai.com/v1", timeoutMs: num(env.RECEIPT_OCR_TIMEOUT_MS, 45_000) },
    ai: { provider: env.AI_PROVIDER || "none", openaiKey: env.OPENAI_API_KEY || env.AI_PROVIDER_API_KEY || "", openaiModel: env.OPENAI_MODEL || env.AI_MODEL || "gpt-4o-mini", baseUrl: env.AI_PROVIDER_BASE_URL || "https://api.openai.com/v1", model: env.AI_MODEL || "", monthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD, 0) },
    crm: { provider: env.CRM_PROVIDER || "none", webhookUrl: env.CRM_WEBHOOK_URL || "", webhookToken: env.CRM_WEBHOOK_TOKEN || "", timeoutMs: num(env.CRM_TIMEOUT_MS, 10_000) },
    drawRandomBytes: num(env.DRAW_RANDOM_BYTES, 32),
    retention: { rawReceiptsDays: num(env.RETENTION_RAW_RECEIPTS_DAYS, 90), factsDays: num(env.RETENTION_FACTS_DAYS, 180) },
  };
}

/** Fail-fast checks for non-local environments (called by the server). */
export function validateConfig(cfg) {
  const problems = [];
  if (cfg.environment !== "local") {
    if (!cfg.adminPassword || cfg.adminPassword.length < 12) problems.push("ADMIN_PASSWORD must be set (>=12 chars) outside local");
    if (!cfg.identityKey || cfg.identityKey === "dev-only-key") problems.push("IDENTITY_KEY must be set outside local");
    if (cfg.receiptExtractor === "simulator" && cfg.environment === "production") problems.push("RECEIPT_EXTRACTOR=simulator is forbidden in production");
    if (cfg.whatsappTransport === "linked-device" && cfg.environment === "production") problems.push("linked-device transport is forbidden in production");
  }
  if (cfg.whatsappTransport === "cloud-api" && (!cfg.meta.accessToken || !cfg.meta.appSecret || !cfg.webhookToken)) problems.push("cloud-api transport requires META_ACCESS_TOKEN, META_APP_SECRET, WHATSAPP_WEBHOOK_TOKEN");
  return problems;
}

export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
