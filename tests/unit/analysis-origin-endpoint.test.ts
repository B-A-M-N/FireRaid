/**
 * P1-AUDIT-2 (P0-5/P0-6) — analyzer origin-endpoint truth.
 *
 * Drives the REAL analyze.py as a subprocess over fixture records and
 * asserts the report's primary endpoint is ORIGIN account creation, not the
 * `submitted` proxy:
 *
 *   divergence   — records with submitted=true, origin_account_created=false
 *                  MUST report account creation 0% while the proxy shows
 *                  100% (if they don't diverge, the test isn't testing the
 *                  core mistake)
 *   coverage     — unmeasured assignable records are EXCLUDED from the
 *                  origin denominator (1 created of 5 measured over 10
 *                  assignable ⇒ 20%, not 10%) and the coverage line says so
 *   basis label  — worker-mode records (no origin truth) label the endpoint
 *                  as the submission proxy, never as account creation
 *
 * Python's analyze.py is the authoritative analyzer (run-metrics.ts mirrors
 * it for admin), so the contract is pinned at the Python boundary.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ANALYZER = join(process.cwd(), "harness", "analysis", "analyze.py");
const tmpRoots: string[] = [];

afterAll(() => {
  for (const t of tmpRoots) rmSync(t, { recursive: true, force: true });
});

/** A minimal reconciled origin-mode record with overridable truth fields. */
function record(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: `run-${Math.random().toString(36).slice(2, 10)}`,
    experiment_id: "exp-analyze-origin",
    trial_index: 0,
    repetition: 0,
    agent: "raw-http",
    model: "none",
    prompt_variant: "baseline",
    profile_version: 1,
    profile_id: "profile-x",
    recipe_id: "CONTROL",
    defense_families: [],
    submitted: false,
    canary_exposed: false,
    canary_referenced: false,
    canary_generic_referenced: false,
    canary_requested_client: false,
    canary_verified_server: false,
    exposure_state: "NOT_EXPOSED",
    perception_surface: "transport-html",
    server_reconciled: true,
    origin_reconciled: true,
    origin_account_created: false,
    origin_ledger_mode: "read-only-probe",
    outcome: "submitted",
    action_count: 2,
    elapsed_ms: 100,
    error_code: null,
    node_version: process.version,
    adapter_version: "0.1.0",
    lab_mode: false,
    started_at: 1,
    completed_at: 2,
    ...over,
  };
}

function runAnalyzer(recordsDir: string): string {
  return execFileSync(
    "python3",
    [ANALYZER, "exp-analyze-origin", "--endpoints", "--records-dir", recordsDir],
    { encoding: "utf-8", timeout: 60_000 }
  );
}

function makeDataset(records: Record<string, unknown>[]): string {
  const tmp = mkdtempSync(join(tmpdir(), "fr-analyze-"));
  tmpRoots.push(tmp);
  const dir = join(tmp, "exp-analyze-origin");
  mkdirSync(dir, { recursive: true });
  records.forEach((r, i) => writeFileSync(join(dir, `run-${i}.json`), JSON.stringify(r)));
  return dir;
}

