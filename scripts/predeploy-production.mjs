#!/usr/bin/env node
/**
 * FR-P0-05 — production deployment preflight.
 *
 * The audit finding: README told operators to `wrangler d1 create fireraid`
 * and paste the printed database_id "into all env blocks", then run
 * `d1 migrations apply fireraid` against a DIFFERENT database name than
 * production actually binds. That can migrate DB A, deploy to DB B, and
 * ship a Worker whose schema does not match the database it talks to.
 *
 * This preflight is the guard + the corrected, environment-scoped sequence.
 *
 * MODES (FR-P0-D): the remote migration check's SKIP semantics differ by
 * purpose, so the script has two explicit modes:
 *
 *   --local   (default) release-evidence mode: the remote check MAY skip
 *             when no Cloudflare token is available; the SKIP is reported
 *             and keeps deploy_ready=false, but the local candidate itself
 *             is still certifiable.
 *   --deploy  the mode `npm run deploy:production` uses: the remote
 *             migration check is REQUIRED — a missing token, an
 *             authentication failure, or unparseable output is a HARD
 *             FAILURE. A deploy is never permitted while the production
 *             database's migration state is unverifiable.
 *
 * Fail-closed on any of:
 *   1. PRODUCTION DB ID is the placeholder (REPLACE_AFTER_CREATE) or missing.
 *   2. Production DB id is NOT distinct from the public-lab DB id.
 *   3. LAB_MODE is not "false" in the production env.
 *   4. TURNSTILE_EXPECTED_HOSTNAME is unset in the production env.
 *   5. FIRERAID_RATE_LIMIT_LOGIN is unset or still the placeholder.
 *   6. A local dry-run deploy of the production env fails.
 *   7. Remote migrations outstanding / unverifiable (mode-dependent).
 *
 * JSON MODE (FR-P0-B): --json writes EXACTLY ONE JSON document to stdout —
 * all human prose goes to stderr. Callers may JSON.parse(stdout) safely.
 *
 * Usage:
 *   node scripts/predeploy-production.mjs --local            # release evidence
 *   node scripts/predeploy-production.mjs --deploy           # gate a real deploy
 *   node scripts/predeploy-production.mjs --local --json     # machine-readable
 *   npm run predeploy:production                             # --local
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { classifyMigrationList } from "./lib/migrations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.jsonc");
const PLACEHOLDER = "REPLACE_AFTER_CREATE";

// ── Mode & output parsing ────────────────────────────────────────────────
const args = process.argv.slice(2);
const DEPLOY_MODE = args.includes("--deploy");
const LOCAL_MODE = args.includes("--local") || !DEPLOY_MODE; // default local
const JSON_MODE = args.includes("--json");
// Back-compat: a bare `--json` (no mode flag) is local/evidence mode.
const MODE = DEPLOY_MODE ? "deploy" : "local";

// In JSON mode, human prose MUST go to stderr — stdout carries exactly one
// JSON document (FR-P0-B).
function note(msg) {
  if (JSON_MODE) process.stderr.write(msg + "\n");
  else console.log(msg);
}

const errors = [];
const warnings = [];
const checks = [];

function fail(name, msg) {
  checks.push({ name, status: "FAIL", detail: msg });
  errors.push(name);
}
function pass(name, msg) {
  checks.push({ name, status: "PASS", detail: msg });
}
function skip(name, msg) {
  checks.push({ name, status: "SKIP", detail: msg });
  warnings.push(msg);
}
const passCount = () => checks.filter((c) => c.status === "PASS").length;
const skipCount = () => checks.filter((c) => c.status === "SKIP").length;
const failCount = () => checks.filter((c) => c.status === "FAIL").length;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "" };
}

let config;
try {
  const text = readFileSync(CONFIG, "utf-8");
  const errs = [];
  config = parseJsonc(text, errs);
  if (errs.length > 0) {
    throw new Error(`wrangler.jsonc parse failed: ${errs.map(String).join("; ")}`);
  }
} catch (err) {
  const msg = "predeploy abort: cannot read production config — " + err.message;
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      checks: [{ name: "config-parse", status: "FAIL", detail: msg }],
      passed: 0, skipped: 0, failed: 1, mode: MODE,
    }) + "\n");
    process.exit(1);
  }
  console.error(msg);
  process.exit(1);
}

const production = config?.env?.production;
const productionVars = production?.vars ?? {};
const prodDb = production?.d1_databases?.[0];
const prodDbId = prodDb?.database_id;
const prodDbName = prodDb?.database_name;
const publicLabDbId = config?.env?.["public-lab"]?.d1_databases?.[0]?.database_id;

// ── Config-level (read-only, no credentials needed) ─────────────────────

const labMode = String(productionVars.LAB_MODE ?? "").toLowerCase();
if (labMode === "false") {
  pass("lab-mode", "production env LAB_MODE=false");
} else if (labMode === "true") {
  fail("lab-mode", `production env LAB_MODE is "true" — a production deploy must be the production plane, not lab`);
} else {
  fail("lab-mode", `production env LAB_MODE is unset or "${productionVars.LAB_MODE}" — expected "false"`);
}

if (!prodDbId || prodDbId === PLACEHOLDER) {
  fail("production-db-id", `production d1 database_id is the placeholder ("${PLACEHOLDER}") or missing — create and bind fireraid-production, then re-run`);
} else {
  pass("production-db-id", `production binds ${prodDbName ?? "(unnamed)"} = ${prodDbId}`);
}

if (publicLabDbId && prodDbId && publicLabDbId === prodDbId) {
  fail("production-db-distinct", `production DB id ${prodDbId} equals the public-lab DB id — production must never point at the public research database`);
} else if (publicLabDbId === PLACEHOLDER || !publicLabDbId) {
  // public-lab may be unprovisioned; that is not a production error as long
  // as they are not identical. Only a true collision is fatal.
  skip("production-db-distinct", "public-lab database_id is unprovisioned (placeholder); production is distinct by definition");
} else {
  pass("production-db-distinct", `production DB id ${prodDbId} differs from public-lab DB id ${publicLabDbId}`);
}

const hostname = productionVars.TURNSTILE_EXPECTED_HOSTNAME;
if (!hostname) {
  fail("production-hostname", "production env TURNSTILE_EXPECTED_HOSTNAME is unset — the submit path fails closed without it");
} else {
  pass("production-hostname", `TURNSTILE_EXPECTED_HOSTNAME=${hostname}`);
}

// FR-P1-07: production must declare an authoritative edge limiter for
// /api/admin/login. NOTE: this value is an OPERATOR ATTESTATION — the env
// var names the edge limiter; it is not (yet) programmatic proof an edge
// rule exists. Closure 7 tracks stricter verification.
const rateLimitLogin = productionVars.FIRERAID_RATE_LIMIT_LOGIN;
if (!rateLimitLogin) {
  fail("rate-limit-login", "production env FIRERAID_RATE_LIMIT_LOGIN is unset — declare the authoritative edge rate-limiter (WAF/Access/ratelimit) for /api/admin/login");
} else if (rateLimitLogin === "REPLACE_WITH_EDGE_LIMITER_NAME") {
  fail("rate-limit-login", "FIRERAID_RATE_LIMIT_LOGIN still carries the tracked placeholder — set it to the actual limiter rule/plan name");
} else {
  pass("rate-limit-login", `FIRERAID_RATE_LIMIT_LOGIN=${rateLimitLogin} (operator attestation of the edge limiter)`);
}

// ── Production entrypoint import graph (FR-P1-05) ────────────────────────
// The production Worker must not bundle the evaluation control plane at all
// (src/eval/, lab routes, the review-decision write). A config that lets the
// production env regress into the lab plane is a deployment defect even when
// every runtime test is green.
const graph = run("node", ["scripts/check-production-graph.mjs"]);
if (graph.status === 0) {
  pass("production-graph", "production Worker import graph excludes src/eval/, lab routes, and the review-decision write");
} else {
  fail("production-graph", `production Worker import graph reaches the evaluation control plane:\n${graph.stderr || graph.stdout}`);
}

// ── Dry-run deploy of the production env (no upload) ────────────────────

const dry = run("npx", ["wrangler", "deploy", "--env", "production", "--dry-run"]);
if (dry.status === 0) {
  pass("dry-run", "wrangler deploy --env production --dry-run succeeded (bundle + checks clean)");
} else {
  fail("dry-run", `wrangler deploy --env production --dry-run failed (exit ${dry.status}):\n${dry.stderr || dry.stdout}`);
}

// ── Remote migration state against the EXACT production database ────────
// FR-P0-C: Wrangler's `d1 migrations list --remote` outputs, on a CURRENT
// database, "✅ No migrations to apply!" — and on a STALE database, a table
// of outstanding migration filenames (which need NOT contain "unapplied").
// The old parser matched /No migrations/ as a FAILURE and passed anything
// else — exactly inverted. classifyMigrationList() implements the correct
// three-way classification and lives in scripts/lib/migrations.mjs so it
// can be unit-tested against real Wrangler output fixtures.
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  if (DEPLOY_MODE) {
    // FR-P0-D: a deploy must never proceed on an unverifiable migration
    // state. Fail hard — do not let `deploy:production` skip its own gate.
    fail("remote-migrations", "CLOUDFLARE_API_TOKEN unset — deploy mode REQUIRES remote migration verification; export a token with D1 read access and re-run");
  } else {
    skip("remote-migrations", "CLOUDFLARE_API_TOKEN unset — cannot verify remote migration state; run the migration check with a real token before deploy");
  }
} else {
  // FR-P0-05: list migrations against the PRODUCTION database binding by
  // name in the production env — never a bare un-env'd `d1 migrations apply
  // fireraid` (that would target a DIFFERENT database than production binds).
  const list = run("npx", ["wrangler", "d1", "migrations", "list", prodDbName || "fireraid-production", "--env", "production", "--remote"]);
  if (list.status !== 0) {
    fail("remote-migrations", `wrangler d1 migrations list failed (exit ${list.status}):\n${list.stderr || list.stdout}`);
  } else {
    const cls = classifyMigrationList(list.stdout);
    if (cls.kind === "current") {
      pass("remote-migrations", `all remote migrations against ${prodDbName} applied`);
    } else if (cls.kind === "outstanding") {
      fail("remote-migrations", `production has ${cls.count} unapplied migration(s) — apply them with the env-scoped sequence before deploy:\n${cls.names.join("\n")}`);
    } else {
      // Unknown/unparseable output — in deploy mode this is fatal; in local
      // evidence mode it still FAILS (fail-closed either way; deploy mode
      // additionally cannot be rescued by re-running with a token missing).
      fail("remote-migrations", `wrangler d1 migrations list returned UNPARSEABLE output (exit ${list.status}):\n${list.stdout.slice(0, 2000)}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────

if (JSON_MODE) {
  // FR-P0-B: stdout carries EXACTLY ONE JSON document — nothing else.
  process.stdout.write(JSON.stringify({
    mode: MODE,
    checks,
    passed: passCount(),
    skipped: skipCount(),
    failed: failCount(),
  }) + "\n");
} else {
  note("\nFR-P0-05 production preflight (" + MODE + " mode)");
  for (const c of checks) {
    note(`  [${c.status}] ${c.name} — ${c.detail}`);
  }
  note(`\n${passCount()} passed, ${skipCount()} skipped, ${failCount()} failed`);
  for (const w of warnings) note(`  ⚠ ${w}`);
}

if (errors.length > 0) {
  if (!JSON_MODE) process.stderr.write("\npredeploy FAILED — refusing to deploy. Fix the errors above, then re-run.\n");
  process.exit(1);
}
if (!JSON_MODE) {
  note("\npredeploy OK — deployment may proceed" +
    (DEPLOY_MODE ? "." : " (confirm the skips are acceptable for this deploy)."));
}
process.exit(0);
