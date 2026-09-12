// Console fixes (package: console).
//
// The console is JSX and the repo has no browser test runner, so these tests
// bundle src/web-console/src/App.jsx with esbuild against a tiny React stand-in
// (element factory + hooks) and drive the real components: render, type into a
// field, press a button. Everything below the component is real — api.js, the
// HTTP calls, and (unless a route is stubbed) the live server from
// test/helpers.mjs, so a console action lands in the actual database.
import { before, after, describe, it, assert, buildApp } from "./helpers.mjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// WPP_CONSOLE_SRC lets the same suite be pointed at another copy of the console
// source — how each test below was shown to fail against the pre-fix App.jsx.
const CONSOLE_SRC = path.join(HERE, "..", "src", "web-console", "src");
const WEB = process.env.WPP_CONSOLE_SRC || CONSOLE_SRC;

/* ---------------------------------------------------------------- harness */

const SHIM = `
export let CUR = null;
export function __setHooks(x) { CUR = x; }
export function h(type, props, ...kids) { const p = { ...(props || {}) }; if (kids.length) p.children = kids.length === 1 ? kids[0] : kids; return { type, props: p }; }
export const Fragment = Symbol.for("test.fragment");
export const useState = (i) => CUR.useState(i);
export const useEffect = (f, d) => CUR.useEffect(f, d);
export const useCallback = (f, d) => CUR.useCallback(f, d);
export const useMemo = (f, d) => CUR.useMemo(f, d);
export const useRef = (v) => CUR.useRef(v);
`;

/** Bundle App.jsx once, exposing the internal components the tests drive. */
async function bundleConsole() {
  const esbuild = createRequire(path.join(CONSOLE_SRC, "noop.js"))("esbuild");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpp-console-"));
  const shim = path.join(dir, "react-shim.mjs");
  fs.writeFileSync(shim, SHIM);
  // `typeof x === "function" ? x : null` so the bundle still builds against a
  // tree where a component this package adds does not exist yet.
  const names = ["Activation", "Draws", "Outlets", "CampaignOutlets", "Readiness", "Winners", "AuditView", "ReceiptDetail", "ParticipantDetail"];
  const optional = ["Support", "EvidenceRow"];
  const tail = `\nexport const __ui = { TABS, VIEWS, ${names.map((n) => `${n}: typeof ${n} === "function" ? ${n} : null`).join(", ")}, ${optional.map((n) => `${n}: typeof ${n} === "function" ? ${n} : null`).join(", ")} };\n`;
  const plugin = {
    name: "console-test",
    setup(b) {
      b.onResolve({ filter: /\.css$/ }, () => ({ path: "css", namespace: "stub" }));
      b.onResolve({ filter: /desk\/Desk\.jsx$/ }, () => ({ path: "desk", namespace: "stub" }));
      b.onResolve({ filter: /^react$/ }, () => ({ path: shim }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.path === "desk" ? "export const Desk = () => null;" : "", loader: "js" }));
      b.onLoad({ filter: /App\.jsx$/ }, (a) => ({ contents: fs.readFileSync(a.path, "utf8") + tail, loader: "jsx", resolveDir: path.dirname(a.path) }));
    },
  };
  const out = await esbuild.build({
    stdin: { contents: `export * from "./App.jsx"; export { h, __setHooks } from ${JSON.stringify(shim)};`, resolveDir: WEB, loader: "js" },
    bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
    jsx: "transform", jsxFactory: "h", jsxFragment: "Fragment", inject: [shim], plugins: [plugin],
  });
  const file = path.join(dir, "console.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  return { mod: await import(file), dir };
}

