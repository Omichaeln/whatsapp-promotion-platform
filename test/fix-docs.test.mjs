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
import { CONFIG_SCHEMA, loadConfig, validateConfig } from "../src/config.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const migrationFiles = () => fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const migrationNumber = (f) => Number(f.slice(0, 3));

describe("docs: documentation matches the code it describes", () => {
  // docs-1 — the three documents that promise request logs and PII-free logs.
  it("request-logging claims match the LOG_LEVEL gate in src/server.mjs", () => {
    const server = read("src/server.mjs");
    const gatedOnDebug = /info:\s*cfg\.logLevel\s*===\s*"debug"/.test(server);
    const logsRawPath = /p:\s*url\.pathname/.test(read("src/http.mjs"));
    const checklist = read("docs/release/production-checklist.md");
    const architecture = read("docs/architecture.md");
    const threat = read("docs/security/threat-model.md");
    const incident = read("docs/runbooks/incident-response.md");

    if (gatedOnDebug) {
      assert.match(checklist, /LOG_LEVEL=debug/, "the checklist must say request logs exist only at LOG_LEVEL=debug");
      assert.doesNotMatch(checklist, /^- Structured request logs with correlation ids, metrics table, alerts with runbooks — verified;/m, "the checklist must not report request logging as verified");
      assert.match(incident, /LOG_LEVEL=debug/, "incident response step 5 must not send a responder to logs that are not written");
    }
    if (gatedOnDebug && logsRawPath) {
      assert.doesNotMatch(architecture, /masked phone tails only/, "the request path is logged verbatim, so logs are not phone-masked");
      assert.doesNotMatch(threat, /no PII in logs/, "the threat model must not claim logs are free of personal data");
      assert.match(threat, /LOG_LEVEL/, "the threat model must say which level writes paths to the log");
    }
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
    const m = read("docs/TEST_READINESS.md").match(/expand-only migrations 0*1\s*[–-]\s*(\d+)/);
    assert.ok(m, "TEST_READINESS.md must state the migration range");
    assert.equal(Number(m[1]), highest, "the stated range stops short of the migrations that are applied at boot");
  });

  // docs-7 — variables the code reads that neither the schema nor preflight knows about.
  it("every environment variable the boot path reads is in CONFIG_SCHEMA or documented as outside it", () => {
    const schemaNames = new Set(CONFIG_SCHEMA.map(([name]) => name));
    const names = new Set();
    for (const m of read("src/config.mjs").matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
    for (const f of ["src/demo-seed.mjs", "src/bootstrap.mjs", "src/server.mjs"]) {
      for (const m of read(f).matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
    }
    const configuration = read("docs/release/configuration.md");
    // RAILWAY_* are injected by the host and are not ours to document.
    const undocumented = [...names].filter((n) => !schemaNames.has(n) && !n.startsWith("RAILWAY_") && !configuration.includes(n));
    assert.deepEqual(undocumented, [], "read by the code, absent from CONFIG_SCHEMA/.env.example, and never reported by preflight");
  });

  it(".env.example lists every CONFIG_SCHEMA name, as configuration.md says it does", () => {
    const assigned = new Set([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const missing = CONFIG_SCHEMA.map(([name]) => name).filter((n) => !assigned.has(n));
    assert.deepEqual(missing, [], "an operator cannot configure what the environment reference never names");
    const strays = [...assigned].filter((n) => !CONFIG_SCHEMA.some(([name]) => name === n));
    assert.deepEqual(strays, [], ".env.example must not invent names the schema does not read");
  });

  // docs-8 — delivery documents citing a test evidence file that predates the suite.
  it("documents citing the recorded test evidence say it does not cover this tree", () => {
    const evidence = read("docs/testing/evidence/test-results.txt");
    const recordedSuites = Number(evidence.match(/^# suites (\d+)$/m)?.[1]);
    assert.ok(Number.isFinite(recordedSuites), "the evidence file must report a suite count");
    const suiteFiles = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs") && f !== "fix-docs.test.mjs").length;
    if (recordedSuites === suiteFiles) return; // evidence regenerated: the counts may be quoted as current
    for (const doc of ["docs/TEST_READINESS.md", "docs/requirements-traceability.md", "docs/testing/evidence/README.md"]) {
      const cited = read(doc).split("\n").filter((l) => l.includes("test-results.txt"));
      assert.ok(cited.length, `${doc} must cite the evidence file`);
      assert.ok(cited.some((l) => /regenerat|predate|recorded run|Stale/i.test(l)), `${doc} presents a stale test count (${recordedSuites} recorded suites vs ${suiteFiles} in test/) as current evidence`);
      assert.doesNotMatch(read(doc), /46\/46/, `${doc} still states the stale count as the attestation`);
    }
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
      // and must not still warn an operator off a signal that now works.
      assert.match(sqlBlock, /schema_version/, "schema_version tracks the ledger again; the verification query should use it");
      assert.doesNotMatch(md, /dead field/, "the document still describes schema_version as unusable");
    } else {
      assert.doesNotMatch(sqlBlock, /schema_version/, `schema_version is ${schemaVersion} on a fully migrated database (highest migration ${highest}); the query cannot distinguish success from failure`);
      assert.match(md, /schema_version/, "the document must explain why the key is not used");
    }
  });
});
