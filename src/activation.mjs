import { defaultRules } from "./eligibility.mjs";

/**
 * Production activation validator (spec §5, T-36). Server-side, independent of
 * any UI flag. A campaign may go live in a production environment only when
 * every check passes; the same checks run for `setCampaignStatus('active')`
 * when the environment is production. In non-production environments the
 * validator still runs and reports, but only `environment` failures block —
 * the TEST ONLY campaign must remain usable for UAT.
 */
export const DECISION_IDS = ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08", "D-09", "D-10", "D-11", "D-12", "D-13", "D-14", "D-15", "D-16", "D-17", "D-18", "D-19", "D-20", "D-21", "D-22"];
const SAMPLE_MARKERS = /test only|sample promotion|fictional|goldcane|sunrise supermarket|valuemart|kwikshop/i;

/**
 * The CONTENT/RULES subset of the checks above, applied to a CANDIDATE version —
 * the draft about to be installed — instead of the campaign's active one.
 *
 * POST /api/campaigns/:id/versions/:vid/activate bypassed the activation gate
 * completely: a campaign that had passed every production check could have its
 * live rules replaced afterwards (primary_rule.min_packs = 1, terms_url dropped,
 * sample product aliases reintroduced) and nothing re-ran. validateActivation
 * cannot be reused as-is for two reasons: it reads the ACTIVE version, so it
 * would validate the version being REPLACED and pass while the swap loosens the
 * rules; and it also fails on TRANSPORT_HEALTH / EXTRACTOR / CRM / evidence,
 * none of which relate to the version being installed, so a legitimate
 * mid-campaign typo fix would be refused whenever a provider was briefly
 * unhealthy. This is deliberately only the four checks the version can break.
 */
export function validateVersionContentRules({ domain, campaignId, version }) {
  const f = [];
  const fail = (code, message) => f.push({ code, message, blocking: true });
  const campaign = domain.getCampaign(campaignId);
  if (!campaign) return { ok: false, failures: [{ code: "CAMPAIGN_NOT_FOUND", message: "campaign not found", blocking: true }] };
  let content = {}, rules = {};
  try { content = JSON.parse(version?.content_json || "{}"); } catch { fail("CONTENT_UNPARSEABLE", "version content is not valid JSON"); }
  try { rules = defaultRules(JSON.parse(version?.rules_json || "{}")); } catch { fail("RULES_UNPARSEABLE", "version rules are not valid JSON"); }
  if (SAMPLE_MARKERS.test(`${JSON.stringify(content)} ${JSON.stringify(rules.products || [])}`)) fail("SAMPLE_CONFIGURATION", "version content or products carry TEST ONLY / sample markers");
  if (!content.terms_url || !content.terms_version || !content.privacy_version) fail("CONTENT_TERMS", "terms_url, terms_version and privacy_version are required");
  if (!(rules.products || []).length) fail("RULES_PRODUCTS", "no qualifying products configured");
  if (!(JSON.parse(campaign.draw_config_json || "{}").prizes || []).length && !domain.listPeriods(campaignId).some((p) => (JSON.parse(p.prize_config_json || "{}").prizes || []).length)) fail("PRIZES_EMPTY", "no prize allocation configured");
  return { ok: f.length === 0, campaignId, versionId: version?.id || null, failures: f, checkedAt: new Date().toISOString() };
}

