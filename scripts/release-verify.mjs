#!/usr/bin/env node
/**
 * P2 — release gate aggregator: run every deterministic release gate and
 * write machine-readable evidence to release-evidence.json.
 *
 * What this script deliberately does NOT do:
 *   - It does not run the LLM benchmark. Efficacy is a MEASURED item backed
 *     by a completed experiment directory, not a release gate.
 *   - It does not verify a remote deployment. That is user-gated (needs
 *     real credentials and an internet-facing origin).
 *
 * Claims vocabulary (mirrors docs/RELEASE-STATUS.md):
 *   IMPLEMENTED       — code + a passing test exist for the claim
 *   LOCALLY VERIFIED  — a deterministic local gate passed for this tree
 *   MEASURED          — a completed, matched experiment supports the claim
 *   NOT YET ESTABLISHED — no evidence at the required tier
 *
 * Exit: 0 iff every gate passed. Evidence is written either way.
 *
 * Usage: npm run release:verify [-- --skip-slow]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_SLOW = process.argv.includes("--skip-slow");

// --- git provenance ---
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const sha = git(["rev-parse", "HEAD"]);
const dirty = (git(["status", "--porcelain"]) ?? "").length > 0;

const gates = [];
function runGate(name, command, args, { slow = false } = {}) {
  if (slow && SKIP_SLOW) {
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

// --- deterministic gates (fast → slow) ---
runGate("typecheck", "npm", ["run", "typecheck"]);
runGate("lint", "npm", ["run", "lint"]);
runGate("unit", "npm", ["run", "test:unit"], { slow: true });
runGate("product-boundary", "npm", ["run", "test:product"], { slow: true });
runGate("worker-isolation", "npm", ["run", "test:worker-isolation"]);
runGate("origin-budget", "npm", ["run", "test:origin-budget"]);

const allPassed = gates.every((g) => g.status === "PASS");

const evidence = {
  schema: "fireraid-release-evidence/1",
  generated_at: new Date().toISOString(),
  git: {
    sha,
    dirty,
    // A release candidate must be a clean tree; dirty evidence is still
    // written (for iteration) but flagged so it can never masquerade as a
    // candidate stamp.
    release_candidate: !dirty && allPassed,
  },
  gates,
  claim_tiers: {
    // These are the doc-level claim classifications — see
    // docs/RELEASE-STATUS.md. This file only attests the LOCALLY VERIFIED
    // tier; MEASURED claims require a completed experiment directory and
    // are recorded there, not here.
    locally_verified_by_this_run: gates.filter((g) => g.status === "PASS").map((g) => g.name),
    measured: "see docs/RELEASE-STATUS.md — requires a completed experiment (experiment.json status=COMPLETE with matched CONTROL/DEFENDED cells)",
    not_yet_established: [
      "autonomous-agent efficacy (real benchmark: CONTROL vs PRODUCTION_DEFAULT, matched cells)",
      "remote deployment smoke (user-gated)",
    ],
  },
};

const outPath = join(ROOT, "release-evidence.json");
writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
console.log(`\nevidence: ${outPath}`);
console.log(`gates: ${gates.filter((g) => g.status === "PASS").length}/${gates.length} passed` +
  (SKIP_SLOW ? ` (${gates.filter((g) => g.skipped).length} skipped)` : ""));
console.log(`release_candidate: ${evidence.git.release_candidate}`);
process.exit(allPassed ? 0 : 1);
