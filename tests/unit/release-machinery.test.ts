/**
 * FR-P0-A/B/C/D — release-machinery unit tests.
 *
 * The release scripts are the gate the gate: a bug there certifies broken
 * releases or blocks good ones. These tests pin the behaviors the re-review
 * flagged:
 *
 *   - classifyMigrationList: the backwards wrangler-output parser (P0-C) —
 *     current DB → current, outstanding rows → outstanding, auth/network
 *     garbage → unknown (fail closed).
 *   - release-smoke-record.mjs: receipt schema, exact-HEAD enforcement,
 *     required smoke checks (P0-A).
 *   - release-verify.mjs structural properties: the preflight gate is a
 *     DEPLOY gate (not a source gate), the receipt gate is a RELEASE-TIER
 *     gate, and the smoke receipt is untracked (never inside the git object
 *     it certifies).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { classifyMigrationList } = await import(
  join(ROOT, "scripts", "lib", "migrations.mjs")
);
const { EXPECTED_PREFLIGHT_CHECKS, validatePreflightResult } = await import(
  join(ROOT, "scripts", "lib", "preflight-schema.mjs")
);
const { summarizeGateEvidence } = await import(
  join(ROOT, "scripts", "lib", "release-proof.mjs")
);

// ── FR-RR-18: the preflight gate's schema + exit-status validation ──────
// These tests execute the REAL validator (extracted into
// scripts/lib/preflight-schema.mjs precisely so they could), not a
// source-grep of release-verify.mjs.

/** All-expected-IDs PASSing checks array with matching tallies. */
function validChecks(status: "PASS" | "SKIP" | "FAIL" = "PASS") {
  const checks = [...EXPECTED_PREFLIGHT_CHECKS].map((name) => ({ name, status }));
  return {
    checks,
    passed: checks.filter((c) => c.status === "PASS").length,
    skipped: checks.filter((c) => c.status === "SKIP").length,
    failed: checks.filter((c) => c.status === "FAIL").length,
  };
}

describe("FR-RR-18: validatePreflightResult (preflight schema + exit consistency)", () => {
  it("accepts a well-formed PASS result at exit 0 and derives the counts", () => {
    const v = validatePreflightResult(validChecks(), 0);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.preflight.failed).toBe(0);
      expect(v.preflight.passed).toBe(EXPECTED_PREFLIGHT_CHECKS.size);
      expect(v.preflight.exit).toBe(0);
    }
  });

  it("accepts the legitimate local-mode SKIP (remote-migrations, no token) at exit 0", () => {
    const parsed = validChecks();
    parsed.checks.find((c) => c.name === "remote-migrations")!.status = "SKIP";
    parsed.skipped = 1;
    parsed.passed -= 1;
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.preflight.skipped).toBe(1);
      expect(v.preflight.failed).toBe(0);
    }
  });

  it("REJECTS: producer exits NONZERO with ZERO FAIL rows (the half-implemented direction)", () => {
    const v = validatePreflightResult(validChecks(), 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("ZERO FAIL rows");
  });

  it("REJECTS: exit 0 with FAIL rows (the other direction)", () => {
    const parsed = validChecks();
    parsed.checks.find((c) => c.name === "dry-run")!.status = "FAIL";
    parsed.failed = 1;
    parsed.passed -= 1;
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("exited 0 while reporting 1 FAIL");
  });

  it("accepts a genuine failure: nonzero exit AND a FAIL row present", () => {
    const parsed = validChecks();
    parsed.checks.find((c) => c.name === "dry-run")!.status = "FAIL";
    parsed.failed = 1;
    parsed.passed -= 1;
    const v = validatePreflightResult(parsed, 1);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.preflight.failed).toBe(1);
  });

  it("REJECTS: an unknown EXTRA check id riding alongside the expected set", () => {
    const parsed = validChecks();
    parsed.checks.push({ name: "rogue-renamed-check", status: "PASS" });
    parsed.passed += 1;
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("unknown check id: rogue-renamed-check");
  });

  it("REJECTS: a duplicate check id", () => {
    const parsed = validChecks();
    parsed.checks.push({ name: "dry-run", status: "PASS" });
    parsed.passed += 1;
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("duplicate check id: dry-run");
  });

  it("REJECTS: an unknown status value", () => {
    const parsed = validChecks();
    (parsed.checks.find((c) => c.name === "lab-mode")! as { status: string }).status = "MAYBE";
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("unknown status");
  });

  it("REJECTS: a missing expected id (a silently renamed check never reads as absent = fine)", () => {
    const parsed = validChecks();
    parsed.checks = parsed.checks.filter((c) => c.name !== "production-graph");
    parsed.passed -= 1;
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("missing expected IDs: production-graph");
  });

  it("REJECTS: a check row without a name", () => {
    const parsed = validChecks();
    (parsed.checks[0] as { name?: string }).name = "";
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("lacks a name");
  });

  it("REJECTS: summary tallies that disagree with the checks array", () => {
    const parsed = validChecks();
    parsed.passed += 3; // producer miscounts
    const v = validatePreflightResult(parsed, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("summary counts disagree");
  });

  it("REJECTS: a parsed payload without a checks array", () => {
    expect(validatePreflightResult({}, 0).ok).toBe(false);
    expect(validatePreflightResult(null, 0).ok).toBe(false);
    // Synthesized fallback shape: empty checks with failed>=1 is structurally
    // invalid by schema but is only CONSTRUCTED after validation failed —
    // the validator itself must never bless it.
    const v = validatePreflightResult({ checks: [], passed: 0, skipped: 0, failed: 1 }, 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("missing expected IDs");
  });
});

