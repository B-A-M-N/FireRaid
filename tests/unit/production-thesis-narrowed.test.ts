/**
 * P1-23 (migrated) — the old "narrowed production thesis" is HISTORICAL.
 *
 * The superseded thesis said: production renders no semantic canary because
 * buildArtifactSet returns null semantic for lab-only templates (S01–S08).
 * That was an artifact of the era when the production random path could
 * draw lab-only templates and had to drop them at render time.
 *
 * The current architecture (P1-AUDIT-2 + P0 product/evaluation split):
 *   - The PRODUCTION random path draws ONLY production strategies
 *     (P02/P03/P04) and renders them as NEUTRAL full-action carriers —
 *     production semantic traps are real, not silently dropped.
 *   - Lab-only templates (S01–S08) remain evaluation-plane: rendering one
 *     at evaluationMode:false still yields NO greppable marker (the
 *     lab-only guard in buildArtifactSet — correct, unchanged), and the
 *     same profile at evaluationMode:true renders the greppable canary.
 *
 * What this test pins now:
 *   1. A lab-only template derived on the evaluation plane renders with
 *      markers under evaluationMode:true and leaves NO trace under :false.
 *   2. A production strategy renders in BOTH modes: neutral carriers under
 *      :false, greppable carriers under :true.
 *   3. The lab route notice (researcher-visible endpoint) appears under
 *      evaluationMode:true on BOTH mappers, never under :false.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const TEST_SECRET = "test-secret-P1-23";

const LAB_ONLY_RECIPE: DefenseRecipe = {
  families: ["semantic", "decoy-field", "decoy-route", "interaction"],
  semanticTemplate: "S06",
  placementId: "P01",
  semanticMode: "decoy",
  labOnly: true,
};

const BASE_HTML = '<!doctype html><html><body><form id="signup-form"></form></body></html>';

describe("P1-23 (migrated): lab-only templates are evaluation-plane; production strategies render everywhere", () => {
  it("S06 (lab-only) under evaluationMode:false leaves NO marker — the lab-only render guard holds", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p123-prod", mode: "lab" },
      LAB_ONLY_RECIPE
    );
    const html = renderSignupPage({
      html: BASE_HTML,
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    // No semantic canary in production rendering (lab-only template guard).
    expect(html).not.toContain("data-fr-canary-id");
    expect(html).not.toContain("data-fr-placement");
    // No production notice, no carrier vocabulary.
    expect(html).not.toContain("data-fire-raid-notice");
    expect(html).not.toMatch(/data-rt-|fr-hidden-neutral/);
    // Decoy field carrier IS present (profile-bound, hidden posture).
    expect(html).toContain(`name="${profile.decoyField?.fieldName}"`);
  });

  it("the SAME S06 profile under evaluationMode:true renders the greppable canary", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p123-lab", mode: "lab" },
      LAB_ONLY_RECIPE
    );
    const html = renderSignupPage({
      html: BASE_HTML,
      profile,
      csrfToken: "csrf-x",
      evaluationMode: true,
    });
    expect(html).toContain("data-fr-canary-id");
    expect(html).toContain("data-fr-placement");
    expect(html).toContain("fr-lab-banner");
    // Lab route notice: the researcher-visible endpoint marker, present on
    // BOTH mappers (the emission the P1 rewrite restored to parity).
    const host = referenceInject(BASE_HTML, profile, "csrf-x", true);
    for (const [label, page] of [["worker", html], ["host", host]] as const) {
      expect(page, label).toContain(`/c/${profile.decoyRoute!.endpointToken}`);
      expect(page, label).toContain("data-fr-route");
    }
  });

  it("a production strategy (P02+) renders in BOTH modes — production traps are real", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p123-prod-strategy", mode: "production" },
      { families: ["semantic", "decoy-field", "decoy-route"] }
    );
    expect(profile.semantic).toBeDefined();
    const prod = renderSignupPage({
      html: BASE_HTML,
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    // Production: neutral full-action carrier carrying the instruction.
    expect(prod).toContain(profile.semantic!.nonce);
    expect(prod).toMatch(/<template>[^<]+<\/template>/);
    expect(prod).not.toContain("data-fr-canary-id");

    // Lab: the same profile renders greppable carriers.
    const lab = referenceInject(BASE_HTML, profile, "csrf-x", true);
    expect(lab).toContain("data-fr-canary-id");
  });
});
