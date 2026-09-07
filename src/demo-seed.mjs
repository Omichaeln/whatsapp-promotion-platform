import { openDb, migrate } from "./db.mjs";
import { createDomain } from "./services.mjs";

/**
 * Demo campaign bootstrap (shared by scripts/seed-demo.mjs and the Railway
 * deploy entrypoint). Idempotent: creates the BROWN-SUGAR-2026 campaign with a
 * frozen rules version, 10 outlets and the qualifying product only when absent.
 * Safe fail-closed defaults for open client decisions (D-03: 2 x 2kg = 4kg).
 */
export function ensureDemoSeed(db, { force = false } = {}) {
  migrate(db, undefined, console.log);
  const domain = createDomain(db);

  let campaign = domain.listCampaigns().find((c) => c.code === "BROWN-SUGAR-2026");
  if (campaign && !force) {
    return { campaign, seeded: false };
  }
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const end = new Date(now.getTime() + 6 * 7 * 86400_000).toISOString();

  if (!campaign) {
    campaign = domain.createCampaign({
      code: "BROWN-SUGAR-2026",
      name: "Brown Sugar Winter Promo",
      startAt: start,
      endAt: end,
      drawConfig: { prizes: [{ code: "P1", label: "USD 200 shopping voucher", per_week: 3 }], alternates_per_winner: 2 },
    });
  }
  domain.setCampaignStatus(campaign.id, "active", "seed");

  const versionId = domain.createVersion(campaign.id, {
    content: {
      menu_home: "Welcome to the Brown Sugar Winter Promo! 1) Register 2) Enter 3) Mechanics 4) Terms 5) Prizes 6) Winners 7) Status 9) Help",
      mechanics: "Buy 2 x 2kg packs of ZimSweet Brown Sugar (4kg total) at any listed outlet, send a clear receipt photo, and earn one draw entry per qualifying receipt.",
      prizes: "Weekly prize: USD 200 shopping voucher (3 winners per week).",
      winners: "Weekly winners are published every Monday.",
    },
    rules: {
      products: [
        { sku: "ZSB-2KG", name: "ZimSweet Brown Sugar", aliases: ["brown sugar", "zimsweet"], pack_weight_kg: 2 },
      ],
      min_packs: 2,
      min_total_qty_kg: 4,
      currencies: ["USD"],
      weekly_caps: { participant: 5 },
      exclude_outlets: [],
    },
    flags: { participant_status: false }, // G-21 gated pending D-10
  });
  domain.activateVersion(campaign.id, versionId, "seed");

  const outlets = [
    ["OK-HRE-01", "OK Mart", "Westgate", "Harare", "Harare"],
    ["OK-HRE-02", "OK Mart", "Sam Levy Village", "Harare", "Harare"],
    ["TM-HRE-01", "TM Pick n Pay", "Avondale", "Harare", "Harare"],
    ["TM-HRE-02", "TM Pick n Pay", "Borrowdale", "Harare", "Harare"],
    ["SSC-BUL-01", "Spar", "Bulawayo Centre", "Bulawayo", "Bulawayo"],
    ["SSC-BUL-02", "Spar", "Ascot", "Bulawayo", "Bulawayo"],
    ["CHM-MUT-01", "Choppies", "Mutare", "Mutare", "Manicaland"],
    ["NTS-GWU-01", "NTS", "Gweru CBD", "Gweru", "Midlands"],
    ["SSC-KWE-01", "Spar", "Kwekwe", "Kwekwe", "Midlands"],
    ["TM-MAS-01", "TM Pick n Pay", "Masvingo", "Masvingo", "Masvingo"],
  ];
  for (const o of outlets) domain.upsertOutlet({ outlet_code: o[0], retailer: o[1], branch: o[2], town: o[3], province: o[4] });

  domain.upsertProduct({ sku: "ZSB-2KG", brand: "ZimSweet", name: "Brown Sugar 2kg", aliases: ["brown sugar", "zimsweet sugar"], pack_weight_kg: 2 });

  return { campaign, seeded: true, versionId, outletCount: domain.listOutlets().length };
}