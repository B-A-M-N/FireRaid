#!/usr/bin/env node
/**
 * P2 — release gate aggregator: run every deterministic release gate and
 * write machine-readable evidence to release-evidence.json.
 *
 * Two modes:
 *   release:verify:fast  — typecheck, lint, worker-isolation, origin-budget
 *   release:verify:full  — fast + unit, product-boundary, integration,
 *                          envelope, budget, ledger-proof, package-contract,
 *                          e2e, e2e:production, a11y, examples
 *
 * Only `full` may produce local_candidate:true.
 *
 * What this script deliberately does NOT do:
 *   - It does not run the LLM benchmark. Efficacy is a MEASURED item backed
 *     by a completed experiment directory, not a release gate.
 *   - It does not verify a remote deployment. That is user-gated (needs
 *     real credentials and an internet-facing origin).
 *
 * FR-P0-A — THREE RELEASE TIERS, externally attested:
 *
 *   local_candidate  — every deterministic local (source/package) gate
 *                      passed for this exact clean tree. What this script
 *                      computes directly.
 *   deploy_ready     — local_candidate + production preflight fully passing
 *                      (no FAIL, no SKIP — the remote migration state was
 *                      actually verified against the live database).
 *   release_ready    — deploy_ready + an EXTERNAL smoke receipt
 *                      (release-smoke-receipt.json, untracked) proving the
 *                      exact candidate SHA was deployed and the deployed
 *                      artifact smoked. The receipt lives OUTSIDE git
 *                      because post-deploy evidence cannot be stored inside
 *                      the git object it certifies: committing
 *                      deployed_sha=<A> into a tracked file makes HEAD move
 *                      to B and the attestation self-invalidating (the old
 *                      remote-smoke-current gate had no fixed point).
 *
 * Claims vocabulary (owned by docs/evidence-ledger.json — the machine
 * readable registry this script embeds into the evidence file):
 *   IMPLEMENTED           — code + a passing test exist for the claim
 *   LOCALLY_VERIFIED      — a deterministic local gate passed for this tree
 *   PARTIALLY_ESTABLISHED — completed experiments back a bounded, qualified
 *                           quantitative claim (scope limits are part of it)
 *   MEASURED              — a completed, matched experiment supports the claim
 *   NOT_YET_ESTABLISHED   — no evidence at the required tier
 *
 * Exit: 0 iff every source/package gate passed. Evidence is written either way.
 *
 * Usage:
 *   npm run release:verify:fast
 *   npm run release:verify:full
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv[2] === "full" ? "full" : "fast";

// Expected production-preflight check IDs (FR-P0-B: fail closed when one
// disappears — a silently renamed check must never read as "absent = fine").
const EXPECTED_PREFLIGHT_CHECKS = new Set([
  "lab-mode",
  "production-db-id",
  "production-db-distinct",
  "production-hostname",
  "rate-limit-login",
  "production-graph",
  "dry-run",
  "remote-migrations",
]);

// --- git provenance ---
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const sha = git(["rev-parse", "HEAD"]);
const dirty = (git(["status", "--porcelain"]) ?? "").length > 0;

const gates = [];
function runGate(name, command, args, { slow = false } = {}) {
  if (slow && MODE === "fast") {
    gates.push({ name, command: [command, ...args].join(" "), status: "SKIPPED", skipped: true });
    return;
  }
  const t0 = Date.now();
  const r = spawnSync(command, args, { cwd: ROOT, encoding: "utf-8", timeout: 15 * 60_000, shell: false });
  const passed = r.status === 0;
  gates.push({
    name,
    command: [command, ...args].join(" "),
    status: passed ? "PASS" : "FAIL",
    exit_code: r.status,
    duration_ms: Date.now() - t0,
    // Keep tails bounded — a failure's diagnosis belongs in CI logs, but a
    // short excerpt travels with the evidence file.
    output_tail: (r.stdout ?? "").split("\n").filter(Boolean).slice(-5)
      .concat((r.stderr ?? "").split("\n").filter(Boolean).slice(-5)),
  });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

// --- fast gates (always run) ---
runGate("typecheck", "npm", ["run", "typecheck"]);
runGate("lint", "npm", ["run", "lint"]);
runGate("worker-isolation", "npm", ["run", "test:worker-isolation"]);
runGate("origin-budget", "npm", ["run", "test:origin-budget"]);
// FR-P1-05: the production Worker import graph must never reach the eval
// control plane (src/eval/, lab routes, the review-decision write). A release
// must not certify a production artifact that bundles the evaluation plane.
runGate("production-graph", "npm", ["run", "check:production-graph"]);

// ── FR-P0-B: deterministic production preflight, fail-closed parse ──────
// local_candidate attests the LOCALLY VERIFIED source/package tier.
// "deploy_ready" additionally requires the production preflight to pass
// with NO skip (a --local preflight run without a Cloudflare token leaves
// remote-migrations SKIPped → deploy_ready stays false — a deploy cannot
// be certified deploy-ready against an unverifiable live database).
//
// FAIL-CLOSED PARSING: a preflight that emitted unparseable stdout, or a
// check set missing an expected ID, is a FAILING preflight — never a
// synthesized zero-failure result.
let preflight = null;
let preflightParseError = null;
{
  const t0 = Date.now();
  const r = spawnSync("node", ["scripts/predeploy-production.mjs", "--local", "--json"], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 5 * 60_000,
    shell: false,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    preflightParseError = `unparseable preflight stdout (${err.message}): ${String(r.stdout).slice(0, 400)}`;
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.checks)) {
    const presentIds = new Set(parsed.checks.map((c) => c?.name));
    const missing = [...EXPECTED_PREFLIGHT_CHECKS].filter((id) => !presentIds.has(id));
    if (missing.length > 0) {
      preflightParseError = `preflight check set is missing expected IDs: ${missing.join(", ")}`;
    } else if (typeof parsed.failed !== "number" || typeof parsed.skipped !== "number") {
      preflightParseError = "preflight JSON lacks numeric failed/skipped counts";
    } else {
      preflight = parsed;
      preflight.exit = r.status;
    }
  } else if (!preflightParseError) {
    preflightParseError = "preflight JSON lacks a checks array";
  }
  // A parse/validation failure synthesizes a FAILING preflight — never a
  // zero-failure one.
  if (!preflight) {
    preflight = {
      mode: "local",
      checks: [],
      passed: 0,
      skipped: 0,
      failed: 1,
      exit: r.status,
      parse_error: preflightParseError,
    };
  }
  gates.push({
    name: "production-preflight",
    deploy_gate: true,
    command: "node scripts/predeploy-production.mjs --local --json",
    status: preflight.failed === 0 ? "PASS" : "FAIL",
    exit_code: r.status,
    duration_ms: Date.now() - t0,
    detail: preflightParseError
      ? `parse/validation error: ${preflightParseError}`
      : `${preflight.passed} passed, ${preflight.skipped} skipped, ${preflight.failed} failed`,
  });
  console.log(`[${preflight.failed === 0 ? "PASS" : "FAIL"}] production-preflight (deploy gate) (${preflight.passed}p/${preflight.skipped}s/${preflight.failed}f)`);
}
const preflightLocalClean = preflight.failed === 0; // no FAIL in local determinism
const preflightNoSkips = preflight.skipped === 0;   // no SKIP (remote verified)

// P2: the claim registry lives in docs/evidence-ledger.json (validated by
// tests/unit/evidence-ledger.test.ts). Load it HIGH so the release_tiers
// summary can read it. Fail-closed: a missing or malformed registry is a
// release-blocking inconsistency, not something to paper over.
let ledgerRegistry = null;
let ledgerSummary = null;
try {
  ledgerRegistry = JSON.parse(
    readFileSync(join(ROOT, "docs", "evidence-ledger.json"), "utf-8")
  );
  ledgerSummary = Object.fromEntries(
    ledgerRegistry.claims.map((c) => [c.id, c.tier])
  );
} catch {
  gates.push({
    name: "evidence-ledger",
    command: "read docs/evidence-ledger.json",
    status: "FAIL",
    exit_code: 1,
  });
}

// ── FR-P0-A: the EXTERNAL smoke receipt (release_ready tier) ────────────
// release-smoke-receipt.json is UNTRACKED (.gitignore) — post-deployment
// evidence must not live inside the git object it certifies. When present,
// this gate validates it: schema, exact-SHA match against HEAD, and the
// required smoke checks. When absent, release_ready is simply not claimable
// this run (the receipt is recorded post-deploy, by the deploy runbook) —
// this does NOT block local_candidate, which is the tier this script
// certifies. The recorded receipt is what a release announcer must check
// before declaring release_ready.
let smokeReceipt = null;
{
  const t0 = Date.now();
  const receiptPath = join(ROOT, "release-smoke-receipt.json");
  let gate;
  if (!existsSync(receiptPath)) {
    gate = {
      name: "release-smoke-receipt",
      release_tier_gate: true,
      command: "read release-smoke-receipt.json",
      status: "ABSENT",
      exit_code: 0,
      duration_ms: Date.now() - t0,
      detail: "no external smoke receipt present — release_ready is not claimable for this SHA until a receipt is recorded post-deploy (npm run release:smoke:record -- …); local_candidate/deploy_ready are unaffected",
    };
  } else {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath, "utf-8"));
      const requiredChecks = ["signup_page", "submit_failclosed", "human_submit"];
      const missingChecks = requiredChecks.filter(
        (c) => parsed.checks?.[c]?.ok !== true
      );
      const shaMatch = parsed.git_sha === sha;
      const workerVersion = typeof parsed.worker_version_id === "string" && parsed.worker_version_id.length > 0;
      if (!shaMatch || !workerVersion || missingChecks.length > 0) {
        gate = {
          name: "release-smoke-receipt",
          release_tier_gate: true,
          command: "read release-smoke-receipt.json",
          status: "FAIL",
          exit_code: 1,
          duration_ms: Date.now() - t0,
          detail: !shaMatch
            ? `receipt git_sha ${parsed.git_sha} does not match HEAD ${sha}`
            : !workerVersion
              ? "receipt lacks a worker_version_id"
              : `receipt smoke checks failed/missing: ${missingChecks.join(", ")}`,
        };
      } else {
        gate = {
          name: "release-smoke-receipt",
          release_tier_gate: true,
          command: "read release-smoke required checks",
          status: "PASS",
          exit_code: 0,
          duration_ms: Date.now() - t0,
          detail: `receipt matches HEAD ${sha}; worker_version_id ${parsed.worker_version_id}`,
        };
        smokeReceipt = parsed;
      }
    } catch (err) {
      gate = {
        name: "release-smoke-receipt",
        release_tier_gate: true,
        command: "read release-smoke-receipt.json",
        status: "FAIL",
        exit_code: 1,
        duration_ms: Date.now() - t0,
        detail: `receipt present but unparseable: ${err.message}`,
      };
    }
  }
  gates.push(gate);
  console.log(`[${gate.status}] release-smoke-receipt (${gate.detail})`);
}

// --- full gates (only in full mode) ---
runGate("unit", "npm", ["run", "test:unit"], { slow: true });
runGate("product-boundary", "npm", ["run", "test:product"], { slow: true });
runGate("integration", "npm", ["run", "test:integration"], { slow: true });
runGate("envelope", "npm", ["run", "test:envelope"], { slow: true });
runGate("budget", "npm", ["run", "test:budget"], { slow: true });
runGate("ledger-proof", "npm", ["run", "test:ledger-proof"], { slow: true });
// P0-1/P1-7: the published-package contract — build → pack → install the
// tarball in a temp project → import every declared subpath → functional
// middleware round-trip. A release gate must not certify a package that
// cannot be imported.
runGate("package-contract", "npm", ["run", "test:package"], { slow: true });
runGate("e2e", "npm", ["run", "test:e2e"], { slow: true });
runGate("e2e:production", "npm", ["run", "test:e2e:production"], { slow: true });
runGate("a11y", "npm", ["run", "test:a11y"], { slow: true });
runGate("examples", "npx", ["tsc", "--noEmit"], { slow: true });

// FR-P1-13: the three release tiers. local_candidate reflects the
// SOURCE/PACKAGE gates only. deploy_ready additionally requires the
// preflight deploy gate. release_ready additionally requires the external
// smoke receipt matching THIS HEAD.
const sourceGates = gates.filter((g) => !g.deploy_gate && !g.release_tier_gate);
const allPassed = sourceGates.every((g) => g.status === "PASS");

const localCandidate = MODE === "full" && !dirty && allPassed;
const deployReady =
  MODE === "full" && !dirty && allPassed &&
  preflightLocalClean && preflightNoSkips;
const releaseReady = deployReady && smokeReceipt !== null;

const evidence = {
  schema: "fireraid-release-evidence/4",
  mode: MODE,
  generated_at: new Date().toISOString(),
  git: {
    sha,
    dirty,
    // Only `full` mode may produce local_candidate:true.
    local_candidate: localCandidate,
  },
  // FR-P1-13/FR-P0-A: local source/package candidate vs deploy-ready vs
  // release-ready are distinct, machine-readable facts.
  production: {
    local_candidate: localCandidate,
    deploy_ready: deployReady,
    release_ready: releaseReady,
    preflight_checks: preflight.checks,
    preflight_local_clean: preflightLocalClean,
    preflight_no_skips: preflightNoSkips,
    smoke_receipt: smokeReceipt
      ? { git_sha: smokeReceipt.git_sha, worker_version_id: smokeReceipt.worker_version_id, recorded_at: smokeReceipt.recorded_at }
      : null,
    note: releaseReady
      ? "all three release tiers satisfied: local gates, verified remote migrations, exact-SHA smoke receipt"
      : deployReady
        ? "local gates passed AND remote migration state verified; record the post-deploy smoke receipt (release-smoke-receipt.json) to claim release_ready"
        : localCandidate
          ? "locally-verified source/package tier; deploy_ready additionally requires a fully-passing production preflight with the remote migration check run (CLOUDFLARE_API_TOKEN)."
          : "local gates failing or fast mode — not a local candidate",
  },
  gates,
  claim_tiers: {
    // The tier per claim is OWNED by docs/evidence-ledger.json; this file
    // only attests which LOCALLY_VERIFIED gates passed for THIS tree.
    registry: "docs/evidence-ledger.json",
    claims: ledgerSummary,
    locally_verified_by_this_run: gates
      .filter((g) => g.status === "PASS")
      .map((g) => g.name),
  },
};

const outPath = join(ROOT, "release-evidence.json");
writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
console.log(`\nevidence: ${outPath}`);
console.log(`mode: ${MODE}`);
console.log(`gates: ${sourceGates.filter((g) => g.status === "PASS").length}/${sourceGates.length} source/package gates passed` +
  (MODE === "fast" ? ` (${sourceGates.filter((g) => g.skipped).length} skipped in fast mode)` : ""));
console.log(`local_candidate: ${localCandidate}`);
let deployNote = "full mode required";
if (MODE === "full") {
  if (!preflightLocalClean) deployNote = "production preflight has FAILs";
  else if (!preflightNoSkips) deployNote = "preflight passed; remote migration check SKIPPED (no CLOUDFLARE_API_TOKEN)";
  else deployNote = "preflight passed + remote migrations verified";
}
console.log(`deploy_ready: ${deployReady} (${deployNote})`);
const releaseNote = !deployReady
  ? "deploy_ready required first"
  : smokeReceipt
    ? "smoke receipt matches this HEAD"
    : "record the post-deploy smoke receipt to claim release_ready";
console.log(`release_ready: ${releaseReady} (${releaseNote})`);
process.exit(allPassed ? 0 : 1);
