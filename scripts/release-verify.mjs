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
 * Only `full` may produce release_candidate:true.
 *
 * What this script deliberately does NOT do:
 *   - It does not run the LLM benchmark. Efficacy is a MEASURED item backed
 *     by a completed experiment directory, not a release gate.
 *   - It does not verify a remote deployment. That is user-gated (needs
 *     real credentials and an internet-facing origin).
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
 * Exit: 0 iff every gate passed. Evidence is written either way.
 *
 * Usage:
 *   npm run release:verify:fast
 *   npm run release:verify:full
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv[2] === "full" ? "full" : "fast";

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

// ── FR-P1-13: deterministic production preflight in the release evidence ──
// release_candidate above attests the LOCALLY VERIFIED source/package tier.
// "deploy-ready" additionally requires the deterministic production preflight
// (config gates, production-graph, prod dry-run) to pass AND the deploy-
// verifiable remote-migration check to not be skipped. With no Cloudflare
// token the remote check SKIPs, so deploy_ready stays false — a deploy cannot
// be certified deploy-ready against an unverifiable live database.
let preflight = { checks: [], passed: 0, skipped: 0, failed: 0, exit: -1 };
{
  const t0 = Date.now();
  const r = spawnSync("node", ["scripts/predeploy-production.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 5 * 60_000,
    shell: false,
  });
  try {
    preflight = JSON.parse(r.stdout);
    preflight.exit = r.status;
  } catch {
    // Preflight did not emit parseable JSON — treat as a failed gate.
    preflight = { checks: [], passed: 0, skipped: 0, failed: 0, exit: r.status };
  }
  // FR-P1-13: a DEPLOY gate, not a source/package gate. It is recorded in the
  // evidence and drives deploy_ready, but does NOT pull release_candidate: a
  // bad deploy config (a placeholder edge-limiter, an unlabelled env) must be
  // an operator action, not a false "the source is not a release candidate".
  // The code-bound halves of preflight (production-graph, prod dry-run) are
  // ALSO independently gated above/below so a code defect still fails the
  // release, not just the deploy.
  gates.push({
    name: "production-preflight",
    deploy_gate: true,
    command: "node scripts/predeploy-production.mjs --json",
    status: r.status === 0 && preflight.failed === 0 ? "PASS" : "FAIL",
    exit_code: r.status,
    duration_ms: Date.now() - t0,
    detail: `${preflight.passed} passed, ${preflight.skipped} skipped, ${preflight.failed} failed`,
  });
  console.log(`[${preflight.failed === 0 ? "PASS" : "FAIL"}] production-preflight (deploy gate) (${preflight.passed}p/${preflight.skipped}s/${preflight.failed}f)`);
}
const preflightLocalClean = preflight.failed === 0; // no FAIL in local determinism
const preflightNoSkips = preflight.skipped === 0;   // no SKIP (remote verified)

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

// FR-P1-13: release_candidate / exit code reflect the SOURCE/PACKAGE gates
// only. A deploy-gate (production-preflight) FAIL records in evidence and
// drives deploy_ready but does not make "the locally verified source is not a
// release candidate" — deploy config is an operator decision at deploy time.
const sourceGates = gates.filter((g) => !g.deploy_gate);
const allPassed = sourceGates.every((g) => g.status === "PASS");
const preflightGate = gates.find((g) => g.name === "production-preflight");

// P2: the claim registry lives in docs/evidence-ledger.json (validated by
// tests/unit/evidence-ledger.test.ts). This run only attests the
// LOCALLY_VERIFIED tier — the gates above — and embeds the ledger's tier
// summary verbatim so the evidence file can never drift from the registry.
let ledgerSummary;
try {
  const ledger = JSON.parse(
    readFileSync(join(ROOT, "docs", "evidence-ledger.json"), "utf-8")
  );
  ledgerSummary = Object.fromEntries(
    ledger.claims.map((c) => [c.id, c.tier])
  );
} catch {
  // Fail-closed: a missing or malformed registry is a release-blocking
  // inconsistency, not something to paper over with an empty summary.
  gates.push({
    name: "evidence-ledger",
    command: "read docs/evidence-ledger.json",
    status: "FAIL",
    exit_code: 1,
  });
  ledgerSummary = null;
}

// FR-P1-13 distinction: release_candidate is the LOCALLY VERIFIED source/
// package tier — a full clean local gate for this SHA. deploy_ready is a
// STRONGER claim: it additionally requires the deterministic production
// preflight to fully pass (no FAIL) AND no preflight SKIP — meaning the
// deploy-verifiable remote-migration state was actually checked (a live
// CLOUDFLARE_API_TOKEN), so this SHA is safe to deploy against the current
// live database. Without a token, deploy_ready is false even though the local
// candidate is sound: a deploy's permissions are decided at deploy time.
const deployReady =
  MODE === "full" && !dirty && allPassed &&
  preflightLocalClean && preflightNoSkips;

const evidence = {
  schema: "fireraid-release-evidence/3",
  mode: MODE,
  generated_at: new Date().toISOString(),
  git: {
    sha,
    dirty,
    // Only `full` mode may produce release_candidate:true.
    release_candidate: MODE === "full" && !dirty && allPassed,
  },
  // FR-P1-13: local source/package candidate vs deploy-ready against the live
  // database are now distinct, machine-readable facts.
  production: {
    deploy_ready: deployReady,
    preflight_checks: preflight.checks,
    preflight_local_clean: preflightLocalClean,
    preflight_no_skips: preflightNoSkips,
    note: deployReady
      ? "deterministic preflight passed AND remote migration state verified against the live database"
      : "release_candidate attests the locally-verified source/package tier; deploy_ready additionally requires a fully-passing production preflight with the remote migration check run (CLOUDFLARE_API_TOKEN).",
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
  (preflightGate ? `; production-preflight (deploy gate): ${preflightGate.status}` : "") +
  (MODE === "fast" ? ` (${sourceGates.filter((g) => g.skipped).length} skipped in fast mode)` : ""));
console.log(`release_candidate: ${evidence.git.release_candidate}`);
let deployReadyNote = "full mode required";
if (MODE === "full") {
  if (!preflightLocalClean) deployReadyNote = "production preflight has FAILs";
  else if (!preflightNoSkips) deployReadyNote = "preflight passed; remote migration check SKIPPED (no CLOUDFLARE_API_TOKEN)";
  else deployReadyNote = "preflight passed + remote migrations verified";
}
console.log(`deploy_ready: ${deployReady} (${deployReadyNote})`);
process.exit(allPassed ? 0 : 1);
