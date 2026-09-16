// Documentation-vs-code consistency.
//
// Every check here reads the CODE first and only then asserts what the
// documents are allowed to say about it. That way the suite fails when a
// document drifts from the system AND when the system is fixed but the
// document is left describing the old behaviour — the failure mode the audit
// found six times over (an operator following a runbook that describes a
// guarantee, a migration or a log line that does not exist).
import { describe, it, before, after, assert, buildApp, ROOT } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CONFIG_SCHEMA, loadConfig, validateConfig, dataVolumeStatus } from "../src/config.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const migrationFiles = () => fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const migrationNumber = (f) => Number(f.slice(0, 3));
const testSuiteFiles = () => fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs"));

/** git, or null when the command fails (non-zero exit included). */
const git = (args) => {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};

/**
 * The migration numbers a document accounts for, written either standalone
 * (`008`) or as a range (`008–011`). Deliberately narrow: only the zero-padded
 * three-digit form migrations are cited in, so `ADR-0007` and dates like
 * `09-12` cannot be mistaken for coverage.
 */
function coveredMigrationNumbers(text) {
  const set = new Set();
  for (const m of text.matchAll(/\b(0\d\d)\s*[–—-]\s*(0\d\d)\b/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) set.add(i);
  }
  for (const m of text.matchAll(/\b0\d\d\b/g)) set.add(Number(m[0]));
  return set;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const numberWord = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS.indexOf(s.toLowerCase()));

const loggingDocs = () => ({
  checklist: read("docs/release/production-checklist.md"),
  architecture: read("docs/architecture.md"),
  threat: read("docs/security/threat-model.md"),
  incident: read("docs/runbooks/incident-response.md"),
});

/**
 * docs-1 as a pure policy over (code state, documents), so BOTH directions can
 * be exercised. Round 2, problem 6: every docs-1 assertion used to sit inside
 * `if (gatedOnDebug)`, so the day the http/server owner takes the preferred code
 * fix (log at info with the path params redacted) the whole check would have
 * gone inert without failing, while five documents still told operators that
 * request logs exist only at LOG_LEVEL=debug and carry raw phone numbers.
 */
function loggingDocViolations({ gatedOnDebug, logsRawPath }, docs) {
  const v = [];
  const must = (ok, msg) => { if (!ok) v.push(msg); };
  if (gatedOnDebug) {
    must(/LOG_LEVEL=debug/.test(docs.checklist), "the checklist must say request logs exist only at LOG_LEVEL=debug");
    must(!/^- Structured request logs with correlation ids, metrics table, alerts with runbooks — verified;/m.test(docs.checklist), "the checklist must not report request logging as verified");
    must(/LOG_LEVEL=debug/.test(docs.incident), "incident response step 5 must not send a responder to logs that are not written");
  } else {
    // The router has an info-level sink now: no document may still send an
    // operator away from the default level to find request lines.
    must(!/no request lines are written at all/.test(docs.checklist), "the checklist still says the default level writes no request lines");
    must(!/written only at `LOG_LEVEL=debug`/.test(docs.architecture), "architecture.md still describes the debug-only request log");
    must(!/request logging off at the default/.test(docs.threat), "the threat model still describes request logging as off by default");
    must(!/there is nothing to grep in the deploy log/.test(docs.incident), "incident response still tells the responder the deploy log is empty");
  }
  if (gatedOnDebug && logsRawPath) {
    must(!/masked phone tails only/.test(docs.architecture), "the request path is logged verbatim, so logs are not phone-masked");
    must(!/no PII in logs/.test(docs.threat), "the threat model must not claim logs are free of personal data");
    must(/LOG_LEVEL/.test(docs.threat), "the threat model must say which level writes paths to the log");
  }
  if (!logsRawPath) {
    // The path is no longer logged verbatim; the PII warnings that exist only
    // because it was must go with it, or they scare operators off a fixed log.
    must(!/full E\.164 numbers/.test(docs.architecture), "architecture.md still warns that the log carries full phone numbers");
    must(!/full numbers in the log/.test(docs.threat), "the threat model still warns that the log carries full phone numbers");
  }
  return v;
}

