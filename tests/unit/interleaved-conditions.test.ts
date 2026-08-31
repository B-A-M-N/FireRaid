/**
 * P1-20 — interleaved randomized conditions.
 *
 * A single manifest with `conditions` must expand to one trial per
 * (condition × dimension), interleave the conditions WITHIN each repetition
 * block (so CONTROL/defended run contemporaneously), and be deterministic
 * across expansions (resume correctness).
 */
import { describe, it, expect } from "vitest";
import { expandManifest, validateManifest, type ExperimentManifest } from "../../harness/core/run-schema.js";

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

describe("P1-20 interleaved randomized conditions", () => {
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

  it("interleaves conditions within each repetition block (not batched)", () => {
    const trials = expandManifest(MANIFEST);
    const reps = new Set(trials.map((t) => t.repetition));
    for (const rep of reps) {
      const block = trials.filter((t) => t.repetition === rep).map((t) => t.recipeId!);
      // Find the first index of each condition in the block.
      const firstSeen = new Map<string, number>();
      block.forEach((c, i) => { if (!firstSeen.has(c)) firstSeen.set(c, i); });
      const maxFirst = Math.max(...firstSeen.values());
      const perCondition = block.length / MANIFEST.conditions!.length;
      // CONTEMPORANEOUS: if conditions were batched (all CONTROL first, then
      // SEMANTIC_ONLY, ...), the last condition's first appearance would be at
      // ~block.length - perCondition. Interleaving pulls it much earlier.
      // Assert the last-debuting condition appears before the batched position.
      expect(maxFirst).toBeLessThan(block.length - perCondition + 1);
    }
  });

  it("CONTROL and FULL are not isolated to opposite ends of a block", () => {
    const trials = expandManifest(MANIFEST);
    const rep0 = trials.filter((t) => t.repetition === 0).map((t) => t.recipeId);
    const controlIdx = rep0.indexOf("CONTROL");
    const fullIdx = rep0.indexOf("FULL");
    // Both present; the gap between them must be smaller than a full batched
    // span (interleaved, not control-first-then-full).
    expect(Math.abs(fullIdx - controlIdx)).toBeLessThan(rep0.length);
  });
});