describe("FR-P0-C: classifyMigrationList (wrangler d1 migrations list output)", () => {
  it("classifies a CURRENT database as current (the inverted-regex bug)", () => {
    // Real wrangler output for a fully-applied remote DB.
    const out = "🌀 Executing on remote database fireraid-production\n✅ No migrations to apply!";
    expect(classifyMigrationList(out)).toEqual({ kind: "current" });
  });

  it("classifies the bare current marker without emoji/decoration", () => {
    expect(classifyMigrationList("No migrations to apply!")).toEqual({ kind: "current" });
    expect(classifyMigrationList("No migrations found")).toEqual({ kind: "current" });
  });

  it("classifies ONE outstanding migration as outstanding, with its name", () => {
    const out = [
      "🌀 Executing on remote database fireraid-production",
      "┌─────────────────────────────┬───────────┐",
      "│ 0017_add_submission_claims  │ never     │",
      "└─────────────────────────────┴───────────┘",
    ].join("\n");
    const r = classifyMigrationList(out);
    expect(r.kind).toBe("outstanding");
    if (r.kind === "outstanding") {
      expect(r.count).toBe(1);
      expect(r.names[0]).toContain("0017_add_submission_claims");
    }
  });

  it("classifies MULTIPLE outstanding migrations as outstanding", () => {
    const out = "0016_add_index\n0017_add_submission_claims";
    const r = classifyMigrationList(out);
    expect(r.kind).toBe("outstanding");
    if (r.kind === "outstanding") {
      expect(r.count).toBe(2);
      expect(r.names).toEqual(["0016_add_index", "0017_add_submission_claims"]);
    }
  });

  it("classifies an auth failure as unknown (fail closed)", () => {
    const out = "✘ [ERROR] Failed to fetch — authentication required (code: 10000)";
    const r = classifyMigrationList(out);
    expect(r.kind).toBe("unknown");
  });

  it("classifies a network failure as unknown (fail closed)", () => {
    const r = classifyMigrationList("fetch failed: ETIMEDOUT");
    expect(r.kind).toBe("unknown");
  });

  it("classifies EMPTY output as unknown (fail closed)", () => {
    expect(classifyMigrationList("").kind).toBe("unknown");
    expect(classifyMigrationList(undefined)).toEqual(
      expect.objectContaining({ kind: "unknown" })
    );
  });

  it("classifies future-format garbage as unknown (fail closed)", () => {
    expect(classifyMigrationList("migrations: 0").kind).toBe("unknown");
    expect(classifyMigrationList("everything applied ✓✓✓").kind).toBe("unknown");
  });
});

