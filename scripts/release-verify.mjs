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
 * Exit: 0 iff every source/package gate passed (or, with --require-tier
 * <t>, iff that release tier is satisfied AND the gates passed). Evidence
 * is written either way.
 *
 * Usage:
 *   npm run release:verify:fast
 *   npm run release:verify:full
 *   npm run release:verify            — full + --require-tier release_ready
 *   node scripts/release-verify.mjs full --require-tier deploy_ready
 *
 * FR-RR-50: the default `release:verify` (what a release job should run)
 * requires the release_ready tier — "gates passed but no tier satisfied"
 * can no longer exit 0.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

import { validatePreflightResult } from "./lib/preflight-schema.mjs";
import { isGitSha, isWorkerVersionId, productionConfig, VERSION_LOOKUP } from "./lib/release-proof.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv[2] === "full" ? "full" : "fast";
// FR-RR-50: an optional third argument REQUIRES a specific release tier —
// `node scripts/release-verify.mjs full --require-tier release_ready` exits
// 0 ONLY when that tier is actually satisfied. Without it the historical
// contract holds (exit 0 iff the source/package gates passed, regardless
// of tier). A release job MUST invoke it with --require-tier release_ready
// so "no tier satisfied" can never exit 0.
const requireTierArg = process.argv.indexOf("--require-tier");
const REQUIRE_TIER = requireTierArg !== -1 ? process.argv[requireTierArg + 1] : null;
const VALID_TIERS = ["local_candidate", "deploy_ready", "release_ready"];
let releaseWranglerConfig = null;
try {
  releaseWranglerConfig = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"), []);
} catch {
  // Receipt validation below fails closed if the authoritative production
  // config cannot be read.
}
const releaseProduction = productionConfig(releaseWranglerConfig);

// --- git provenance ---
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const sha = git(["rev-parse", "HEAD"]);
const dirty = (git(["status", "--porcelain"]) ?? "").length > 0;


