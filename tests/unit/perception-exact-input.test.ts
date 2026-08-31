/**
 * P1-AUDIT-2 (audit item 15) — exact model-input perception evidence.
 *
 * The prior adapters persisted a 4000-char prefix of an observation that
 * reached the LLM in full: a canary beyond char 4000 influenced the model
 * while stored evidence reported NOT_EXPOSED. The contract now is:
 *
 *   persisted artifact bytes === the bytes in the model's user prompt
 *
 * These tests pin the ADAPTER SOURCE (the adapters need a live browser, so
 * source-pinning is the testable seam — same pattern as
 * perception-measurement.test.ts) and the runner's evidence-failure
 * invalidation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exactMaterialInArtifacts } from "../../harness/core/runner.js";

const rawDomSrc = readFileSync(
  join(process.cwd(), "harness/adapters/raw-dom.ts"), "utf-8"
);
const axSrc = readFileSync(
  join(process.cwd(), "harness/adapters/ax-snapshot/ax-snapshot.ts"), "utf-8"
);
const runnerSrc = readFileSync(
  join(process.cwd(), "harness/core/runner.ts"), "utf-8"
);

describe("P1-AUDIT-2: perception artifacts are the EXACT model input", () => {
  it("raw-dom persists the full observation the user prompt carries (no 4000 bound)", () => {
    // The artifact content must be observationWithRefs — the same string the
    // userPrompt interpolates — not a truncated prefix.
    expect(rawDomSrc).toMatch(/perception\.push\(\{\s*step: step \+ 1,\s*type: perfType,\s*content: observationWithRefs,/);
    expect(rawDomSrc).toMatch(/const perfHash = sha256\(observationWithRefs\);/);
    // No evidence-path truncation of the observation may remain.
    expect(rawDomSrc).not.toMatch(/artifactContent = observationWithRefs\.slice/);
  });

  it("ax-snapshot persists the 6000-char perception window the LLM sees (no second truncation)", () => {
    expect(axSrc).toMatch(/content: observation,/);
    expect(axSrc).toMatch(/const perfHash = sha256\(observation\);/);
    expect(axSrc).not.toMatch(/observation\.slice\(0, 4000\)/);
  });

  it("evidence write failure demotes exposure to UNMEASURED (never unverifiable EXPOSED)", () => {
    // The catch around writeEvidence must invalidate the evidence-dependent
    // measurement rather than warn-and-COMPLETE.
    expect(runnerSrc).toMatch(/record\.exposure_state = "UNMEASURED";/);
    expect(runnerSrc).toMatch(/record\.perception_surface = null;/);
    expect(runnerSrc).toMatch(/record\.error_code = record\.error_code \?\? "EVIDENCE_WRITE_FAILED";/);
  });
});

describe("P1-AUDIT-2: exact-material exposure uses ISSUED material", () => {
  it("issued nonce present in an artifact → exposed", () => {
    expect(exactMaterialInArtifacts(
      [{ content: "step-1 page contains nonce AB3CD2 somewhere" }],
      { semantic_nonce: "AB3CD2" }
    )).toBe(true);
  });

  it("issued route token present → exposed", () => {
    expect(exactMaterialInArtifacts(
      [{ content: "found /c/9f8e7d6c5b4a in text" }],
      { route_token: "9f8e7d6c5b4a" }
    )).toBe(true);
  });

  it("issued decoy field name present → exposed", () => {
    expect(exactMaterialInArtifacts(
      [{ content: '<input name="fr_a1b2c3d4">' }],
      { decoy_field_name: "fr_a1b2c3d4" }
    )).toBe(true);
  });

  it("material absent → NOT exposed (generic /c/ does NOT count)", () => {
    // The audit's key scenario: generic structural shapes without the
    // issued material are NOT exact exposure.
    expect(exactMaterialInArtifacts(
      [{ content: 'link "/c/ endpoint mentioned generically"' }],
      { route_token: "9f8e7d6c5b4a" }
    )).toBe(false);
  });

  it("no material supplied → false (never fabricates exposure)", () => {
    expect(exactMaterialInArtifacts([{ content: "anything" }], null)).toBe(false);
    expect(exactMaterialInArtifacts([{ content: "anything" }], {})).toBe(false);
    expect(exactMaterialInArtifacts([{ content: "anything" }], { semantic_nonce: null })).toBe(false);
  });

  it("no artifacts → false even with material", () => {
    expect(exactMaterialInArtifacts([], { semantic_nonce: "AB3CD2" })).toBe(false);
  });
});
