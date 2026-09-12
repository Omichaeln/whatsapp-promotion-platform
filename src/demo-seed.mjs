import fs from "node:fs";
import path from "node:path";
import { migrate, id, nowIso } from "./db.mjs";
import { createDomain } from "./services.mjs";
import { ROOT } from "./config.mjs";
import { DECISION_IDS } from "./activation.mjs";

/**
 * TEST ONLY — SAMPLE PROMOTION seed (spec §5, §19). Everything here is
 * fictional and editable in the console; nothing counts as client sign-off.
 * Idempotent: returns early when the sample campaign exists (use --force via
 * scripts/reset-sample.mjs to rebuild). Dates are relative to a seed clock
 * (default: now) so the same seed replays deterministically with SEED_CLOCK.
 */
export const SAMPLE_CODE = "SAMPLE-BROWN-SUGAR";
const RETAILERS = [["Sunrise Supermarket", "SUN"], ["Valuemart", "VAL"], ["Kwikshop Express", "KWK"], ["Greenfield Stores", "GRN"], ["Metro Cash & Carry", "MET"], ["Corner Choice", "CNR"], ["Family Foods", "FAM"], ["Savers Market", "SAV"]];
const TOWNS = [["Harare", "HRE", "Harare"], ["Bulawayo", "BYO", "Bulawayo"], ["Mutare", "MUT", "Manicaland"], ["Gweru", "GWE", "Midlands"], ["Masvingo", "MSV", "Masvingo"], ["Kwekwe", "KWE", "Midlands"], ["Chinhoyi", "CHI", "Mashonaland West"], ["Marondera", "MAR", "Mashonaland East"], ["Bindura", "BIN", "Mashonaland Central"], ["Victoria Falls", "VFA", "Matabeleland North"]];
const BRANCHES = ["Westgate", "Eastgate", "Central", "Avondale", "Borrowdale", "Hillside", "Main Street", "Market Square", "Station Road", "Riverside"];

export function sampleOutlets() {
  // exactly 80: 8 retailers x 10 towns; branch names repeat across retailers/towns on purpose (ambiguity test)
  const out = [];
  RETAILERS.forEach(([retailer, rc], ri) => TOWNS.forEach(([town, tc, province], ti) => {
    // the three Harare outlets used by the receipt fixtures/benchmark are all "Westgate" (same branch name, different retailers)
    const branch = ti === 0 && ri < 3 ? "Westgate" : BRANCHES[(ri + ti) % BRANCHES.length];
    out.push({ outlet_code: `${rc}-${tc}-${String(ti + 1).padStart(2, "0")}`, retailer, branch, town, province, retailer_code: "TEST", collection_enabled: (ri + ti) % 3 === 0 ? 1 : 0, aliases: [`${retailer.split(" ")[0]} ${branch}`, ...(ri === 0 && ti === 0 ? ["sunrise westgate"] : [])] });
  }));
  return out;
}

/** The database records its own environment; that value, not a variable, decides. */
export function recordedEnvironment(db) {
  try { return db.prepare(`select value from schema_meta where key='environment'`).get()?.value || null; } catch { return null; }
}

/**
 * Sample data must never reach a production database.
 *
 * The callers used to guard on cfg.environment, which comes from the
 * ENVIRONMENT variable and falls back to "staging" on Railway when the variable
 * is missing or mistyped. A renamed variable on a redeploy was therefore enough
 * to seed the TEST ONLY campaign — active, with 80 TEST outlets and seven staff
 * logins whose temporary passwords are printed in the deploy log, including both
 * halves of the draw separation of duties — into the live database. The
 * conversation picks the most recently created active campaign, so real
 * consumers would have been served the sample promotion.
 */
export function refuseSampleDataInProduction(db, what) {
  if (recordedEnvironment(db) === "production") {
    throw Object.assign(new Error(`refusing to ${what}: this database is recorded as production`), { code: "FORBIDDEN" });
  }
}

