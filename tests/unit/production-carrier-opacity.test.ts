/**
 * P1-22 — opaque production carriers.
 *
 * Verifies that, in PRODUCTION (labMode:false), the rendered signup page
 * carries NO FIXED, greppable FireRaid-identifying presentation signature that
 * an attacker could hardcode-detect in the visible DOM/markup:
 *   - no data-fr-* attribute (markers/route/placement/prod-notice/token)
 *   - no "fr-decoy" class
 *   - no visible "/c/<token>" text in the route/semantic markup
 *
 * Lab mode (labMode:true) KEEPS the explicit markers (so researchers can grep
 * the DOM and verify the rendered token). This test is the regression guard
 * for P1-22.
 *
 * EXPLICIT P1-23 RESIDUAL (surfaced, not hidden): the decoy FIELD NAME
 * (profile.decoyField.fieldName, e.g. "fr_a1b2") and the ROUTE PATH PREFIX
 * ("/c/") are profile/server-bound identifiers consumed by submit.ts and
 * canary.ts. P1-22 leaves them intact; stripping the "fr_" prefix from the
 * field name and the "/c/" prefix from the route is the P1-23 product
 * decision (requires profile-generation + canary-binding changes). This test
 * ASSERTS their presence in production so the residual is visible, not silent.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const TEST_SECRET = "test-secret-P1-22";

const FULL_RECIPE: DefenseRecipe = {
  families: ["semantic", "decoy-field", "decoy-route", "interaction"],
  semanticTemplate: "S06",
  placementId: "P01",
  semanticMode: "decoy",
  labOnly: true,
};

function opaqueAssertions(html: string, label: string) {
  if (html.includes("data-fr-")) {
    throw new Error(`[${label}] production page leaks data-fr-* signature: ${html.match(/data-fr-[a-z-]*=/i)?.[0]}`);
  }
  if (html.includes("fr-decoy")) {
    throw new Error(`[${label}] production page leaks fr-decoy class`);
  }
  if (/\/c\/[0-9a-f]+/.test(html)) {
    throw new Error(`[${label}] production page leaks visible /c/<token> text`);
  }
}

describe("P1-22 opaque production carriers", () => {
  it("production rendering leaks no fixed FireRaid presentation signature", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-prod", mode: "lab" },
      FULL_RECIPE
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: false,
    });
    opaqueAssertions(html, "FULL/production");
  });

  it("lab rendering KEEPS the explicit markers (so research can grep them)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-lab", mode: "lab" },
      FULL_RECIPE
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: true,
    });
    expect(html).toContain("data-fr-");
    expect(html).toContain("fr-decoy");
    expect(html).toContain("fr-lab-banner");
    expect(html).toContain("/c/");
  });

  it("production preserves the profile-bound field NAME (P1-23 residual, visible not hidden)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-field", mode: "lab" },
      { families: ["decoy-field"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: false,
    });
    opaqueAssertions(html, "DECOY_FIELD_ONLY/production");
    // Honest residual: the fr_<hex> field NAME is still present (P1-23 fork).
    expect(profile.decoyField?.fieldName).toMatch(/^fr_[0-9a-f]+$/);
    expect(html).toContain(`name="${profile.decoyField!.fieldName}"`);
    // ...but the greppable fr-decoy CLASS is gone in production.
    expect(html).not.toContain("fr-decoy");
  });

  it("production route notice is inert <template> with no data-fr-route / data-fr-token", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-route", mode: "lab" },
      { families: ["decoy-route"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      labMode: false,
    });
    opaqueAssertions(html, "DECOY_ROUTE_ONLY/production");
    expect(html).toContain("<template");
  });
});
