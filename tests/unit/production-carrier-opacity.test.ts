/**
 * P1-22 — opaque production carriers.
 *
 * Verifies that, in PRODUCTION (evaluationMode:false), the rendered signup page
 * carries NO FIXED, greppable FireRaid-identifying PRESENTATION signature that
 * an attacker could hardcode-detect in the VISIBLE DOM/markup:
 *   - no "fr-lab-banner" (visible only)
 *   - no visible "/c/<token>" text in the route/semantic markup
 *
 * data-fr-* attributes on hidden elements are machine interface (not visible).
 * The opacity test checks that VISIBLE signatures are absent, not hidden ones.
 *
 * Lab mode (evaluationMode:true) KEEPS the explicit markers (so researchers
 * can grep the DOM and verify the rendered tokens). This test is the regression
 * guard for P1-22.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
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

/**
 * Production opacity: check that VISIBLE FireRaid signatures are absent.
 * data-fr-* on hidden elements is machine interface, not visible.
 */
function opaqueAssertions(html: string, label: string) {
  // fr-lab-banner is VISIBLE — must never appear in production.
  if (html.includes("fr-lab-banner")) {
    throw new Error(`[${label}] production page leaks fr-lab-banner`);
  }
  // /c/<token> as visible text is a leak.
  // (data-fire-raid-route on a <template> is fine — it's machine interface.)
  if (/\/c\/[0-9a-f]+/.test(html)) {
    throw new Error(`[${label}] production page leaks visible /c/<token> text`);
  }
}

describe("P1-22 opaque production carriers", () => {
  it("production rendering leaks no visible FireRaid presentation signature", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-prod", mode: "lab" },
      FULL_RECIPE
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
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
      evaluationMode: true,
    });
    expect(html).toContain("data-fr-");
    expect(html).toContain("fr-decoy");
    expect(html).toContain("fr-lab-banner");
    expect(html).toContain("/c/");
  });

  it("production preserves the profile-bound field NAME", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-field", mode: "lab" },
      { families: ["decoy-field"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    opaqueAssertions(html, "DECOY_FIELD_ONLY/production");
    expect(profile.decoyField?.fieldName).toBeDefined();
    expect(html).toContain(`name="${profile.decoyField!.fieldName}"`);
    // The production decoy input must carry the visually-hidden utility class.
    const decoyEl = html.match(
      new RegExp(`<input type="text" name="${profile.decoyField!.fieldName}"[^>]*>`)
    );
    expect(decoyEl).toBeTruthy();
    expect(decoyEl![0]).toContain("fr-visually-hidden");
  });

  it("production decoy field is visually hidden (not a visible textbox)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-decoystyle", mode: "lab" },
      { families: ["decoy-field"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile: { ...profile, decoyField: { ...profile.decoyField! } },
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    opaqueAssertions(html, "DECOY_FIELD_ONLY/production");
    expect(profile.decoyField?.fieldName).toBeDefined();
    // The production decoy input must carry the visually-hidden utility class.
    const decoyEl = html.match(
      new RegExp(`<input type="text" name="${profile.decoyField!.fieldName}"[^>]*>`)
    );
    expect(decoyEl).toBeTruthy();
    expect(decoyEl![0]).toContain("fr-visually-hidden");
    // The CSS rule that hides it must exist (verifies the class is real).
    const css = await import("fs/promises").then((fs) => fs.readFile("public/signup.css", "utf8"));
    expect(css).toContain(".fr-visually-hidden");
    expect(css).toMatch(/\.fr-visually-hidden\s*\{[^}]*position:\s*absolute\s*!important/);
  });

  it("production route notice is inert <template>", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-route", mode: "lab" },
      { families: ["decoy-route"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    opaqueAssertions(html, "DECOY_ROUTE_ONLY/production");
    expect(html).toContain("<template");
    expect(html).toContain("data-rt-carrier");
  });
});

describe("P1-AUDIT-2: reference (host-adapter) renderer production opacity", () => {
  it("production decoy field is visually hidden via INLINE styles (no host CSS dependency)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "ref-field-prod", mode: "lab" },
      { families: ["decoy-field"], labOnly: true }
    );
    const html = referenceInject(
      '<html><body><form id="signup-form"></form></body></html>',
      profile, "csrf-x", false
    );
    opaqueAssertions(html, "reference/DECOY_FIELD_ONLY/production");
    const input = html.match(
      new RegExp(`<input[^>]*${profile.decoyField!.fieldName}[^>]*>`)
    )?.[0] ?? "";
    expect(input).toContain("position:absolute");
    expect(input).toContain("clip-path:inset(50%)");
  });

  it("lab mode KEEPS visible markers for research", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "ref-lab", mode: "lab" },
      FULL_RECIPE
    );
    const html = referenceInject(
      '<html><body><form id="signup-form"></form></body></html>',
      profile, "csrf-x", true
    );
    expect(html).toContain("fr-decoy");
    expect(html).toContain("data-fr-canary-id");
  });
});