export function ensureDemoSeed(db, { force = false, clock = process.env.SEED_CLOCK || null, log = console } = {}) {
  migrate(db, undefined, () => {});
  refuseSampleDataInProduction(db, "seed sample data");
  const domain = createDomain(db, process.env.IDENTITY_KEY || "dev-only-key");
  let campaign = domain.getCampaignByCode(SAMPLE_CODE);
  if (campaign && !force) return { campaign, seeded: false };
  const now = clock ? new Date(clock) : new Date();
  const day = 86400_000;
  // periods: W-2 and W-1 historical (closed), W0 current (open), W+1 scheduled; campaign spans them
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const start = new Date(monday.getTime() - 14 * day), end = new Date(monday.getTime() + 14 * day);

  if (!campaign) campaign = domain.createCampaign({ code: SAMPLE_CODE, name: "TEST ONLY — Sample Brown Sugar Promotion", startAt: start.toISOString(), endAt: end.toISOString(), timezone: "Africa/Harare", drawConfig: { prizes: [{ code: "P1", label: "TEST prize: USD 200 voucher", count: 2 }, { code: "P2", label: "TEST prize: USD 50 voucher", count: 3 }], alternates_per_winner: 1, one_prize_per_participant: true, winner_exclusion: "none" }, actorId: "seed" });
  const content = {
    terms_version: "TEST-T1", privacy_version: "TEST-P1", terms_url: "https://example.test/sample-terms (TEST ONLY placeholder)",
    prizes_text: "TEST ONLY: weekly draw of 2 x USD 200 vouchers and 3 x USD 50 vouchers (sample allocation, not approved).",
    prize_artwork_url: "", winner_template_name: "",
    mechanics: "TEST ONLY: buy at least 2 x 2kg packs of Goldcane Brown Sugar (fictional) in ONE purchase at a participating outlet, keep the receipt and send a clear photo here. One entry per qualifying receipt; enter as often as you like with different receipts.",
  };
  const rules = {
    products: [{ code: "GC-BS-2KG", name: "Goldcane Brown Sugar 2kg", aliases: ["goldcane brown sugar", "brown sugar 2kg", "gc brown sugar"], pack_grams: 2000, qualifying: true }, { code: "GC-BS-1KG", name: "Goldcane Brown Sugar 1kg", aliases: ["brown sugar 1kg"], pack_grams: 1000, qualifying: true }],
    primary_rule: { min_packs: 2, pack_grams: 2000, min_total_grams: 4000 }, allow_pack_combinations: false, award: { entries_per_receipt: 1 }, caps: { per_participant_per_period: null }, date_order: "DMY",
    // purchase window deliberately wider than the entry window so the committed
    // fixture receipts (dated October 2026) qualify while the seed clock moves
    purchase_window: { start: new Date(Math.min(start.getTime(), Date.UTC(2026, 8, 1))).toISOString(), end: new Date(Math.max(end.getTime() + 84 * day, Date.UTC(2026, 11, 31))).toISOString() },
  };
  const flags = { participant_status: true, registration: { identity_stage: "registration" } };
  const vid = domain.createVersion(campaign.id, { content, rules, flags }, "seed");
  domain.activateVersion(campaign.id, vid, "seed");
  if (campaign.status === "draft") domain.setCampaignStatus(campaign.id, "active", "seed", "TEST ONLY sample activation (non-production environment)");

  for (const [i, code] of ["W-2", "W-1", "W0", "W+1"].entries()) {
    const s = new Date(monday.getTime() + (i - 2) * 7 * day), e = new Date(s.getTime() + 7 * day);
    domain.upsertPeriod(campaign.id, { code, label: `Week ${i + 1} (${s.toISOString().slice(0, 10)} to ${new Date(e.getTime() - day).toISOString().slice(0, 10)})`, startsAt: s.toISOString(), endsAt: e.toISOString(), drawAt: new Date(e.getTime() + day).toISOString(), status: i < 2 ? "closed" : i === 2 ? "open" : "scheduled" }, "seed");
  }
  const outlets = sampleOutlets();
  const ids = outlets.map((o) => domain.upsertOutlet(o, "seed").id);
  domain.setCampaignOutlets(campaign.id, ids, "seed");
  domain.upsertProduct({ sku: "GC-BS-2KG", brand: "Goldcane (fictional)", name: "Goldcane Brown Sugar 2kg", aliases: rules.products[0].aliases, pack_grams: 2000 });
  domain.upsertProduct({ sku: "GC-BS-1KG", brand: "Goldcane (fictional)", name: "Goldcane Brown Sugar 1kg", aliases: rules.products[1].aliases, pack_grams: 1000 });
  domain.upsertProduct({ sku: "GC-WS-2KG", brand: "Goldcane (fictional)", name: "Goldcane White Sugar 2kg", aliases: ["white sugar"], pack_grams: 2000, active: 1 });

  const Q = {
    "D-01": ["Final campaign name and sponsoring brand", "TEST ONLY — Sample Brown Sugar Promotion / Goldcane (fictional)"],
    "D-02": ["Exact start/end, entry cutoff, draw and publication dates and timezone", `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}, weekly Monday 00:00 Africa/Harare cutoffs (seed clock relative)`],
    "D-03": ["Eight-week duration / calendar year / November end", "4 sample weeks relative to seed clock"],
    "D-04": ["Eligible country/regions/towns and outlet scope", "Default country code 263; 10 fictional towns"],
    "D-05": ["Qualifying brands, SKUs, receipt aliases and pack sizes", "GC-BS-2KG Goldcane Brown Sugar 2kg + aliases"],
    "D-06": ["Two 2kg packs specifically vs other combinations totalling 4kg", "Strict 2 x 2000g; allow_pack_combinations=false (selectable)"],
    "D-07": ["One entry per receipt vs quantity-based multiples", "entries_per_receipt=1"],
    "D-08": ["Participant/household/daily/weekly/campaign caps", "Unlimited additional unique receipts (per_participant_per_period=null)"],
    "D-09": ["Receipt dates, refunds, duplicate definition, photocopies/e-receipts", "Purchase window = campaign window; DMY dates; voided lines excluded; canonical key = outlet|date|number|total"],
    "D-10": ["Age, staff/supplier, household, prior-winner restrictions", "18+ declaration only; winner_exclusion=none"],
    "D-11": ["Identity number at registration or only from winners", "registration (identity_stage=registration), encrypted + masked"],
    "D-12": ["Meaning of location field", "Town/city free text at registration"],
    "D-13": ["Approved outlet master and prize collection locations", "80 fictional branches; collection flag on ~1/3"],
    "D-14": ["Uncertain receipt handling, review target and pending-at-cutoff policy", "24h review SLA target (test); draw freeze blocked until on-time submissions resolved"],
    "D-15": ["Participant count only or full submission status/history", "participant_status=true (counts + last 3 references)"],
    "D-16": ["Winners/alternates per period, prizes, repeat-winner restrictions", "2 x P1 + 3 x P2 per week, 1 alternate per winner, one prize per participant per draw"],
    "D-17": ["Winner verification, deadlines, collection proof, replacement rules", "7-day claim deadline; verified->accepted->collected at a collection outlet; alternates promoted on expiry"],
    "D-18": ["Permitted published winner fields and timing", "First name + initial, town, prize, week; after verification and explicit publication"],
    "D-19": ["CRM product, fields, access, sandbox and launch priority", "Generic webhook contract + local contract receiver; vendor not selected"],
    "D-20": ["Languages, support hours, escalation contacts, accessibility", "English only; support handoff via SUPPORT keyword; test owner: ops@example.test"],
    "D-21": ["Registrations, entry volume, peaks, operating/service targets", "Engineering benchmark: 5k registrations, 20k receipts, 200/h peak (declared, not client-supplied)"],
    "D-22": ["Data retention/deletion, hosting and processor constraints", "raw receipts 90d, facts 180d (env), SQLite on Railway volume; processors: WhatsApp, hosting"],
  };
  for (const d of DECISION_IDS) domain.upsertDecision(campaign.id, { decision_id: d, question: Q[d][0], test_value: Q[d][1], status: "open", owner: "client", blocks_activation: 1 }, "seed");
  domain.setSetting("sample_data", { seeded_at: nowIso(), seed_clock: now.toISOString(), campaign: SAMPLE_CODE, note: "TEST ONLY sample data present" }, "seed");
  log?.log?.(`[seed] ${SAMPLE_CODE}: 80 outlets, 4 periods, 22 decisions (TEST ONLY)`);
  return { campaign: domain.getCampaign(campaign.id), seeded: true, versionId: vid, outletCount: ids.length, periods: domain.listPeriods(campaign.id) };
}