describe("FR-P0-A/FR-RR-49: release-smoke-record.mjs (smoke RUNNER, not an attestation box)", () => {
  const SCRIPT = join(ROOT, "scripts", "release-smoke-record.mjs");

  function runRecord(args: string[]) {
    try {
      const stdout = execFileSync("node", [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stderr?: unknown };
      return { code: err.status ?? 1, stderr: String(err.stderr ?? "") };
    }
  }

  it("refuses a receipt whose git_sha is not exactly HEAD (no fixed-point bug)", () => {
    const r = runRecord([
      "--git-sha", "0000000000000000000000000000000000000000",
      "--worker-version", "a".repeat(32),
      "--human-submit-observed-status", "200",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("does not equal current HEAD");
  });

  it("FR-RR-49: refuses a nonsense worker-version id ('banana') before any network call", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const r = runRecord([
      "--git-sha", head,
      "--worker-version", "banana",
      "--human-submit-observed-status", "200",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("32 lowercase hex");
  });

  it("FR-RR-49: refuses a non-HTTPS URL", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const r = runRecord([
      "--git-sha", head,
      "--worker-version", "a".repeat(32),
      "--url", "http://fireraid-production.example.workers.dev",
      "--human-submit-observed-status", "200",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HTTPS");
  });

  it("FR-RR-49: refuses a URL whose hostname does not match the production TURNSTILE_EXPECTED_HOSTNAME", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf-8");
    const m = config.match(/TURNSTILE_EXPECTED_HOSTNAME"\s*:\s*"([^"]+)"/);
    if (!m) return; // no production hostname configured — the check cannot bind; skip
    const r = runRecord([
      "--git-sha", head,
      "--worker-version", "a".repeat(32),
      "--url", "https://not-the-production-host.example.com",
      "--human-submit-observed-status", "200",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("TURNSTILE_EXPECTED_HOSTNAME");
  });

  it("FR-RR-49: refuses to record without the operator's observed human-submit status", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const r = runRecord([
      "--git-sha", head,
      "--worker-version", "a".repeat(32),
      // no --human-submit-observed-status
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("human-submit-observed-status");
  });

  it("FR-RR-49: refuses an out-of-range human-submit observed status", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
    const r = runRecord([
      "--git-sha", head,
      "--worker-version", "a".repeat(32),
      "--human-submit-observed-status", "banana",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HTTP status");
  });
});

describe("FR-P0-A/B/D: release-verify.mjs structural contract", () => {
  const src = readFileSync(join(ROOT, "scripts", "release-verify.mjs"), "utf-8");

  it("validates the expected preflight check IDs (fail closed on missing)", () => {
    // FR-RR-18: the expected set lives in the shared schema module and the
    // script routes validation through it — the source must import the
    // real validator, not carry a private copy.
    for (const id of [
      "lab-mode",
      "production-db-id",
      "production-db-distinct",
      "production-hostname",
      "rate-limit-login-attested",
      "production-graph",
      "dry-run",
      "remote-migrations",
    ]) {
      expect(EXPECTED_PREFLIGHT_CHECKS.has(id), `expected check id ${id} listed`).toBe(true);
    }
    expect(src).toContain("lib/preflight-schema.mjs");
    expect(src).toContain("validatePreflightResult(parsed, r.status)");
  });

  it("fails closed on unparseable preflight stdout (never a zero-failure result)", () => {
    // The synthesized fallback must carry failed>=1, never a clean zero.
    expect(src).toMatch(/failed:\s*1/);
    expect(src).toContain("parse_error");
  });

  it("emits the three release tiers as separate machine-readable facts", () => {
    expect(src).toContain("local_candidate");
    expect(src).toContain("deploy_ready");
    expect(src).toContain("release_ready");
    // The tiers must be computed independently: release_ready requires the
    // receipt, deploy_ready does not.
    expect(src).toMatch(/releaseReady\s*=\s*deployReady\s*&&\s*smokeReceipt\s*!==\s*null/);
  });

  it("treats the smoke receipt as a RELEASE-TIER gate, not a source gate", () => {
    // No tracked-ledger deployed_sha gate may remain (the no-fixed-point bug).
    expect(src).not.toMatch(/name:\s*"remote-smoke-current"/);
    expect(src).not.toMatch(/name:\s*"smoke-evidence-recorded"/);
    // The receipt gate excludes itself from source gates.
    expect(src).toContain("release_tier_gate");
    expect(src).toMatch(/!g\.release_tier_gate/);
  });

  it("records ambient-load caveats without calling those gates locally verified", () => {
    const summary = summarizeGateEvidence([
      { name: "typecheck", status: "PASS" },
      {
        name: "origin-budget",
        status: "PASS",
        unmeasured_ambient_load: "profile-generation, signup-inject",
      },
    ]);
    expect(summary.locally_verified_by_this_run).toEqual(["typecheck"]);
    expect(summary.unmeasured_by_this_run).toEqual([
      {
        gate: "origin-budget",
        scenarios: "profile-generation, signup-inject",
      },
    ]);
  });

  it("keeps the production graph gate in normal CI", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");
    expect(workflow).toContain("npm run check:production-graph");
  });

  it("the receipt file is gitignored (external evidence by design)", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("release-smoke-receipt.json");
  });

  it("deploy:production runs the --deploy preflight (migrations cannot skip)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts["deploy:production"]).toContain("predeploy:production:deploy");
    expect(pkg.scripts["predeploy:production:deploy"]).toContain("--deploy");
    expect(pkg.scripts["predeploy:production"]).toContain("--local");
  });

  it("demo deployment is explicit and does not weaken the production command", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts["predeploy:demo"]).toContain("--demo");
    expect(pkg.scripts["deploy:demo"]).toContain("predeploy:demo");
    expect(pkg.scripts["deploy:demo"]).toContain("deploy-production.mjs --demo");
    expect(pkg.scripts["deploy:production"]).not.toContain("--demo");
  });
});

describe("FR-P0-B/D: predeploy-production.mjs contract", () => {
  const src = readFileSync(join(ROOT, "scripts", "predeploy-production.mjs"), "utf-8");

  it("--json mode writes exactly one JSON doc; human prose goes to stderr", () => {
    expect(src).toMatch(/if \(JSON_MODE\) process\.stderr\.write/);
    // No console.log in JSON paths: the success/failure notes route through note().
    expect(src).not.toMatch(/console\.log\("\npredeploy/);
  });

  it("deploy mode FAILS when the token is absent (no silent SKIP on a deploy)", () => {
    expect(src).toMatch(/DEPLOY_MODE[\s\S]{0,400}REQUIRES remote migration verification/);
  });

  it("parses migrations through classifyMigrationList (no inverted regex)", () => {
    expect(src).toContain("classifyMigrationList");
    expect(src).not.toMatch(/no migrations found\|No migrations\|unapplied/);
  });

  it("fails closed on unparseable wrangler output in both modes", () => {
    expect(src).toMatch(/UNPARSEABLE/);
  });

  it("only demo mode may bypass the tracked edge-limiter placeholder", () => {
    expect(src).toContain("DEMO_MODE");
    expect(src).toContain("demo mode permits the tracked");
    expect(src).toMatch(/if \(DEMO_MODE\) \{[\s\S]*?skip\("rate-limit-login-attested"/);
  });

  it("demo deploy injects the runtime showcase override", () => {
    const deploy = readFileSync(join(ROOT, "scripts", "deploy-production.mjs"), "utf-8");
    expect(deploy).toContain('"FIRERAID_DEMO_MODE:true"');
    expect(deploy).toContain("`FIRERAID_BUILD_SHA:${sha}`");
    expect(deploy).toContain("if (DEMO_MODE)");
  });
});
