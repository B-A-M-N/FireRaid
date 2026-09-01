/**
 * P1-23 (updated) — production thesis after architecture correction.
 *
 * After P0-2: environment (production/lab) must NOT determine defense families.
 * Production profiles can and DO include the semantic family.
 *
 * What differs by mode:
 *   - lab (evaluationMode:true): artifacts.render renders all artifacts including
 *     semantic canary with lab-marked carriers
 *   - production (evaluationMode:false): artifacts.render renders semantic as null
 *     (S01–S08 are lab-only instructions; no neutral production form exists),
 *     but the profile CAN carry the semantic family for composition/evaluation
 *
 * This test verifies: lab renders the semantic canary; production renders no
 * semantic canary (because buildArtifactSet returns null semantic for S01–S08);
 * decoy carriers ARE present in both modes.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const TEST_SECRET = "test-secret-P1-23";

describe("P1-23 production thesis: mode controls rendering, not families", () => {
  it("FULL production profile renders no semantic canary (S01–S08 lab-only, FR-R7-013)", async () => {
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
      evaluationMode: false,
    });
    // No semantic canary in production (buildArtifactSet returns null for S01–S08).
    expect(html).not.toContain("data-fr-canary-id");
    expect(html).not.toContain("data-fr-placement");
    // Decoy family carriers ARE present.
    expect(html).toContain("<template"); // route notice
    expect(html).toContain(`name="${profile.decoyField?.fieldName}"`);
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
      evaluationMode: true,
    });
    expect(html).toContain("data-fr-canary-id");
    expect(html).toContain("data-fr-placement");
    expect(html).toContain("data-fr-route");
  });
});