/** Sample staff accounts (non-production only). Returns temporary passwords once, to stdout, never stored. */
export function ensureSampleStaff(auth, { db = null, log = console } = {}) {
  if (db) refuseSampleDataInProduction(db, "create sample staff accounts");
  const wanted = [["manager@example.test", "Sample Campaign Manager", ["campaign_manager"]], ["reviewer@example.test", "Sample Reviewer", ["reviewer"]], ["support@example.test", "Sample Support", ["support"]], ["draw@example.test", "Sample Draw Officer", ["draw_officer"]], ["approver@example.test", "Sample Draw Approver", ["draw_approver", "auditor"]], ["fulfilment@example.test", "Sample Fulfilment", ["winner_ops"]], ["auditor@example.test", "Sample Auditor", ["auditor"]]];
  const created = [];
  for (const [email, name, roles] of wanted) {
    if (auth.listUsers().some((u) => u.email === email)) continue;
    const r = auth.createUser({ email, name, roles, createdBy: "seed", mustChangePassword: true });
    created.push({ email, roles, temporaryPassword: r.temporaryPassword });
  }
  if (created.length) log?.log?.(`[seed] created ${created.length} sample staff accounts (temporary passwords printed once by scripts/seed-demo.mjs)`);
  return created;
}

/** Load a fixture image (used by the populated seed and tests). */
export function fixtureBytes(name) { return fs.readFileSync(path.join(ROOT, "fixtures", "receipts", name.endsWith(".jpg") ? name : `${name}.jpg`)); }
export { id };