describe("docs: documentation matches the code it describes", () => {
  // docs-1 — the four documents that promise request logs and PII-free logs.
  it("request-logging claims match the LOG_LEVEL gate in src/server.mjs", () => {
    const state = {
      gatedOnDebug: /info:\s*cfg\.logLevel\s*===\s*"debug"/.test(read("src/server.mjs")),
      logsRawPath: /p:\s*url\.pathname/.test(read("src/http.mjs")),
    };
    assert.deepEqual(loggingDocViolations(state, loggingDocs()), [], "documents describe request logging the code does not do");
  });

  it("the request-logging guard also fires when the code stops gating on debug", () => {
    // Not a test of the documents: a test that the guard above is live in the
    // other direction too (round 2, problem 6). It is fed SYNTHETIC documents,
    // not loggingDocs(): pinned to the live files it became a false alarm on
    // exactly the workflow it protects — the day the http/server owner takes the
    // code fix, test 1 fails until the four documents are rewritten, and the
    // moment they are rewritten this test goes red instead, blaming the policy
    // for the documents having been corrected.
    const oldBehaviour = {
      checklist: "Request logging: at the default level no request lines are written at all.",
      architecture: "Request lines are written only at `LOG_LEVEL=debug`, and carry full E.164 numbers in the path.",
      threat: "Logging: request logging off at the default level, so there are no full numbers in the log.",
      incident: "Step 5: if the service ran at the default level there is nothing to grep in the deploy log.",
    };
    const violations = loggingDocViolations({ gatedOnDebug: false, logsRawPath: false }, oldBehaviour);
    assert.equal(violations.length, 6, "each of the six old-behaviour sentences must be objected to individually, or the else-branch has gone partly inert");

    // ...and it releases: documents rewritten for the fixed code raise nothing,
    // so the guard is a policy and not a permanent veto.
    const rewritten = {
      checklist: "Request logging: one line per request at the default level, correlation id included.",
      architecture: "Request lines are written at info with the path params redacted (masked phone tails only).",
      threat: "Logging: request paths are redacted before they are written, so no PII in logs.",
      incident: "Step 5: grep the deploy log for the correlation id.",
    };
    assert.deepEqual(loggingDocViolations({ gatedOnDebug: false, logsRawPath: false }, rewritten), []);
  });

  // docs-4 — README/Railway "production refuses the simulator transport".
  it("the production simulator-transport claim matches validateConfig", () => {
    const cfg = loadConfig({
      ENVIRONMENT: "production", ADMIN_PASSWORD: "a-very-long-password", IDENTITY_KEY: "k".repeat(64),
      WHATSAPP_TRANSPORT: "simulator", RECEIPT_EXTRACTOR: "tesseract",
    });
    assert.equal(cfg.whatsappTransport, "simulator");
    const problems = validateConfig(cfg);
    const refusedAtBoot = problems.some((p) => /transport/i.test(p) && (/simulator/i.test(p) || /cloud-api/i.test(p)));
    const readme = read("README.md");
    const railway = read("docs/release/railway-deploy.md");
    if (refusedAtBoot) {
      // The boot really does refuse it, so the documents may (and must) say so.
      assert.match(readme, /refuses the simulator transport[^.]*at boot/i, "the README must state the boot-time refusal it relies on");
      assert.match(railway, /refuses the simulator transport[\s\S]{0,120}\*\*at boot\*\*/i, "the deploy guide must state the boot-time refusal");
    } else {
      // It does not: a service left on the simulator boots and reports healthy,
      // so no document may tell an operator that a green deploy proves otherwise.
      assert.doesNotMatch(readme, /Production refuses the simulator transport/, "boot does not refuse the simulator transport");
      assert.doesNotMatch(railway, /refuses the simulator, sample seeding and dev keys/, "boot does not refuse the simulator transport");
      assert.match(readme, /not refused at boot/, "the README must say where the refusal actually happens");
      assert.match(railway, /does \*\*not\*\* refuse/, "the deploy guide must say a green deploy is not proof of the transport");
    }
  });

  // docs-5 — a database guarantee on `draws` that does not exist.
  it("architecture.md claims only the draws constraints that exist in db/migrations", () => {
    const sql = migrationFiles().map((f) => read(path.join("db", "migrations", f))).join("\n");
    const hasUniqueIndexOnDraws = /create\s+unique\s+index[^;]*\bon\s+draws\b/i.test(sql);
    const architecture = read("docs/architecture.md");
    if (!hasUniqueIndexOnDraws) {
      assert.doesNotMatch(architecture, /partial UNIQUE \(campaign, period\)/i, "no partial unique index on draws exists");
      assert.match(architecture, /UNIQUE\(campaign_id, draw_period\)/, "the contract table must name the constraint that does exist");
    }
  });

  // docs-6 — migrations 008/009/010 documented nowhere; 008 described as a rebuild that was rejected.
  it("every migration file is documented in docs/release/migrations.md", () => {
    const md = read("docs/release/migrations.md");
    const coveredByRange = /001[–-]006/.test(md);
    for (const f of migrationFiles()) {
      const documented = md.includes(f) || (migrationNumber(f) <= 6 && coveredByRange);
      assert.ok(documented, `migration ${f} has no row in docs/release/migrations.md`);
    }
  });

  it("the rollback runbook accounts for every migration a rollback would step over", () => {
    // Round 2, problem 3: migrations.md was brought up to date but the runbook
    // an on-call engineer actually opens still enumerated 008–010, so migration
    // 011 (a new column, two indexes and a schema_meta DELETE) was invisible to
    // the person planning the rollback.
    const highest = Math.max(...migrationFiles().map(migrationNumber));
    const covered = coveredMigrationNumbers(read("docs/runbooks/restore-and-rollback.md"));
    assert.ok(covered.has(highest), `migration ${String(highest).padStart(3, "0")} is on disk but the rollback runbook stops at ${Math.max(...covered)}`);
  });

  it("no document describes migration 008 as a rebuild of draws", () => {
    const eight = migrationFiles().find((f) => migrationNumber(f) === 8);
    const rebuildsDraws = eight ? /drop\s+table\s+draws|create\s+table\s+draws/i.test(read(path.join("db", "migrations", eight))) : false;
    if (!rebuildsDraws) {
      assert.doesNotMatch(read("docs/runbooks/restore-and-rollback.md"), /008 rebuilt `draws`/, "the rollback runbook plans around a DDL change that never happened");
      assert.doesNotMatch(read("docs/architecture.md"), /draws table rebuild \(migration 008\)/, "the ADR index names a rebuild that ADR-0007 rejected");
    }
  });

  it("the readiness statement's migration range covers every migration on disk", () => {
    const highest = Math.max(...migrationFiles().map(migrationNumber));
    const m = read("docs/TEST_READINESS.md").match(/\bmigrations 0*1\s*[–-]\s*(\d+)/);
    assert.ok(m, "TEST_READINESS.md must state the migration range");
    assert.equal(Number(m[1]), highest, "the stated range stops short of the migrations that are applied at boot");
  });

  // docs-7 — variables the code reads that neither the schema nor preflight knows about.
  const outOfSchemaEnvNames = () => {
    const schemaNames = new Set(CONFIG_SCHEMA.map(([name]) => name));
    // RAILWAY_* are injected by the host and are not ours to document.
    const keep = (n) => !schemaNames.has(n) && !n.startsWith("RAILWAY_");
    const inConfig = new Set(), elsewhere = new Set();
    for (const m of read("src/config.mjs").matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) if (keep(m[1])) inConfig.add(m[1]);
    for (const f of ["src/demo-seed.mjs", "src/bootstrap.mjs", "src/server.mjs"]) {
      for (const m of read(f).matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/g)) if (keep(m[1]) && !inConfig.has(m[1])) elsewhere.add(m[1]);
    }
    return { inConfig, elsewhere, all: new Set([...inConfig, ...elsewhere]) };
  };

  it("every environment variable the boot path reads is in CONFIG_SCHEMA or documented as outside it", () => {
    const configuration = read("docs/release/configuration.md");
    const undocumented = [...outOfSchemaEnvNames().all].filter((n) => !configuration.includes(n));
    assert.deepEqual(undocumented, [], "read by the code, absent from CONFIG_SCHEMA/.env.example, and never reported by preflight");
  });

  it("configuration.md counts the out-of-schema variables as the code actually reads them", () => {
    // Round 2, problem 2: the sentence above the table said "seven such names
    // exist today (two of them outside src/config.mjs)" — a count an operator
    // uses to decide whether they have seen the whole list, stated as a
    // repo-wide fact when it only ever held for the boot path. The count is now
    // scoped to the files this test reads, and the positional half is gone:
    // VOLUME_INIT is read in src/config.mjs AND src/bootstrap.mjs, so "outside
    // src/config.mjs" has no stable answer. The per-row "Read by" column says
    // where each name lands.
    const { all } = outOfSchemaEnvNames();
    const m = read("docs/release/configuration.md").match(/(\w+) such names are read on the boot path/);
    assert.ok(m, "configuration.md must state how many names the boot path reads outside CONFIG_SCHEMA");
    assert.equal(numberWord(m[1]), all.size, `the boot path reads ${all.size} names outside CONFIG_SCHEMA: ${[...all].sort().join(", ")}`);
  });

  it(".env.example lists every CONFIG_SCHEMA name, as configuration.md says it does", () => {
    const assigned = new Set([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const missing = CONFIG_SCHEMA.map(([name]) => name).filter((n) => !assigned.has(n));
    assert.deepEqual(missing, [], "an operator cannot configure what the environment reference never names");
    const strays = [...assigned].filter((n) => !CONFIG_SCHEMA.some(([name]) => name === n));
    assert.deepEqual(strays, [], ".env.example must not invent names the schema does not read");
  });

  it(".env.example does not silently switch off the volume guard it documents", () => {
    // Round 2, problem 5: `VOLUME_PATH=` is not the same as an absent
    // VOLUME_PATH. Present-but-empty resolves cfg.volumePath to "" (an absent
    // one defaults to /app/data on Railway), dataVolumeStatus then reports
    // {checked:false}, and the guard that stops the service creating its
    // database in ephemeral container storage is off — while preflight prints
    // "VOLUME_PATH not set (check disabled)". `npm start`/`worker`/`seed` all
    // read .env, so an operator who copies this file and promotes it loses the
    // guard without being told.
    const env = Object.fromEntries([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
    const cfg = loadConfig({ ...env, ENVIRONMENT: "staging", ADMIN_PASSWORD: "a-very-long-password", IDENTITY_KEY: "k".repeat(64) });
    assert.equal(dataVolumeStatus(cfg).checked, true, "a .env copied from .env.example and promoted to staging/production disables the persistent-volume check");
  });

  // docs-8 — delivery documents citing a test evidence file that predates the suite.
  //
  // `npm test` runs `test/*.test.mjs` — this file included — and node reports one
  // `# suites` entry per top-level describe(), so a genuine regeneration always
  // records at least one suite per test file. Round 2, problem 4: the release
  // condition used to be `recordedSuites === (files excluding this one)`, which a
  // real regeneration can never satisfy, so the staleness qualifier was pinned on
  // for ever and the documents were permanently forbidden from quoting a fresh
  // count. `>=` over every file releases exactly when the evidence has caught up.
  const evidenceCoversTree = (recordedSuites) => recordedSuites >= testSuiteFiles().length;

  it("documents citing the recorded test evidence say it does not cover this tree", () => {
    const evidence = read("docs/testing/evidence/test-results.txt");
    const recordedSuites = Number(evidence.match(/^# suites (\d+)$/m)?.[1]);
    assert.ok(Number.isFinite(recordedSuites), "the evidence file must report a suite count");
    if (evidenceCoversTree(recordedSuites)) return; // evidence regenerated: the counts may be quoted as current
    for (const doc of ["docs/TEST_READINESS.md", "docs/requirements-traceability.md", "docs/testing/evidence/README.md"]) {
      const cited = read(doc).split("\n").filter((l) => l.includes("test-results.txt"));
      assert.ok(cited.length, `${doc} must cite the evidence file`);
      assert.ok(cited.some((l) => /regenerat|predate|recorded run|Stale/i.test(l)), `${doc} presents a stale test count (${recordedSuites} recorded suites vs ${testSuiteFiles().length} suite files in test/) as current evidence`);
      assert.doesNotMatch(read(doc), /46\/46/, `${doc} still states the stale count as the attestation`);
    }
  });

  it("the staleness qualifier is released by a real `npm test` regeneration", () => {
    // The guard above is only honest if it can let go. Compute what `npm test`
    // would actually record for this tree and require the release condition to
    // hold for it.
    assert.match(JSON.parse(read("package.json")).scripts.test, /test\/\*\.test\.mjs/, "the documented regeneration command must be the one the guard is calibrated against");
    const wouldRecord = testSuiteFiles().reduce((n, f) => n + (read(path.join("test", f)).match(/^describe\(/gm)?.length ?? 0), 0);
    assert.ok(wouldRecord >= testSuiteFiles().length, "every test file must contribute at least one top-level describe()");
    assert.ok(evidenceCoversTree(wouldRecord), `a regenerated evidence file would record ${wouldRecord} suites and the staleness guard still would not release: the documents can never stop carrying the qualifier`);
  });

  it("every commit a delivery document cites is in this branch's history", () => {
    // Round 2, problem 1: the provenance fix itself cited f0a7f7a8…, a
    // pre-rebase hash that is not reachable from HEAD, for a recording that was
    // in fact last regenerated later (86ebef8). A delivery document that names a
    // commit nobody can check out is worse than one that names none.
    assert.ok(git(["rev-parse", "--verify", "HEAD"]), "provenance can only be checked from the git checkout this branch is delivered from");
    const cited = new Map();
    for (const doc of ["docs/TEST_READINESS.md", "docs/requirements-traceability.md", "docs/testing/evidence/README.md"]) {
      // 7–40 hex chars: commit ids. A 64-char sha256 cannot match (word boundaries).
      for (const m of read(doc).matchAll(/\b[0-9a-f]{7,40}\b/g)) {
        if (!cited.has(m[0])) cited.set(m[0], new Set());
        cited.get(m[0]).add(doc);
      }
    }
    assert.ok(cited.size, "the delivery documents must identify the commit their evidence came from");
    const unreachable = [...cited].filter(([h]) => git(["merge-base", "--is-ancestor", h, "HEAD"]) === null)
      .map(([h, docs]) => `${h} (${[...docs].join(", ")})`);
    assert.deepEqual(unreachable, [], "a delivery document attributes its evidence to a commit that is not in this branch");
  });
});

describe("docs: claims checked against a running server", () => {
  let h;
  before(async () => { h = await buildApp({ seed: false }); });
  after(async () => { await h.close(); });

  // docs-1 (fix note) — /health/* and /webhooks/* are answered before the router.
  it("api.md promises a correlation id only where one is actually sent", async () => {
    const live = await h.api("/health/live", { raw: true });
    const routed = await h.api("/api/winners/public", { raw: true });
    assert.equal(live.status, 200);
    assert.ok(routed.headers.get("x-correlation-id"), "routed /api/* responses do carry a correlation id");
    const api = read("docs/api.md");
    if (!live.headers.get("x-correlation-id")) {
      assert.doesNotMatch(api, /`x-correlation-id` on every response/, "the pre-router endpoints carry no correlation id");
      assert.match(api, /health\/live/, "api.md must name the endpoints that carry none");
    }
  });

  // docs-3 — the documented post-deploy verification query must agree with what
  // a fully migrated database actually reports, in whichever direction that is.
  it("the post-deploy verification query matches what schema_meta reports", () => {
    const row = (k) => h.db.prepare(`select value from schema_meta where key=?`).get(k)?.value;
    const applied = (row("migrations") || "").split(",").filter(Boolean);
    assert.ok(applied.length, "the scratch database must have migrations recorded");
    const highest = Math.max(...applied.map(migrationNumber));
    const schemaVersion = Number(row("schema_version"));
    const md = read("docs/release/migrations.md");
    const sqlBlock = md.match(/```sql\n([\s\S]*?)```/)?.[1];
    assert.ok(sqlBlock, "migrations.md must carry the verification query");
    if (schemaVersion === highest) {
      // migrate() derives the value, so the documented query may rely on it —
      // and must not still warn an operator off a signal that now works. The
      // document has to say WHY it is trustworthy now (round 2, problem 6:
      // without this the docs-3 prose could be reverted with nothing failing).
      assert.match(sqlBlock, /schema_version/, "schema_version tracks the ledger again; the verification query should use it");
      // Anchored on the PROSE, not on the word "derived" anywhere in the file:
      // the one-line SQL comment above the query also contains "derived", so a
      // bare /derived/i left the whole explanation — the drift history, the
      // 005/007 no-op, and the warning below — deletable with nothing failing.
      assert.match(md, /`schema_meta\.schema_version` is derived by `migrate\(\)` from the applied ledger/,
        "migrations.md must explain that the value is derived from the applied ledger, not hand-maintained");
      assert.match(md, /read the value \*\*after\*\* the deploy/,
        "an operator reading schema_version from a pre-deploy snapshot of an older volume sees the drifted value; the document must say so");
      assert.doesNotMatch(md, /dead field/, "the document still describes schema_version as unusable");
    } else {
      assert.doesNotMatch(sqlBlock, /schema_version/, `schema_version is ${schemaVersion} on a fully migrated database (highest migration ${highest}); the query cannot distinguish success from failure`);
      assert.match(md, /schema_version/, "the document must explain why the key is not used");
    }
  });
});
