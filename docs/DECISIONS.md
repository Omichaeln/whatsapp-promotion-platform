# Client Decisions Register (D-01..D-20)

Status of every open decision from the launch spec. **Safe fail-closed default**
applies until the client (or legal/privacy owner) confirms otherwise. When a
decision changes, a new campaign version must be created and activated (never
edit an activated version).

| ID | Decision / input | Current safe default | Gate |
|---|---|---|---|
| D-01 | Campaign start/end/cutoff/draw dates + TZ | Demo campaign: rolling 7d–6w window, Africa/Harare, ISO weeks for draw periods | Before rule freeze |
| D-02 | Campaign name, brands, SKUs, aliases | `ZimSweet Brown Sugar` SKU `ZSB-2KG`, aliases in seed | Receipt rules |
| D-03 | Entry rule (2×2 kg vs 4 kg vs spend) | **2 × 2 kg packs OR 4 kg total** (`min_packs=2`, `min_total_qty_kg=4`) | Receipt rules |
| D-04 | Eligible receipt dates / outlet types / refunds / duplicates | Campaign window; outlet must be on master; duplicate = any prior used receipt | Rules |
| D-05 | Entrant age / exclusions | Age confirmed on registration (`age_confirmed`); no staff/supplier/household exclusions coded | Registration |
| D-06 | National ID number necessity | Optional; if provided AES-256-GCM encrypted + masked (`identity_enc`/`identity_masked`); full plaintext never stored | Privacy |
| D-07 | Location field | Free-text town/city at registration; outlet selection uses master codes | Registration |
| D-08 | Outlet master (stable IDs) | Demo: 10 outlets seeded (OK Mart, TM, Spar, Choppies, NTS); production list required | Data input |
| D-09 | Multiple entries per receipt / caps | One entry per receipt; `weekly_caps.participant=5` | Before ledger |
| D-10 | Participant entry count visible | **Off** (`flags.participant_status=false`); endpoint gated | Experience |
| D-11 | Weekly prize allocation / winner exclusion | Draw config: 3× `USD 200` voucher per week, alternates=2, no exclusion coded | Draw |
| D-12 | Winner publication fields + consent | Public view: masked phone tail, first name + initial, town; no full phone/national ID | Legal |
| D-13 | Winner verification / contact / collection | Claims workflow: notified→verified→accepted→collected (+expired/rejected/replaced) | Ops |
| D-14 | CRM provider + contract | `crm_sync_jobs` outbox ready; webhook adapter; CSV-style export fallback live (`/api/reports/export`) | Integration |
| D-15 | Languages / accessibility | English only currently; content separated for l10n | Content |
| D-16 | Reach / volume / media size | No estimate; 10 MB media cap; rate limits on login only | Capacity |
| D-17 | Named operators + reviewers + on-call | Admin bootstrap `ADMIN_EMAIL`/`ADMIN_PASSWORD`; roles documented | Ops input |
| D-18 | Retention / data location / processors | Env: receipts 90d, facts 180d; SQLite local / volume; no external processors beyond WhatsApp/AI(if key) | Governance |
| D-19 | Approved mechanics/terms/privacy/prize artwork | Versioned `content_json`; default copy in `conversation.mjs` | Content |
| D-20 | Meta business portfolio / WABA / number / templates | Not supplied; `cloud-api` transport stubbed with env contract; production blocked until supplied | Platform dep |

**Note:** this register is the single source of truth for open decisions. Any
implementation that depends on an unconfirmed value must use the safe default
above, be versioned per campaign, and must not auto-activate in production
without approval.