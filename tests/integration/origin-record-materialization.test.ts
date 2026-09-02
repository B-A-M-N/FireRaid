/**
 * P1-AUDIT-2 (P0-3) — origin-ledger RunRecords carry their ASSIGNED
 * treatment identity.
 *
 * The analyzer's grouping rule is: group by recipe_id when records have it,
 * else fall back to defense_families. Origin-ledger records used to carry
 * NEITHER at creation (profile_id "pending-reconciliation", families [],
 * no recipe_id) — a real blocked-randomized run collapsed into a single
 * BASELINE group and the experiment measured nothing.
 *
 * This drives the REAL runExperiment() end-to-end (manifest → expand →
 * executeTrial → Recorder → RunRecord JSON files) over the origin-ledger
 * runtime with two conditions, then loads the RECORD FILES and asserts
 * treatment identity + group separability. expandManifest-level assertions
 * would NOT catch the defect — it is in record materialization.
 *
 * Raw-http agent: model-agnostic, no LLM, fast, deterministic.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const SECRET = "origin-record-test-secret".padEnd(32, "x");

// runExperiment resolves harness paths from process.cwd() and writes into
// harness/results — run the REAL repo runner as a subprocess so the test
// tree stays clean and the dirty-repo gate sees the real repo state.
const REPO = process.cwd();

const MANIFEST = {
  id: "exp-origin-record-test",
  name: "Origin record materialization test",
  seed: "record-materialization-seed",
  target: { url: "http://placeholder.invalid", mode: "origin-ledger" },
  repetitions: 1,
  timeout_ms: 15_000,
  max_steps: 5,
  fixture: "default",
  profile_version: 1,
  agents: ["raw-http"],
  models: ["none"],
  prompts: ["baseline"],
  conditions: ["CONTROL", "PRODUCTION_DEFAULT"],
  retry_failed: false,
  model_config: {},
  holdout_mode: false,
  control_variants: ["normal"],
};

function resultDir(): string {
  return join(REPO, "harness", "results", MANIFEST.id);
}

afterAll(() => {
  rmSync(resultDir(), { recursive: true, force: true });
});

describe("P0-3: origin-ledger records carry assigned treatment identity", () => {
  it("runExperiment() writes recipe_id per record and the analyzer can separate groups", async () => {
    // The runner enforces a clean tree (FR-R4-082); the gate env mirrors
    // what a developer running an experiment mid-work would set.
    const env = {
      ...process.env,
      FIRERAID_ALLOW_DIRTY: "1",
      FIRERAID_PROFILE_SECRET: SECRET,
      // No FIRERAID_LLM_MODEL needed: raw-http is model-agnostic.
    };

    const tmp = mkdtempSync(join(tmpdir(), "fr-rec-"));
    const manifestPath = join(tmp, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(MANIFEST));

    try {
      execFileSync("npx", ["tsx", "harness/core/runner.ts", manifestPath], {
        cwd: REPO,
        env,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Load the ACTUAL record files (not expandManifest output).
    expect(existsSync(resultDir())).toBe(true);
    const files = readdirSync(resultDir()).filter(
      (f) => f.endsWith(".json") && f !== "resume.json" && f !== "experiment.json"
    );
    expect(files.length).toBe(2);
    // P0-6: the endpoint-protocol declaration sidecar the analyzer reads.
    const declaration = JSON.parse(
      readFileSync(join(resultDir(), "experiment.json"), "utf-8")
    ) as { target_mode?: string };
    expect(declaration.target_mode).toBe("origin-ledger");

    const records = files.map((f) =>
      JSON.parse(readFileSync(join(resultDir(), f), "utf-8")) as Record<string, unknown>
    );

    const byRecipe = new Map<string, Record<string, unknown>[]>();
    for (const r of records) {
      expect(r.recipe_id, "record must carry its assigned recipe_id").toBeTypeOf("string");
      const group = (byRecipe.get(r.recipe_id as string) ?? []);
      group.push(r);
      byRecipe.set(r.recipe_id as string, group);
    }

    // Two DISTINCT treatment groups — the analyzer's recipe_id branch finds
    // exactly CONTROL and PRODUCTION_DEFAULT, never a collapsed BASELINE.
    expect([...byRecipe.keys()].sort()).toEqual(["CONTROL", "PRODUCTION_DEFAULT"]);
    expect(byRecipe.get("CONTROL")).toHaveLength(1);
    expect(byRecipe.get("PRODUCTION_DEFAULT")).toHaveLength(1);

    // Origin truth was reconciled for both trials (raw-http against the
    // facade: CONTROL forwards → account created; PRODUCTION_DEFAULT on a
    // clean raw-http form may ACCEPT or be flagged — either way the probe
    // must have returned an authoritative boolean).
    for (const r of records) {
      expect(r.origin_reconciled).toBe(true);
      expect(r.origin_account_created).toBeTypeOf("boolean");
      // P0-4: server-side (middleware) truth was captured independently.
      expect(r.server_reconciled).toBe(true);
      expect(r.profile_id).not.toBe("pending-reconciliation");
    }

    // P0-12: exact issued treatment material landed on the defended record.
    const full = byRecipe.get("PRODUCTION_DEFAULT")![0];
    const tm = full.treatment_material as Record<string, unknown>;
    expect(tm).toBeDefined();
    expect(Object.keys(tm).length).toBeGreaterThan(0);

    // The CONTROL record must show zero families and (since raw-http's
    // clean form carries no defense material) an ACCEPT from the middleware.
    const control = byRecipe.get("CONTROL")![0];
    expect(control.defense_families).toEqual([]);
    expect(control.disposition).toBe("ACCEPT");

    // Analyzer grouping sanity (the Python rule the records must satisfy):
    // mirror of group_runs' recipe_id branch — both records group by their
    // own recipe_id, no record falls into NO_RECIPE/BASELINE.
    for (const r of records) {
      expect(r.recipe_id).not.toBe("NO_RECIPE");
      expect(r.recipe_id).not.toBe("BASELINE");
    }
  }, 180_000);
});