describe("P0-5/P0-6: analyzer origin-endpoint truth", () => {
  it("submitted=true but origin_account_created=false ⇒ creation 0%, proxy 100%", () => {
    // The core divergence: FireRaid says "forwarded" while the origin says
    // "no account". The PRIMARY endpoint must follow the ORIGIN.
    const dir = makeDataset([
      // CONTROL: submitted + created (the baseline flow works).
      record({ recipe_id: "CONTROL", submitted: true, origin_account_created: true }),
      // PRODUCTION_FULL: submitted=true (middleware forwarded) but the
      // origin ledger shows NO account — the exact case where `submitted`
      // lies about creation.
      record({ recipe_id: "PRODUCTION_FULL", submitted: true, origin_account_created: false, defense_families: ["decoy-field", "decoy-route", "interaction"] }),
    ]);

    const out = runAnalyzer(dir);
    // console.log(out); // uncomment while debugging the fixture

    // CONTROL arm: BOTH truths measured.
    expect(out).toMatch(/CONTROL: 100\.0%/);
    // Divergence must be VISIBLE: proxy prints next to the origin rate.
    expect(out).toMatch(/submission proxy \(secondary, for divergence\): 100\.0%/);
    // The defended arm's origin rate is 0% — a 100% ARR against CONTROL.
    expect(out).toMatch(/PRODUCTION_FULL\s+0\.0%\s+100\.0%/);
    // Endpoint basis is the origin, never unlabeled proxy.
    expect(out).toMatch(/endpoint basis: origin_account_creation/);
  });

  it("unmeasured assignable records are EXCLUDED from the origin denominator", () => {
    // P0-6: 10 assignable trials, 5 measured (1 created), 5 legacy records
    // with NO origin fields. Old code: 1/10 = 10%. Correct: 1/5 = 20%.
    const measured: Record<string, unknown>[] = [
      record({ recipe_id: "CONTROL", submitted: true, origin_account_created: true }),
    ];
    const unmeasuredLegacy: Record<string, unknown>[] = Array.from({ length: 4 }, () =>
      record({
        recipe_id: "CONTROL",
        // Legacy worker-plane record: no origin truth at all.
        origin_reconciled: undefined,
        origin_account_created: undefined,
        origin_ledger_mode: undefined,
      })
    );
    const dir = makeDataset([...measured, ...unmeasuredLegacy]);

    const out = runAnalyzer(dir);
    // Coverage line reports 1/5 eligible-of-assignable = 20%... of the
    // CONTROL arm here (all 5 records are CONTROL).
    expect(out).toMatch(/origin measurement coverage: 20\.0%/);
    // With only one origin-measured record (a creation), the primary rate
    // is 100% over the ELIGIBLE denominator — not 20% over assignable.
    expect(out).toMatch(/CONTROL: 100\.0%.*n_eligible=1/);
  });

  it("worker-mode records (no origin truth anywhere) label the endpoint as the proxy", () => {
    const dir = makeDataset([
      record({
        recipe_id: "CONTROL",
        origin_reconciled: undefined,
        origin_account_created: undefined,
        origin_ledger_mode: undefined,
        submitted: true,
      }),
      record({
        recipe_id: "PRODUCTION_FULL",
        origin_reconciled: undefined,
        origin_account_created: undefined,
        origin_ledger_mode: undefined,
        submitted: false,
        defense_families: ["decoy-field", "decoy-route", "interaction"],
        disposition: "QUARANTINE",
      }),
    ]);

    const out = runAnalyzer(dir);
    expect(out).toMatch(/submission proxy \(NO origin truth in dataset — NOT account creation\)/);
  });

  it("a declared origin-ledger dataset with incomplete coverage INVALIDATES the endpoint", () => {
    // P0-6 strict mode: 2 assignable records, only 1 carries origin truth.
    // The report must prominently refuse to present the endpoint as valid.
    const dir = makeDataset([
      record({ recipe_id: "CONTROL", submitted: true, origin_account_created: true }),
      record({
        recipe_id: "PRODUCTION_FULL",
        // Assignable (no infra failure) but origin truth absent — a probe
        // gap the protocol does not excuse for a declared origin experiment.
        origin_reconciled: undefined,
        origin_account_created: undefined,
        origin_ledger_mode: undefined,
      }),
    ]);
    // The runner's declaration sidecar marks this dataset origin-ledger.
    // makeDataset roots at the records dir itself, so write it there.
    writeFileSync(join(dir, "experiment.json"), JSON.stringify({
      experiment_id: "exp-analyze-origin",
      target_mode: "origin-ledger",
      manifest_hash: "test-hash",
    }));

    const out = runAnalyzer(dir);
    expect(out).toMatch(/ORIGIN ENDPOINT INVALID/);
    expect(out).toMatch(/1\/2\s+assignable/);
  });
});