/** Minimal React: renders function components depth-first and keeps hook state. */
function createRenderer(mod) {
  const store = new Map();
  let dirty = false, queue = [];
  const hooks = (key) => {
    const st = store.get(key) || { cells: [] };
    st.i = 0; store.set(key, st);
    return {
      useState(init) {
        const i = st.i++;
        if (!(i in st.cells)) st.cells[i] = { v: typeof init === "function" ? init() : init };
        const cell = st.cells[i];
        return [cell.v, (nv) => { const v = typeof nv === "function" ? nv(cell.v) : nv; if (!Object.is(v, cell.v)) { cell.v = v; dirty = true; } }];
      },
      useEffect(fn, deps) {
        const i = st.i++; const prev = st.cells[i];
        const same = prev && prev.deps && deps && prev.deps.length === deps.length && prev.deps.every((d, j) => Object.is(d, deps[j]));
        if (!same) { st.cells[i] = { deps }; queue.push(fn); }
      },
      useCallback(fn) { st.i++; return fn; },
      useMemo(fn) { const i = st.i++; st.cells[i] = { v: fn() }; return st.cells[i].v; },
      useRef(v) { const i = st.i++; if (!(i in st.cells)) st.cells[i] = { v: { current: v } }; return st.cells[i].v; },
    };
  };
  const renderEl = (el, key) => {
    if (el == null || el === false || el === true) return null;
    if (Array.isArray(el)) return el.map((c, i) => renderEl(c, `${key}[${i}]`));
    if (typeof el !== "object") return el;
    if (typeof el.type === "function") {
      const k = `${key}/${el.type.name || "anon"}${el.props?.key != null ? `#${el.props.key}` : ""}`;
      mod.__setHooks(hooks(k));
      let out;
      try { out = el.type(el.props || {}); } finally { mod.__setHooks(null); }
      return { comp: el.type.name || "anon", props: el.props || {}, child: renderEl(out, k) };
    }
    const tag = typeof el.type === "symbol" ? "#fragment" : el.type;
    return { tag, props: el.props || {}, child: renderEl(el.props?.children, `${key}<${tag}>`) };
  };
  return async function flush(el) {
    let tree = null;
    for (let pass = 0; pass < 25; pass++) {
      dirty = false; queue = [];
      tree = renderEl(el, "root");
      const effects = queue; queue = [];
      for (const fn of effects) { try { fn(); } catch { /* cleanup-free shim */ } }
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
      if (!dirty) break;
    }
    return tree;
  };
}

const walk = (node, fn, out = []) => {
  if (node == null || node === false || node === true) return out;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn, out); return out; }
  if (typeof node !== "object") { fn(node, out); return out; }
  fn(node, out); walk(node.child, fn, out); return out;
};
const textOf = (n) => walk(n, (x, o) => { if (typeof x === "string" || typeof x === "number") o.push(String(x)); }).join(" ");
const hostsOf = (n, tag) => walk(n, (x, o) => { if (x && typeof x === "object" && x.tag === tag) o.push(x); });
const compsOf = (n, name) => walk(n, (x, o) => { if (x && typeof x === "object" && x.comp === name) o.push(x); });
const fieldNamed = (n, label) => compsOf(n, "Field").find((f) => String(f.props.label || "").toLowerCase().includes(label.toLowerCase()));
const buttonNamed = (n, label) => hostsOf(n, "button").find((b) => textOf(b).toLowerCase().includes(label.toLowerCase()));
const inputWithPlaceholder = (n, ph) => [...hostsOf(n, "input"), ...hostsOf(n, "textarea")].find((i) => String(i.props.placeholder || "").toLowerCase().includes(ph.toLowerCase()));

/**
 * Mounts a console component. `stub(method, path, body)` may answer a request
 * itself; anything it does not answer goes to the live test server.
 */