const gates = [];
function runGate(name, command, args, { slow = false, demo = false } = {}) {
  if (slow && MODE === "fast") {
    gates.push({ name, command: [command, ...args].join(" "), status: "SKIPPED", skipped: true, ...(demo ? { demo_gate: true } : {}) });
    return;
  }
  const t0 = Date.now();
  const r = spawnSync(command, args, { cwd: ROOT, encoding: "utf-8", timeout: 15 * 60_000, shell: false });
  const passed = r.status === 0;
  // Closure 10: the origin-budget harness self-classifies ambient machine
  // load. When it reports timing scenarios UNMEASURED, the gate passed (a
  // loaded machine is not a product fact) but the evidence must record that
  // the timing budgets were NOT measured this run — never a silent PASS.
  let unmeasuredScenarios = null;
  if (name === "origin-budget" && /UNMEASURED \(ambient load/.test(r.stdout ?? "")) {
    const m = (r.stdout ?? "").match(/UNMEASURED \(ambient load[^)]*\):\s*(.+)/);
    unmeasuredScenarios = m ? m[1].trim() : "unknown";
  }
  gates.push({
    name,
    command: [command, ...args].join(" "),
    status: passed ? "PASS" : "FAIL",
    exit_code: r.status,
    duration_ms: Date.now() - t0,
    // FR-RR-36: demo-surface gates are tier-annotated on the record.
    ...(demo ? { demo_gate: true } : {}),
    ...(unmeasuredScenarios ? { unmeasured_ambient_load: unmeasuredScenarios } : {}),
    // Keep tails bounded — a failure's diagnosis belongs in CI logs, but a
    // short excerpt travels with the evidence file.
    output_tail: (r.stdout ?? "").split("\n").filter(Boolean).slice(-5)
      .concat((r.stderr ?? "").split("\n").filter(Boolean).slice(-5)),
  });
  console.log(
    `[${passed ? "PASS" : "FAIL"}] ${name} (${Math.round((Date.now() - t0) / 1000)}s)` +
    (unmeasuredScenarios ? ` [UNMEASURED under ambient load: ${unmeasuredScenarios}]` : "")
  );
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
    // FR-RR-11: the release gate computes its truth from the PRIMITIVE
    // observations (the per-check rows), never from a summary the producer
    // could miscount. SKIP is legal in LOCAL mode (the one legitimate
    // case: remote-migrations without a CLOUDFLARE_API_TOKEN) and is
    // handled explicitly by the deploy predicate below. FR-RR-18: the
    // full schema + exit-status validation lives in the EXPORTED
    // validatePreflightResult so release-machinery.test.ts exercises the
    // real predicate set behaviorally, not a source-grep of it.
    const verdict = validatePreflightResult(parsed, r.status);
    if (!verdict.ok) {
      preflightParseError = verdict.error;
    } else {
      preflight = verdict.preflight;
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
// FR-RR-02: deploy readiness is computed from the PER-CHECK rows, never an
// aggregate skip counter. The only check that may legitimately SKIP is
// remote-migrations in local mode (no CLOUDFLARE_API_TOKEN) — and that skip
// IS deploy-blocking (FR-P0-D: a deploy cannot be certified against an
// unverifiable live database). So deploy_ready requires the remote check
// specifically to have RUN and PASSED — not "zero SKIPs anywhere" (an
// unrelated, acceptable state must not block deploy) and not just "zero
// FAILs" (a SKIP must not silently equal verified).
const preflightRemoteVerified = (() => {
  const remote = preflight.checks.find((c) => c?.name === "remote-migrations");
  return remote?.status === "PASS";
})();

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
      // FR-RR-49: the receipt is DEPLOYMENT PROOF, not an attestation. The
      // runner (release-smoke-record.mjs) performs the probes and records
      // OBSERVED statuses; this validator demands the machine-observed
      // half (machine_checks, every check ok with a plausible observed
      // status), the operator-attested half (human_submit), HTTPS binding
      // to the deployed URL, a real Cloudflare version-id shape, and the
      // exact-SHA match against HEAD. The v1 attestation-only schema is
      // explicitly NOT accepted — it certified checks nobody performed.
      const schemaOk = parsed.schema === "fireraid-release-smoke-receipt/2";
      const requiredChecks = ["signup_page", "health_build", "submit_failclosed", "human_submit"];
      const mc = parsed.machine_checks ?? {};
      const mcEntries = Object.entries(mc);
      const unknownChecks = mcEntries.map(([n]) => n).filter((n) => !requiredChecks.includes(n));
      const missingOrFailing = requiredChecks.filter((c) => mc[c]?.ok !== true);
      const implausibleStatus = mcEntries
        .filter(([, c]) => !c || !Number.isInteger(c.observed_status) || c.observed_status < 100 || c.observed_status > 599)
        .map(([n]) => n);
      const attestation = parsed.operator_attestations?.human_submit;
      const attested = attestation?.attested === true && attestation?.observed_status === mc.human_submit?.observed_status;
      const operatorStatusOk = Number.isInteger(attestation?.observed_status) && attestation.observed_status >= 200 && attestation.observed_status < 300;
      let deployedUrl = null;
      try { deployedUrl = new URL(parsed.deployed_url); } catch { /* malformed */ }
      const httpsUrl = deployedUrl?.protocol === "https:" &&
        deployedUrl.hostname === releaseProduction.hostname &&
        deployedUrl.port === "" && deployedUrl.username === "" && deployedUrl.password === "" &&
        deployedUrl.pathname === "/" && deployedUrl.search === "" && deployedUrl.hash === "";
      const shaMatch = isGitSha(parsed.git_sha) && parsed.git_sha === sha;
      const workerVersionShape = isWorkerVersionId(parsed.worker_version_id);
      const versionVerified = parsed.version_verified;
      const versionProofOk = versionVerified?.ok === true &&
        versionVerified.worker_name === releaseProduction.workerName &&
        versionVerified.lookup === VERSION_LOOKUP;
      const buildShaOk = parsed.deployed_build_sha === sha &&
        mc.health_build?.observed_build_sha === sha;
      const failClosedProofOk = mc.submit_failclosed?.verification_status === "verification_required" &&
        mc.submit_failclosed.observed_status === 403;
      const fail =
        !schemaOk ? `receipt schema ${JSON.stringify(parsed.schema ?? null)} is not "fireraid-release-smoke-receipt/2" — re-run the smoke runner (the v1 attestation format is no longer accepted)`
          : !shaMatch ? `receipt git_sha ${parsed.git_sha} does not match HEAD ${sha}`
          : !workerVersionShape ? `receipt worker_version_id ${JSON.stringify(parsed.worker_version_id)} is not a Wrangler version id`
          : !releaseProduction.workerName ? "wrangler.jsonc production env lacks an explicit Worker name"
          : !versionProofOk ? `receipt version_verified does not prove ${parsed.worker_version_id} belongs to Worker ${releaseProduction.workerName} via ${VERSION_LOOKUP}`
          : !httpsUrl ? `receipt deployed_url is not the exact HTTPS production origin ${releaseProduction.hostname}`
          : !buildShaOk ? `receipt build SHA proof does not match HEAD ${sha}`
          : unknownChecks.length > 0 ? `receipt names unknown machine checks: ${unknownChecks.join(", ")}`
          : missingOrFailing.length > 0 ? `receipt machine checks failed/missing: ${missingOrFailing.join(", ")}`
          : implausibleStatus.length > 0 ? `receipt machine checks lack a plausible observed_status: ${implausibleStatus.join(", ")}`
          : !failClosedProofOk ? "receipt fail-closed check lacks the exact verification_required response"
          : !attested ? "receipt lacks the operator_attestations.human_submit attestation"
          : !operatorStatusOk ? "operator human-submit attestation is not a successful 2xx observation"
            : null;
      if (fail) {
        gate = {
          name: "release-smoke-receipt",
          release_tier_gate: true,
          command: "read release-smoke-receipt.json",
          status: "FAIL",
          exit_code: 1,
          duration_ms: Date.now() - t0,
          detail: fail,
        };
      } else {
        gate = {
          name: "release-smoke-receipt",
          release_tier_gate: true,
          command: "read release-smoke required checks",
          status: "PASS",
          exit_code: 0,
          duration_ms: Date.now() - t0,
          detail: `receipt matches HEAD ${sha}; worker_version_id ${parsed.worker_version_id}; machine-observed statuses ${requiredChecks.map((c) => `${c}=${mc[c].observed_status}`).join(", ")}`,
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
// FR-DEMO-04: the demo is gated like any other surface — its types
// typecheck and its paired smoke (Chromium e2e) runs in full mode. The
// demo does NOT gate the core-library release tiers below (a Chromium
// startup failure must not block a library release); it is reported as
// its own fact for the operator.
// FR-RR-36: the tier semantics are now EXPLICIT in the evidence. The demo
// gates carry `demo_gate: true` and are EXCLUDED from `sourceGates` (the
// local_candidate computation) by name-independent tier flags, so the
// exclusion is a property of the gate record, not of a string comparison
// in the tier math. Their result is surfaced as a separate `demo`
// evidence fact: a demo FAIL is a demo-surface fact for the operator,
// never a silent demotion of the library's release tier — and never a
// PASS that can be misread as a library gate.
runGate("demo-typecheck", "npm", ["run", "typecheck:demo"], { slow: true, demo: true });
runGate("demo-smoke", "npm", ["run", "test:demo"], { slow: true, demo: true });

// FR-P1-13: the three release tiers. local_candidate reflects the
// SOURCE/PACKAGE gates only. deploy_ready additionally requires the
// preflight deploy gate. release_ready additionally requires the external
// smoke receipt matching THIS HEAD.
// FR-RR-36: demo gates are excluded by their TIER FLAG (`demo_gate`), not
// by a name filter — the annotation is the contract.
const sourceGates = gates.filter((g) => !g.deploy_gate && !g.release_tier_gate && !g.demo_gate);
const demoGates = gates.filter((g) => g.demo_gate);
const demoPassed = demoGates.length > 0 && demoGates.every((g) => g.status === "PASS");
const allPassed = sourceGates.every((g) => g.status === "PASS");

const localCandidate = MODE === "full" && !dirty && allPassed;
const deployReady =
  MODE === "full" && !dirty && allPassed &&
  preflightLocalClean && preflightRemoteVerified;
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
    preflight_remote_migrations_verified: preflightRemoteVerified,
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
  // FR-RR-36: the demo is its OWN machine-readable fact — never folded into
  // the library release tiers, never silently absent. A demo FAIL here is
  // a demo-surface finding for the operator while the library tier stands
  // on the source/package gates alone.
  demo: {
    gated: demoGates.length > 0,
    passed: demoPassed,
    gates: demoGates.map((g) => ({ name: g.name, status: g.status })),
    note: demoGates.length === 0
      ? "demo gates skipped (fast mode) — no demo evidence this run"
      : demoPassed
        ? "demo typecheck + smoke passed (demo-surface fact; does not gate the library tiers)"
        : "demo FAILED — demo surface is broken; the library release tiers are unaffected by design",
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
  else if (!preflightRemoteVerified) deployNote = "preflight clean; remote migration check not PASSED (no CLOUDFLARE_API_TOKEN or check skipped) — run predeploy --deploy with a token";
  else deployNote = "preflight passed + remote migrations verified";
}
console.log(`deploy_ready: ${deployReady} (${deployNote})`);
const releaseNote = !deployReady
  ? "deploy_ready required first"
  : smokeReceipt
    ? "smoke receipt matches this HEAD"
    : "record the post-deploy smoke receipt to claim release_ready";
console.log(`release_ready: ${releaseReady} (${releaseNote})`);

// FR-RR-50: --require-tier gates the exit on the TIER, not just the source
// gates. The old exit (`allPassed ? 0 : 1`) could exit 0 with NO tier
// satisfied — fast mode, a dirty tree, or missing deploy evidence all
// yielded "green" while local_candidate/deploy_ready/release_ready were
// all false.
if (REQUIRE_TIER !== null) {
  if (!VALID_TIERS.includes(REQUIRE_TIER)) {
    console.error(`--require-tier: unknown tier "${REQUIRE_TIER}" (valid: ${VALID_TIERS.join(", ")})`);
    process.exit(2);
  }
  const satisfied =
    REQUIRE_TIER === "local_candidate" ? localCandidate
      : REQUIRE_TIER === "deploy_ready" ? deployReady
        : releaseReady;
  if (!satisfied) {
    console.error(
      `--require-tier ${REQUIRE_TIER}: NOT satisfied ` +
      `(local_candidate=${localCandidate}, deploy_ready=${deployReady}, release_ready=${releaseReady})`
    );
    process.exit(1);
  }
  console.log(`--require-tier ${REQUIRE_TIER}: satisfied`);
}
process.exit(allPassed ? 0 : 1);
