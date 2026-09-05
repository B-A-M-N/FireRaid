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
 * Run before EVERY production deploy (wired into `deploy:production`). It
 * FAILS CLOSED on any of:
 *
 *   1. PRODUCTION DB ID is the placeholder (REPLACE_AFTER_CREATE) or missing.
 *   2. Production DB id is NOT distinct from the public-lab DB id — a
 *      production deploy must never point at the public research database.
 *   3. LAB_MODE is not "false" in the production env.
 *   4. TURNSTILE_EXPECTED_HOSTNAME is unset in the production env.
 *   5. A local dry-run deploy of the production env fails (bundle/type-arity
 *      errors surface here, before any upload).
 *   6. There are unapplied remote migrations against fireraid-production
 *      (requires a live CLOUDFLARE_API_TOKEN; when no token is present the
 *      check is SKIPPED and reported, never silently counted as clean).
 *
 * Usage:
 *   node scripts/predeploy-production.mjs            # read-only preflight
 *   node scripts/predeploy-production.mjs --json     # machine-readable checks
 *   npm run predeploy:production
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "wrangler.jsonc");
const PLACEHOLDER = "REPLACE_AFTER_CREATE";
// FR-P1-13: `--json` emits the check array machine-readable so the release
// gate can fold this preflight into release evidence and compute deploy_ready
// precisely (no human-output parsing).
const JSON_MODE = process.argv.includes("--json");

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
const by = (s) => checks.filter((c) => c.status === s).length;
const passCount = () => by("PASS");
const skipCount = () => by("SKIP");
const failCount = () => by("FAIL");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 30_000 });
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
  console.error("predeploy abort: cannot read production config —", err.message);
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
// /api/admin/login. The in-isolate login map is a secondary per-isolate
// guard only; a placeholder or missing value is a deployment defect.
const rateLimitLogin = productionVars.FIRERAID_RATE_LIMIT_LOGIN;
if (!rateLimitLogin) {
  fail("rate-limit-login", "production env FIRERAID_RATE_LIMIT_LOGIN is unset — declare the authoritative edge rate-limiter (WAF/Access/ratelimit) for /api/admin/login");
} else if (rateLimitLogin === "REPLACE_WITH_EDGE_LIMITER_NAME") {
  fail("rate-limit-login", "FIRERAID_RATE_LIMIT_LOGIN still carries the tracked placeholder — set it to the actual limiter rule/plan name");
} else {
  pass("rate-limit-login", `FIRERAID_RATE_LIMIT_LOGIN=${rateLimitLogin}`);
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

// Requires a live Cloudflare token. With no token this is skipped and
// reported — it must not be counted as "clean" (a deploy with outstanding
// migrations is a schema mismatch waiting to happen).
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  skip("remote-migrations", "CLOUDFLARE_API_TOKEN unset — cannot verify remote migration state; run the migration check with a real token before deploy");
} else {
  // FR-P0-05: list migrations against the PRODUCTION database binding by
  // name in the production env — never a bare un-env'd `d1 migrations apply
  // fireraid` (that would target a DIFFERENT database than production binds).
  const list = run("npx", ["wrangler", "d1", "migrations", "list", prodDbName || "fireraid-production", "--env", "production", "--remote"]);
  if (list.status === 0) {
    if (/no migrations found|No migrations|unapplied/i.test(list.stdout)) {
      fail("remote-migrations", `production has unapplied migrations — apply them with the env-scoped sequence before deploy:\n${list.stdout}`);
    } else {
      pass("remote-migrations", `all remote migrations against ${prodDbName} applied`);
    }
  } else {
    fail("remote-migrations", `wrangler d1 migrations list failed (exit ${list.status}):\n${list.stderr || list.stdout}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────

if (JSON_MODE) {
  // Machine-readable: the raw check array plus the aggregate counts. Exit
  // code still reflects FAILs (callers rely on it either way).
  process.stdout.write(JSON.stringify({ checks, passed: passCount(), skipped: skipCount(), failed: failCount() }) + "\n");
} else {
  console.log("\nFR-P0-05 production preflight");
  for (const c of checks) {
    console.log(`  [${c.status}] ${c.name} — ${c.detail}`);
  }
  console.log(`\n${checks.filter((c) => c.status === "PASS").length} passed, ` +
    `${checks.filter((c) => c.status === "SKIP").length} skipped, ` +
    `${checks.filter((c) => c.status === "FAIL").length} failed`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

if (errors.length > 0) {
  console.error("\npredeploy FAILED — refusing to deploy. Fix the errors above, then re-run.");
  process.exit(1);
}
console.log("\npredeploy OK — deployment may proceed (confirm the skips are acceptable for this deploy).");
process.exit(0);