/**
 * P1-AUDIT-2 response (P1-4 / P1-5 / P1-6) — manifest hardening.
 *
 * P1-4 STRICT: unknown manifest keys previously passed schema (Zod strips
 * them) and silently dropped the intended treatment — a typo'd `recpie_id`
 * or a stale `recipes` key made the experiment run CONTROL believing it ran
 * FULL, with an on-disk manifest that looked authoritative. Unknown keys now
 * fail validation; nested objects are strict too.
 *
 * P1-4 cross-field: recipe_id XOR conditions (expandManifest resolves
 * `conditions ?? [recipe_id]` — declaring both is ambiguous and conditions
 * silently wins); min-1 matrix dimensions (an empty array expands to ZERO
 * trials, an experiment that runs nothing and "succeeds").
 *
 * P1-5 UNIQUENESS: duplicate conditions double-count the arm in every paired
 * analysis (["FULL","FULL","CONTROL"] runs FULL twice per cell); duplicate
 * agents/models/prompts/extractors/control_variants likewise inflate cells.
 *
 * P1-6 EXECUTION ORDER: trial_index is the runner's actual execution order —
 * re-indexed AFTER the blocked-randomization reordering, so analysis joining
 * on trial_index reads a sequence that really happened. Resume keys are
 * dimension-derived, so re-indexing cannot corrupt resume state.
 */
import { describe, it, expect } from "vitest";
import {
  validateManifest,
  expandManifest,
  type ExperimentManifest,
} from "../../harness/core/run-schema.js";

const VALID: ExperimentManifest = {
  id: "exp-strict-test",
  name: "test",
  seed: "seed-v1",
  target: { url: "http://localhost:8787" },
  repetitions: 2,
  timeout_ms: 1000,
  profile_version: 1,
  agents: ["raw-http"],
  models: ["FIRERAID_LLM_MODEL"],
  prompts: ["baseline"],
  conditions: ["CONTROL", "FULL"],
} as ExperimentManifest;

describe("P1-4: strict manifest schema", () => {
  it("a typo'd recpie_id FAILS (unknown key) instead of silently running CONTROL", () => {
    const bad = {
      ...VALID,
      recpie_id: "FULL", // typo — the intended arm silently dropped
    } as unknown;
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(" ")).toMatch(/recpie_id/);
    }
  });

  it("a stale recipes key FAILS (unknown key)", () => {
    const bad = {
      ...VALID,
      recipes: ["CONTROL", "FULL"], // pre-P1-20 field name
      conditions: ["CONTROL", "FULL"],
    } as unknown;
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(" ")).toMatch(/recipes/);
    }
  });

  it("an unknown key nested in target FAILS (nested strict)", () => {
    const bad = {
      ...VALID,
      target: { url: "http://localhost:8787", ledgerUrl: "http://x.invalid" },
    } as unknown;
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(" ")).toMatch(/ledgerUrl|target/);
    }
  });

  it("recipe_id AND conditions together FAIL (ambiguous identity — conditions silently wins)", () => {
    const bad = {
      ...VALID,
      recipe_id: "CONTROL",
      conditions: ["CONTROL", "FULL"],
    } as unknown;
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(" ")).toMatch(/mutually exclusive/);
    }
  });

  it("an empty matrix dimension FAILS (zero trials would 'succeed')", () => {
    for (const field of ["agents", "models", "prompts"] as const) {
      const bad = { ...VALID, [field]: [] } as unknown;
      const v = validateManifest(bad);
      expect(v.ok, `empty ${field} must fail`).toBe(false);
      if (!v.ok) {
        expect(v.errors.join(" ")).toMatch(new RegExp(field));
      }
    }
  });

  it("the valid baseline still validates (no false positives from strictness)", () => {
    const v = validateManifest({ ...VALID });
    expect(v.ok).toBe(true);
  });
});

describe("P1-5: uniqueness validations", () => {
  it("duplicate conditions FAIL (the arm would double-count in paired analyses)", () => {
    const bad = { ...VALID, conditions: ["FULL", "FULL", "CONTROL"] } as unknown;
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors.join(" ")).toMatch(/duplicate condition "FULL"/);
    }
  });

  it("duplicate agents/models/prompts FAIL", () => {
    for (const [field, value] of [
      ["agents", ["raw-http", "raw-http"]],
      ["models", ["m1", "m1"]],
      ["prompts", ["p1", "p1"]],
    ] as const) {
      const bad = { ...VALID, [field]: value, conditions: ["CONTROL"] } as unknown;
      const v = validateManifest(bad);
      expect(v.ok, `duplicate ${field} must fail`).toBe(false);
      if (!v.ok) {
        expect(v.errors.join(" ")).toMatch(/duplicate/);
      }
    }
  });

  it("duplicate extractors and control_variants FAIL", () => {
    const badEx = { ...VALID, extractors: ["raw-html", "raw-html"] } as unknown;
    expect(validateManifest(badEx).ok).toBe(false);
    const badCv = {
      ...VALID,
      conditions: ["CONTROL"],
      agents: ["human"],
      control_variants: ["normal", "normal"],
    } as unknown;
    expect(validateManifest(badCv).ok).toBe(false);
  });
});

describe("P1-6: trial_index is the execution order", () => {
  it("indexes are 0..n-1 and MATCH array position after blocked randomization", () => {
    const trials = expandManifest({
      ...VALID,
      agents: ["raw-http", "raw-dom"],
      prompts: ["baseline", "cautious"],
      conditions: ["CONTROL", "FULL", "DECOY_FIELD_ONLY"],
      repetitions: 3,
    });
    // The reordering is real (otherwise this assertion is vacuous): with
    // multiple cells the shuffled assembly cannot equal pure expansion order
    // for every seed — but we assert the INVARIANT regardless of layout.
    trials.forEach((t, position) => {
      expect(t.index).toBe(position);
    });
    // Determinism: the same manifest re-expands identically (resume).
    const again = expandManifest({
      ...VALID,
      agents: ["raw-http", "raw-dom"],
      prompts: ["baseline", "cautious"],
      conditions: ["CONTROL", "FULL", "DECOY_FIELD_ONLY"],
      repetitions: 3,
    });
    expect(again).toEqual(trials);
    // Completeness: every (condition × cell × repetition) survives, where a
    // cell is (agent × model × prompt × extractor × controlVariant) —
    // computed from the expansion itself (FR-R4-039: agents only vary the
    // dimensions they consume, so the cell count is adapter-dependent).
    const cells = new Set(
      trials.map((t) => `${t.agent}|${t.model}|${t.prompt}|${t.extractor ?? "-"}|${t.controlVariant ?? "-"}`)
    );
    expect(trials.length).toBe(3 /* conditions */ * cells.size * 3 /* reps */);
    for (const c of ["CONTROL", "FULL", "DECOY_FIELD_ONLY"]) {
      expect(trials.filter((t) => t.recipeId === c).length).toBe(cells.size * 3);
    }
  });
});