function mountConsole(mod, { base, token = "", stub = null, confirm = true, prompts = null } = {}) {
  const flush = createRenderer(mod);
  const calls = [];
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, window: globalThis.window, alert: globalThis.alert, prompt: globalThis.prompt };
  globalThis.localStorage = { getItem: () => token, setItem: () => {}, removeItem: () => {} };
  globalThis.window = { confirm: () => confirm, open: () => {} };
  globalThis.alert = () => {};
  // Structured input must not come from prompt() — except on the two
  // entry controls that deliberately mirror each other (Disqualify /
  // Reinstate), where a test opts in by naming the answers it gives.
  globalThis.prompt = (q) => {
    if (!prompts) throw new Error("the console must not ask for structured input with prompt()");
    const hit = Object.keys(prompts).find((k) => String(q || "").toLowerCase().includes(k.toLowerCase()));
    if (hit === undefined) throw new Error(`unexpected prompt: ${q}`);
    return prompts[hit];
  };
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    const method = opts.method || "GET";
    calls.push({ method, url: String(url), body });
    const stubbed = stub?.(method, String(url), body);
    if (stubbed) return { ok: stubbed.status ? stubbed.status < 400 : true, status: stubbed.status || 200, json: async () => stubbed.data ?? {}, blob: async () => new Blob([]) };
    return saved.fetch(base + String(url), opts);
  };
  let element = null;
  const ui = {
    calls,
    async render(Component, props) { element = mod.h(Component, props); ui.tree = await flush(element); return ui.tree; },
    async again() { ui.tree = await flush(element); return ui.tree; },
    text() { return textOf(ui.tree); },
    /** Type into the input inside the Field whose label contains `label`. */
    async type(label, value) {
      const f = fieldNamed(ui.tree, label);
      assert.ok(f, `no field labelled "${label}" — fields: ${compsOf(ui.tree, "Field").map((x) => x.props.label).join(" | ")}`);
      const input = hostsOf(f, "input")[0] || hostsOf(f, "textarea")[0] || hostsOf(f, "select")[0];
      assert.ok(input?.props?.onChange, `field "${label}" has no editable control`);
      input.props.onChange({ target: { value } });
      return ui.again();
    },
    async typePlaceholder(ph, value) {
      const input = inputWithPlaceholder(ui.tree, ph);
      assert.ok(input, `no input with placeholder ~"${ph}"`);
      input.props.onChange({ target: { value } });
      return ui.again();
    },
    button(label) { return buttonNamed(ui.tree, label); },
    async click(label) {
      const b = buttonNamed(ui.tree, label);
      assert.ok(b, `no button labelled "${label}" — buttons: ${hostsOf(ui.tree, "button").map((x) => textOf(x)).join(" | ")}`);
      assert.ok(!b.props.disabled, `button "${label}" is disabled`);
      await b.props.onClick({ preventDefault() {} });
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
      return ui.again();
    },
    select(label) {
      const f = fieldNamed(ui.tree, label);
      return f ? hostsOf(f, "select")[0] : null;
    },
    async choose(label, value) {
      const s = ui.select(label);
      assert.ok(s, `no select labelled "${label}"`);
      s.props.onChange({ target: { value } });
      return ui.again();
    },
    restore() { Object.assign(globalThis, saved); },
  };
  return ui;
}

/* ------------------------------------------------------------------ suite */

let h, mod, me = {};
before(async () => {
  ({ mod } = await bundleConsole());
  h = await buildApp();
  for (const email of ["manager@example.test", "reviewer@example.test", "support@example.test", "draw@example.test", "auditor@example.test", "fulfilment@example.test"]) {
    const token = await h.staffToken(email);
    const who = await h.api("/api/whoami", { token });
    me[email] = { token, me: who.data };
  }
});
after(async () => { await h?.close(); });

const as = (email, opts = {}) => mountConsole(mod, { base: h.base, token: me[email].token, ...opts });

describe("console-2 — a forbidden sub-tab must not take the console down", () => {
  it("Activation renders the error instead of throwing on a 403", async () => {
    const ui = as("reviewer@example.test");
    try {
      const tree = await ui.render(mod.__ui.Activation, { id: h.campaign.id });
      const text = textOf(tree);
      assert.match(text, /campaign_manager|HTTP 403/, "the 403 should be shown to the operator");
      assert.doesNotMatch(text, /READY|blocking in/, "no preflight verdict may be rendered from absent data");
    } finally { ui.restore(); }
  });
});

