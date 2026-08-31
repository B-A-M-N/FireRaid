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

  // P1-AUDIT-2: the production decoy field must be VISUALLY hidden, not just
  // aria-hidden. Prior to the fix, dropping the fr-decoy class left a bare
  // type="text" input that rendered as a visible full-width textbox. The
  // production decoy now carries a neutral offscreen utility class that the
  // PRP-FROM-BUG analysis requires.
  it("production decoy field is visually hidden (not a visible textbox)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "p122-decoystyle", mode: "lab" },
      { families: ["decoy-field"], labOnly: true }
    );
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile: { ...profile, decoyField: { ...profile.decoyField! } },
      csrfToken: "csrf-x",
      labMode: false,
    });
    opaqueAssertions(html, "DECOY_FIELD_ONLY/production");
    expect(profile.decoyField?.fieldName).toBeDefined();
    // The production decoy input must carry the visually-hidden utility class.
    const decoyEl = html.match(
      new RegExp(`<input type="text" name="${profile.decoyField!.fieldName}"[^>]*>`)
    );
    expect(decoyEl).toBeTruthy();
    expect(decoyEl![0]).toContain("class=\"fr-visually-hidden\"");
    // ...and it must NOT carry the greppable fr-decoy name.
    expect(decoyEl![0]).not.toContain("fr-decoy");
    // The CSS rule that hides it must exist (otherwise the class is inert).
    const css = await import("fs/promises").then((fs) => fs.readFile("public/signup.css", "utf8"));
    expect(css).toContain(".fr-visually-hidden");
    // The generic full-width input rule must not win: the utility uses !important
    // and clip so the decoy can never render as a visible textbox.
    expect(css).toMatch(/\.fr-visually-hidden\s*\{[^}]*position:\s*absolute\s*!important/);
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
    // Inline-style hiding: a host page does not ship our stylesheet, so the
    // hide must not depend on a class that may not exist there.
    const input = html.match(/<input[^>]*fr_[0-9a-f]+[^>]*>/)?.[0] ?? "";
    expect(input).toContain("position:absolute");
    expect(input).toContain("clip-path:inset(50%)");
  });

  it("production emits NO semantic canary markup (mirrors FR-R7-013)", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "ref-canary-prod", mode: "lab" },
      FULL_RECIPE
    );
    const html = referenceInject(
      '<html><body><form id="signup-form"></form></body></html>',
      profile, "csrf-x", false
    );
    opaqueAssertions(html, "reference/FULL/production");
    expect(html).not.toContain("data-fr-canary-id");
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
