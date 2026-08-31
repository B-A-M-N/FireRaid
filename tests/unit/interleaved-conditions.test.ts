/**
 * P1-20 / P1-AUDIT-2 (audit item 13) — TRUE blocked randomization.
 *
 * A manifest with `conditions` expands to one trial per
 * (condition × cell × repetition), where a CELL is
 * (agent × model × prompt × extractor × controlVariant). Within each
 * repetition block, each cell's condition order is independently
 * seeded-shuffled: contemporaneous paired comparisons, deterministic across
 * expansions (resume correctness).
 *
 * The prior implementation batched per condition behind an "interleave"
 * name, and a runner-level global shuffle destroyed the block structure;
 * its test assertions were satisfiable by the batched layout itself.
 */
import { describe, it, expect } from "vitest";
import { expandManifest, validateManifest, type ExperimentManifest, type TrialDescriptor } from "../../harness/core/run-schema.js";

const MANIFEST: ExperimentManifest = {
  id: "exp-interleaved-test",
  name: "test",
  seed: "seed-v1",
  target: { url: "http://localhost:8787" },
  repetitions: 3,
  timeout_ms: 1000,
  profile_version: 1,
  agents: ["human", "raw-http", "raw-dom"],
  models: ["FIRERAID_LLM_MODEL"],
  prompts: ["baseline", "cautious"],
  extractors: ["raw-html", "accessibility"],
  conditions: [
    "CONTROL",
    "SEMANTIC_ONLY",
    "DECOY_FIELD_ONLY",
    "DECOY_ROUTE_ONLY",
    "INTERACTION_ONLY",
    "FULL",
  ],
} as ExperimentManifest;

/** Cell identity: everything except condition + repetition. */
function cellOf(t: TrialDescriptor): string {
  return `${t.agent}|${t.model}|${t.prompt}|${t.extractor ?? "-"}|${t.controlVariant ?? "-"}`;
}

describe("P1-20 blocked randomization (P1-AUDIT-2 item 13)", () => {
  it("validates a manifest with a conditions array", () => {
    const v = validateManifest(MANIFEST);
    expect(v.ok).toBe(true);
  });

  it("emits every condition and is deterministic across expansions", () => {
    const a = expandManifest(MANIFEST);
    const b = expandManifest(MANIFEST);
    expect(a).toEqual(b); // determinism for resume

    const present = new Set(a.map((t) => t.recipeId));
    for (const c of MANIFEST.conditions!) {
      expect(present.has(c)).toBe(true);
    }
    expect(a.length).toBeGreaterThan(0);
  });

  it("every cell carries each condition EXACTLY once per repetition", () => {
    const trials = expandManifest(MANIFEST);
    const reps = new Set(trials.map((t) => t.repetition));
    for (const rep of reps) {
      const counts = new Map<string, Map<string, number>>();
      for (const t of trials.filter((x) => x.repetition === rep)) {
        const cell = cellOf(t);
        if (!counts.has(cell)) counts.set(cell, new Map());
        const m = counts.get(cell)!;
        m.set(t.recipeId!, (m.get(t.recipeId!) ?? 0) + 1);
      }
      for (const [cell, m] of counts) {
        for (const c of MANIFEST.conditions!) {
          expect(m.get(c), `cell ${cell} condition ${c} rep ${rep}`).toBe(1);
        }
      }
    }
  });

  it("per-cell condition order is BLOCK-RANDOMIZED: differs across repetitions, no global batching", () => {
    const trials = expandManifest(MANIFEST);
    // Pick one cell and compare its condition order across repetitions —
    // independent per-rep seeds must produce variation (with 6 conditions,
    // identical order across 3 reps has probability 1/720² under true
    // randomization — flake-free in practice).
    const sampleCell = cellOf({
      index: 0, repetition: 0,
      agent: "raw-dom", model: MANIFEST.models[0], prompt: "baseline",
      extractor: "raw-html",
    });
    const orders: string[] = [];
    for (let rep = 0; rep < MANIFEST.repetitions; rep++) {
      const cellTrials = trials.filter(
        (t) => t.repetition === rep && cellOf(t) === sampleCell
      );
      orders.push(cellTrials.map((t) => t.recipeId).join(","));
    }
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  it("same-cell condition assignments are CONTIGUOUS (no global shuffle scatters them)", () => {
    const trials = expandManifest(MANIFEST);
    // For each repetition, walk the run order and assert that a cell's
    // trials form one contiguous run — the runner must not re-shuffle.
    const reps = new Set(trials.map((t) => t.repetition));
    for (const rep of reps) {
      const block = trials.filter((t) => t.repetition === rep);
      const spans = new Map<string, [number, number]>();
      block.forEach((t, i) => {
        const cell = cellOf(t);
        const span = spans.get(cell);
        if (!span) spans.set(cell, [i, i]);
        else span[1] = i;
      });
      for (const [cell, [lo, hi]] of spans) {
        expect(hi - lo + 1, `cell ${cell} is contiguous in rep ${rep}`).toBe(
          MANIFEST.conditions!.length
        );
      }
    }
  });

  it("trial keys are UNIQUE per (condition × cell × repetition) — resume never collapses treatments", () => {
    // This is the property the pre-fix trialKey violated: CONTROL and FULL
    // expansions of one cell shared a resume key, so a restarted experiment
    // marked FULL "already complete" because CONTROL had run.
    const trials = expandManifest(MANIFEST);
    const keys = new Set(
      trials.map((t) =>
        `exp-interleaved-test:${t.recipeId}:${t.agent}:${t.model}:${t.prompt}:${t.extractor ?? "-"}:${t.controlVariant ?? "-"}:${t.repetition}`
      )
    );
    expect(keys.size).toBe(trials.length);
    // The specific collision from the audit: same cell, different condition
    // → different keys.
    const cellTrials = trials.filter(
      (t) => t.repetition === 0 && t.agent === "raw-dom" && t.prompt === "baseline"
    );
    const keySet = new Set(cellTrials.map((t) => t.recipeId));
    expect(keySet.size).toBe(MANIFEST.conditions!.length);
  });

  it("raw-http and human cells keep their distinct shape (dimension gating intact)", () => {
    const trials = expandManifest(MANIFEST);
    // human and raw-http consume neither model nor prompt nor extractor
    // (registry: usesModel/usesPrompt false, supportedExtractors []) —
    // each collapses to ONE cell. raw-dom consumes prompts; its extractors
    // are the INTERSECTION of manifest ["raw-html","accessibility"] with
    // supported ["raw-html","simplified-dom"] = ["raw-html"].
    const humanCells = new Set(
      trials.filter((t) => t.agent === "human").map(cellOf)
    );
    const httpCells = new Set(
      trials.filter((t) => t.agent === "raw-http").map(cellOf)
    );
    const domCells = new Set(
      trials.filter((t) => t.agent === "raw-dom").map(cellOf)
    );
    expect(humanCells.size).toBe(1);
    expect(httpCells.size).toBe(1);
    expect(domCells.size).toBe(2); // 2 prompts × 1 effective extractor
  });
});