describe("console-4 — Draws must follow the server's current-campaign rule", () => {
  it("targets the newest active campaign, not the oldest one, and offers a selector", async () => {
    const mgr = me["manager@example.test"].token;
    const created = await h.api("/api/campaigns", { method: "POST", token: mgr, body: { code: "SUGAR-2027", name: "Real campaign", start_at: "2027-01-04T00:00:00Z", end_at: "2027-03-01T00:00:00Z" } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const realId = created.data.campaign?.id || created.data.id;
    // Both campaigns live; the sample one was created first.
    h.db.prepare(`update campaigns set status='active' where id=?`).run(realId);
    h.db.prepare(`update campaigns set status='closed' where id=?`).run(h.campaign.id);

    const ui = as("draw@example.test");
    try {
      await ui.render(mod.__ui.Draws, { me: me["draw@example.test"].me });
      const targeted = ui.calls.filter((c) => c.url.includes("/periods") || c.url.includes("/draws"));
      assert.ok(targeted.length, "the draws view must load periods/draws for a campaign");
      assert.ok(targeted.every((c) => c.url.includes(realId)), `draws calls must target the live campaign, got ${targeted.map((c) => c.url).join(", ")}`);

      const sel = ui.select("Campaign");
      assert.ok(sel, "the Draws view needs a campaign selector");
      const options = hostsOf(sel, "option").map((o) => o.props.value);
      assert.ok(options.includes(h.campaign.id) && options.includes(realId), "every campaign must be selectable");

      await ui.choose("Campaign", h.campaign.id);
      assert.ok(ui.calls.some((c) => c.url.includes(h.campaign.id) && c.url.includes("/periods")), "choosing a campaign must re-target the draws calls");
    } finally {
      ui.restore();
      h.db.prepare(`update campaigns set status='active' where id=?`).run(h.campaign.id);
      h.db.prepare(`update campaigns set status='archived' where id=?`).run(realId);
    }
  });
});

describe("console-3 — the outlet master form must not wipe what it cannot show", () => {
  it("keeps aliases, collection flag and active window when only the text fields are edited", async () => {
    const code = "SUN-BYO-02";
    h.db.prepare(`update outlets set collection_enabled=0, active=0, active_to='2026-01-01', aliases_json=? where outlet_code=?`).run(JSON.stringify(["Sunrise Eastgate"]), code);
    const before = h.db.prepare(`select * from outlets where outlet_code=?`).get(code);
    assert.ok(before, "fixture outlet missing");

    const ui = as("manager@example.test");
    try {
      await ui.render(mod.__ui.Outlets, {});
      await ui.type("Code", code);
      await ui.type("Retailer", before.retailer);
      await ui.type("Branch", "Eastgate (Mall)");
      await ui.type("Town", before.town);
      await ui.type("Province", before.province || "");
      await ui.click("Save");
      const after = h.db.prepare(`select * from outlets where outlet_code=?`).get(code);
      assert.equal(after.branch, "Eastgate (Mall)", "the edit the operator asked for must be applied");
      assert.equal(after.collection_enabled, 0, "a non-collection branch must not become a prize collection point");
      assert.equal(after.active, 0, "a closed branch must not be reactivated into the consumer's outlet menu");
      assert.equal(after.active_to, "2026-01-01", "the active window must survive a name correction");
      assert.deepEqual(JSON.parse(after.aliases_json), ["Sunrise Eastgate"], "OCR aliases must survive a name correction");
    } finally { ui.restore(); }
  });
});

describe("console-8 — operator actions that only existed as API routes", () => {
  it("Readiness records go-live evidence (was: curl only)", async () => {
    const ui = as("manager@example.test");
    try {
      await ui.render(mod.__ui.Readiness, { me: me["manager@example.test"].me });
      const row = compsOf(ui.tree, "EvidenceRow").find((r) => r.props.kind === "client_uat_signoff");
      assert.ok(row, "the readiness evidence table needs a control that records the evidence");
      const input = inputWithPlaceholder(row, "what was accepted");
      assert.ok(input, "recording evidence needs a note");
      input.props.onChange({ target: { value: "UAT signed off by the client on 12 Sep" } });
      await ui.again();
      const row2 = compsOf(ui.tree, "EvidenceRow").find((r) => r.props.kind === "client_uat_signoff");
      const record = buttonNamed(row2, "Record");
      assert.ok(record && !record.props.disabled, "Record must be enabled once a note is given");
      await record.props.onClick({ preventDefault() {} });
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
      const v = h.domain.getSetting("evidence.client_uat_signoff", null);
      assert.ok(v, "POST /api/evidence/client_uat_signoff must have been made");
      assert.equal(v.note, "UAT signed off by the client on 12 Sep");
    } finally { ui.restore(); }
  });

  it("a campaign outlet can be removed from the console", async () => {
    const rows = h.db.prepare(`select o.outlet_code, o.id from campaign_outlets co join outlets o on o.id=co.outlet_id where co.campaign_id=? and o.active=1 order by o.outlet_code`).all(h.campaign.id);
    assert.ok(rows.length > 2, "sample campaign should have outlets");
    const victim = rows[0], keeper = rows[1];
    const ui = as("manager@example.test");
    try {
      await ui.render(mod.__ui.CampaignOutlets, { id: h.campaign.id, data: {}, me: me["manager@example.test"].me, onChange: () => {} });
      const tr = hostsOf(ui.tree, "tr").find((r) => textOf(r).includes(victim.outlet_code));
      assert.ok(tr, "the outlet should be listed");
      const remove = buttonNamed(tr, "Remove");
      assert.ok(remove, "there must be a console action that removes an outlet from a campaign");
      await remove.props.onClick({ preventDefault() {} });
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
      const now = h.db.prepare(`select outlet_id from campaign_outlets where campaign_id=?`).all(h.campaign.id).map((r) => r.outlet_id);
      assert.ok(!now.includes(victim.id), "the removed outlet must be gone from the campaign");
      assert.ok(now.includes(keeper.id), "the other outlets must stay in the campaign");
    } finally { ui.restore(); }
  });

  it("support can change a participant's phone number from the console", async () => {
    const phone = "263770000771";
    await h.register(phone, { first: "Rudo", last: "Moyo" });
    const p = h.db.prepare(`select * from participants where wa_phone_uid=?`).get(phone);
    assert.ok(p, "participant should be registered");
    const ui = as("support@example.test");
    try {
      await ui.render(mod.__ui.ParticipantDetail, { id: p.id, me: me["support@example.test"].me, onBack: () => {} });
      await ui.click("Change phone");
      await ui.type("New WhatsApp number", "263770000772");
      await ui.type("Reason", "SIM swap confirmed with ID");
      await ui.click("Save");
      const moved = h.db.prepare(`select wa_phone_uid from participants where id=?`).get(p.id);
      assert.equal(moved.wa_phone_uid, "263770000772");
    } finally { ui.restore(); }
  });
});

describe("console-1 — support handoff has a console surface", () => {
  it("release from the console unblocks a participant pinned to the support queue", async () => {
    const phone = "263770000123";
    await h.register(phone);
    await h.say(phone, "support");
    const pinned = h.db.prepare(`select handoff_owner from conversation_sessions where wa_phone_uid=?`).get(phone);
    assert.equal(pinned.handoff_owner, "queue", "typing support pins the conversation");
    const blocked = await h.say(phone, "2");
    assert.match(blocked.replies.join(" "), /team is handling/i, "the participant is locked out while pinned");

    const ui = as("support@example.test");
    try {
      assert.ok(mod.__ui.Support, "the console needs a support/conversations surface");
      await ui.render(mod.__ui.Support, { me: me["support@example.test"].me });
      await ui.typePlaceholder("number", phone);
      await ui.click("Open");
      assert.match(ui.text(), /waiting for an operator|claimed by/, "the handoff state must be visible");
      await ui.click("Release");
      const after = h.db.prepare(`select handoff_owner from conversation_sessions where wa_phone_uid=?`).get(phone);
      assert.equal(after.handoff_owner, null, "release must clear the handoff");
      const freed = await h.say(phone, "2");
      assert.doesNotMatch(freed.replies.join(" "), /team is handling/i, "the participant can enter again");
    } finally { ui.restore(); }
  });
});

describe("console-9 — winner claim steps", () => {
  const winner = (status, extra = {}) => ({ id: "win_1", draw_period: "W1", rank: 1, display_name: "T. N.", wa_phone_uid: "***0123", status, publication_state: "unpublished", row_version: 3, published_fields: { prize: "Hamper" }, participant: { first_name: "T", surname: "N", phone: "***0123" }, ...extra });
  const stubFor = (w, sent) => (method, url, body) => {
    if (url.startsWith("/api/winners?") || url === "/api/winners") return { data: { winners: [w] } };
    if (url === `/api/winners/${w.id}`) return { data: { winner: w, claims: [], messages: [] } };
    if (url.endsWith("/transition")) { sent.push(body); return { data: { winner: w } }; }
    if (url.endsWith("/publish")) { sent.push({ publish: true }); return { data: { winner: w } }; }
    return null; // /api/outlets falls through to the live server
  };

  it("verification evidence is required, not an escapable prompt", async () => {
    const sent = [];
    const ui = as("fulfilment@example.test", { stub: stubFor(winner("notified"), sent) });
    try {
      await ui.render(mod.__ui.Winners, { me: me["fulfilment@example.test"].me });
      await ui.click("Open");
      const b = ui.button("Mark verified");
      assert.ok(b, "the verified action should exist");
      assert.equal(!!b.props.disabled, true, "it must not be possible to record a verified winner with no ID-check evidence");
      await ui.type("Verification evidence", "ID 63-1234 checked by J. Moyo");
      await ui.click("Mark verified");
      assert.equal(sent.at(-1)?.note, "ID 63-1234 checked by J. Moyo");
    } finally { ui.restore(); }
  });

  it("the collection outlet is chosen from the real collection points", async () => {
    const sent = [];
    const ui = as("fulfilment@example.test", { stub: stubFor(winner("verified"), sent) });
    try {
      await ui.render(mod.__ui.Winners, { me: me["fulfilment@example.test"].me });
      await ui.click("Open");
      const sel = ui.select("Assign collection");
      assert.ok(sel, "the collection outlet must be picked from a list, not typed as an opaque id");
      const options = hostsOf(sel, "option").map((o) => o.props.value).filter(Boolean);
      const enabled = h.db.prepare(`select id from outlets where collection_enabled=1 and active=1`).all().map((r) => r.id);
      assert.ok(options.length > 1 && options.every((o) => enabled.includes(o)), "only collection-enabled outlets may be offered");
      assert.equal(!!ui.button("Accepted").props.disabled, true, "accepting without a collection point must be blocked");
      await ui.choose("Assign collection", options[0]);
      await ui.click("Accepted");
      assert.equal(sent.at(-1)?.collection_outlet_id, options[0]);
    } finally { ui.restore(); }
  });

  it("a campaign manager sees Publish, which the server grants them", async () => {
    const sent = [];
    const ui = as("manager@example.test", { stub: stubFor(winner("verified"), sent) });
    try {
      await ui.render(mod.__ui.Winners, { me: me["manager@example.test"].me });
      await ui.click("Open");
      assert.ok(ui.button("Publish"), "campaign_manager may publish winners server-side, so the button must render");
      await ui.click("Publish");
      assert.deepEqual(sent.at(-1), { publish: true });
    } finally { ui.restore(); }
  });
});

describe("console-7 — resend result is reachable by the role that holds it", () => {
  const receipt = { id: "rcpt_1", reference: "R-ABC", status: "QUALIFIED", row_version: 1, participant: { first_name: "T", surname: "N", phone: "***1" }, outlet: null };
  const stub = (method, url) => (url === `/api/receipts/${receipt.id}` ? { data: { receipt, validation: [], items: [], duplicates: [], attempts: [], media: null, review: null } } : null);
  const render = async (email) => {
    const ui = as(email, { stub });
    await ui.render(mod.__ui.ReceiptDetail, { id: receipt.id, me: me[email].me, onBack: () => {} });
    return ui;
  };
  it("support sees it on a qualified receipt", async () => {
    const ui = await render("support@example.test");
    try { assert.ok(ui.button("Resend result"), "the support role holds this action server-side"); } finally { ui.restore(); }
  });
  it("a reviewer does not", async () => {
    const ui = await render("reviewer@example.test");
    try { assert.ok(!ui.button("Resend result"), "the server refuses reviewers, so no button"); } finally { ui.restore(); }
  });
});

describe("console-6 — no integrity verdict from a response that never arrived", () => {
  it("a 403 on the audit check reports the failure instead of 'chain broken' plus a green attribution", async () => {
    const ui = as("manager@example.test");
    try {
      await ui.render(mod.__ui.AuditView, {});
      const text = ui.text();
      assert.doesNotMatch(text, /every event signs who acted/, "attribution was never computed, it must not be asserted");
      assert.doesNotMatch(text, /critical/, "the chain must not be reported broken because the check was refused");
      assert.match(text, /auditor|HTTP 403/, "the operator must be told why there is no verdict");
    } finally { ui.restore(); }
  });
  it("an auditor still gets the real verdict", async () => {
    const ui = as("auditor@example.test");
    try {
      await ui.render(mod.__ui.AuditView, {});
      const text = ui.text();
      assert.match(text, /verified/, "an intact chain must still verify");
      assert.match(text, /every event signs who acted/);
    } finally { ui.restore(); }
  });
});

describe("console shell", () => {
  it("exposes the support surface as a tab", () => {
    const keys = mod.__ui.TABS.map(([k]) => k);
    assert.ok(keys.includes("support"), `no support tab: ${keys.join(", ")}`);
    assert.ok(mod.__ui.VIEWS.support, "the support tab must be wired to a view");
  });
});

describe("dual-control reinstatement has to be reachable from the console", () => {
  // reinstateEntry refuses without an approver when the disqualification it
  // reverses was itself dual-controlled. The Reinstate control posted only a
  // reason, so every such entry was permanently stuck: the server asked for an
  // approver the product had no way to send. Disqualify already prompts for
  // one; Reinstate now mirrors it.
  let entryId;
  before(async () => {
    const phone = "263771970911";
    await h.register(phone, { first: "Dual", last: "Control", identity: "TESTDUAL01" });
    const r = await h.submit(phone, await h.simImage(h.simReceipt({ no: "911001" })), { outlet: "sunrise westgate harare" });
    assert.equal(r.receipt.status, "QUALIFIED");
    entryId = h.db.prepare(`select id from entries where receipt_id=?`).get(r.receiptId).id;
    const d = await h.api(`/api/entries/${entryId}/disqualify`, { token: me["manager@example.test"].token, method: "POST", body: { reason: "audit finding", approved_by: me["reviewer@example.test"].me.id } });
    assert.equal(d.status, 200, JSON.stringify(d.data));
  });

  it("the Reinstate control asks for an approver and sends it", async () => {
    const ui = as("manager@example.test", { prompts: { "reinstatement reason": "cleared on appeal", "approver user id": me["reviewer@example.test"].me.id } });
    try {
      await ui.render(mod.__ui.VIEWS.entries, { me: me["manager@example.test"].me });
      // open the trace for this entry, then reinstate
      const rows = hostsOf(ui.tree, "tr").filter((t) => textOf(t).includes(String(entryId).slice(0, 8)));
      assert.ok(rows.length, "the disqualified entry must be listed");
      await hostsOf(rows[0], "button")[0].props.onClick({ preventDefault() {} });
      await ui.again();
      await ui.click("Reinstate");
      const post = ui.calls.find((c) => c.method === "POST" && c.url.includes("/reinstate"));
      assert.ok(post, `no reinstate call: ${ui.calls.map((c) => `${c.method} ${c.url}`).join(" | ")}`);
      assert.equal(post.body.approved_by, me["reviewer@example.test"].me.id, "the approver the operator named must reach the server");
      assert.equal(h.db.prepare(`select status from entries where id=?`).get(entryId).status, "active", "and the entry must actually come back");
    } finally { ui.restore(); }
  });
});