export async function validateActivation({ domain, auth, campaignId, cfg, extractor, transport, crm, db }) {
  const env = domain.environment();
  const production = env === "production";
  const f = [];
  const fail = (code, message, blocking = true, always = false) => f.push({ code, message, blocking: always ? true : (production ? blocking : false) });
  const campaign = domain.getCampaign(campaignId);
  if (!campaign) return { ok: false, environment: env, failures: [{ code: "CAMPAIGN_NOT_FOUND", message: "campaign not found", blocking: true }] };
  const version = domain.getActiveVersion(campaignId);
  if (!version) fail("NO_ACTIVE_VERSION", "no activated campaign version");
  const content = domain.versionContent(campaignId), rules = domain.versionRules(campaignId);

  // decisions register
  const decisions = domain.listDecisions(campaignId);
  for (const d of DECISION_IDS) {
    const row = decisions.find((x) => x.decision_id === d);
    if (!row) fail(`DECISION_MISSING_${d}`, `${d} is not in the register`);
    else if (row.blocks_activation && row.status !== "approved" && row.status !== "not_required") fail(`DECISION_OPEN_${d}`, `${d} (${row.question}) is ${row.status}`);
    else if (row.blocks_activation && row.status === "approved" && !row.approved_value) fail(`DECISION_NO_VALUE_${d}`, `${d} approved without an approved value`);
  }
  // sample/test configuration must not reach production
  if (SAMPLE_MARKERS.test(`${campaign.name} ${campaign.code} ${JSON.stringify(content)} ${JSON.stringify(rules.products || [])}`)) fail("SAMPLE_CONFIGURATION", "campaign name, content or products carry TEST ONLY / sample markers");
  if (!content.terms_url || !content.terms_version || !content.privacy_version) fail("CONTENT_TERMS", "terms_url, terms_version and privacy_version are required");
  if (!(rules.products || []).length) fail("RULES_PRODUCTS", "no qualifying products configured");
  const outlets = domain.listCampaignOutlets(campaignId);
  if (!outlets.length) fail("OUTLETS_EMPTY", "no participating outlets");
  if (outlets.some((o) => o.retailer_code === "TEST" || SAMPLE_MARKERS.test(o.retailer))) fail("OUTLETS_SAMPLE", "sample outlets present");
  if (!domain.listPeriods(campaignId).length) fail("PERIODS_EMPTY", "no draw periods configured");
  if (!(JSON.parse(campaign.draw_config_json || "{}").prizes || []).length && !domain.listPeriods(campaignId).some((p) => (JSON.parse(p.prize_config_json || "{}").prizes || []).length)) fail("PRIZES_EMPTY", "no prize allocation configured");
  // providers
  if (cfg.whatsappTransport !== "cloud-api") fail("TRANSPORT", `WhatsApp transport is "${cfg.whatsappTransport}" (production requires cloud-api)`);
  if (transport?.health && !(transport.health().ok)) fail("TRANSPORT_HEALTH", "WhatsApp transport unhealthy");
  const xh = extractor?.health ? await extractor.health() : { mode: "unconfigured", ok: false };
  if (xh.mode !== "real" || !xh.ok) fail("EXTRACTOR", `receipt extractor mode=${xh.mode} ok=${xh.ok}`);
  const crmDecision = decisions.find((x) => x.decision_id === "D-19");
  const ch = crm?.health ? await crm.health() : { mode: "not_configured" };
  if (ch.mode !== "configured" && !/post-launch|not required/i.test(String(crmDecision?.approved_value || ""))) fail("CRM", `CRM provider ${ch.mode}; approve D-19 as post-launch or configure the adapter`);
  // secrets and accounts
  if (!cfg.identityKey || cfg.identityKey === "dev-only-key") fail("IDENTITY_KEY", "IDENTITY_KEY is the development default");
  if (!cfg.auditCheckpointKey) fail("AUDIT_CHECKPOINT_KEY", "AUDIT_CHECKPOINT_KEY not set");
  if (!cfg.meta?.appSecret || !cfg.webhookToken) fail("WEBHOOK_SECRETS", "META_APP_SECRET / WHATSAPP_WEBHOOK_TOKEN missing");
  const users = auth?.listUsers ? auth.listUsers() : [];
  const withRole = (r) => users.filter((u) => u.status === "active" && JSON.parse(u.roles || "[]").includes(r));
  if (!withRole("draw_officer").length) fail("STAFF_DRAW_OFFICER", "no active draw officer");
  if (!withRole("draw_approver").some((u) => !withRole("draw_officer").some((o) => o.id === u.id))) fail("STAFF_APPROVER", "no active draw approver distinct from every draw officer");
  if (!withRole("reviewer").length) fail("STAFF_REVIEWER", "no active reviewer");
  if (users.some((u) => u.status === "active" && u.must_change_password)) fail("STAFF_TEMP_PASSWORDS", "some staff still use temporary passwords", false);
  if (users.some((u) => u.status === "active" && JSON.parse(u.roles || "[]").some((r) => ["draw_officer", "draw_approver", "platform_admin"].includes(r)) && !u.mfa_enabled)) fail("STAFF_MFA", "privileged staff without MFA");
  if (SAMPLE_MARKERS.test(users.map((u) => u.email).join(" ")) || users.some((u) => /@example\.test$|@x\.test$/.test(u.email))) fail("STAFF_SAMPLE", "sample staff accounts present");
  // test-only settings
  const allow = domain.getSetting("outbound.allowed_recipients", []);
  if (production && allow.length) fail("RECIPIENT_ALLOWLIST", "outbound recipient allowlist is set (test-only setting)");
  if (!content.winner_template_name) fail("WINNER_TEMPLATE", "approved winner-contact template name not configured (required outside the 24h window)");
  // evidence
  const bench = domain.getSetting("evidence.receipt_benchmark_accepted", null);
  if (!bench?.acceptedBy) fail("BENCHMARK_ACCEPTANCE", "client acceptance of the receipt benchmark not recorded");
  const restore = domain.getSetting("evidence.restore_rehearsal", null);
  if (!restore?.at) fail("RESTORE_REHEARSAL", "backup restore rehearsal not recorded");
  if (!domain.getSetting("evidence.client_uat_signoff", null)?.at) fail("CLIENT_UAT", "client UAT sign-off not recorded");
  if (env !== "production") fail("ENVIRONMENT", `environment is "${env}" — production activation is only possible in a production environment`, true, true);
  const blocking = f.filter((x) => x.blocking);
  return { ok: blocking.length === 0, environment: env, campaignId, failures: f, blockingCount: blocking.length, checkedAt: new Date().toISOString() };
}
