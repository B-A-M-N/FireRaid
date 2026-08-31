/**
 * P1-23 — production semantic mechanism decision (enforced, not a to-do).
 *
 * DECISION (owner-approved default): the production thesis is NARROWED to
 * decoy-field + decoy-route + interaction. All S01–S08 semantic instruction
 * templates are LAB-ONLY (FR-R7-013) and are NOT emitted in production. The
 * only "semantic" artifact that may appear in production is the S09 hidden
 * metadata marker, which is a measurement PROBE (not a defense) per its own
 * catalog doc (FR-R5-033) — it carries no instruction and is excluded from the
 * production defense score.
 *
 * This test ENFORCES that narrow thesis: a FULL-family production profile must
 * render NO semantic canary / instruction-bearing markup. Combined with
 * P1-22's opacity guard, the production page therefore carries no FireRaid-
 * identifying signature AND no semantic-instruction surface. The residual
 * profile-bound identifiers (fr_ field name, /c/ route prefix) are accepted
 * as measurement bindings consumed by submit.ts/canary.ts and are documented
 * in the status doc — they are not a "production semantic defense".
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const TEST_SECRET = "test-secret-P1-23";

describe("P1-23 production thesis is narrowed to decoy/behavior (no semantic instruction)", () => {
  it("FULL production profile renders no semantic canary / instruction markup", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p123-prod", mode: "lab" },
      {
        families: ["semantic", "decoy-field", "decoy-route", "interaction"],
        semanticTemplate: "S06",
        placementId: "P01",
        semanticMode: "decoy",
        labOnly: true,
      } satisfies DefenseRecipe
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: false,
    });
    // No semantic canary div in production (renderer returns "" for semantic
    // when !labMode).
    expect(html).not.toContain("data-fr-canary");
    expect(html).not.toContain("data-fr-placement");
    expect(html).not.toContain("data-fr-marker");
    // Decoy family carriers ARE present (the narrowed thesis).
    expect(html).toContain("<template"); // route notice (inert)
  });

  it("lab FULL profile still renders the semantic canary (measurement intact)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p123-lab", mode: "lab" },
      {
        families: ["semantic", "decoy-field", "decoy-route", "interaction"],
        semanticTemplate: "S06",
        placementId: "P01",
        semanticMode: "decoy",
        labOnly: true,
      } satisfies DefenseRecipe
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: true,
    });
    expect(html).toContain("data-fr-canary");
  });
});
