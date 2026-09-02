/**
 * P1-22 — opaque production carriers (P1-AUDIT-2 Phase E, audit items 6+7;
 * updated for the P1 signature-stripping pass).
 *
 * Verifies that, in PRODUCTION (evaluationMode:false), the rendered signup
 * page carries NO fixed, greppable FireRaid-identifying presentation
 * signature:
 *   - No data-fr-* attributes (stripped by stripFireRaidSignatures).
 *   - No fr-* class tokens (fr-canary-wrap, fr-decoy, fr-visually-hidden,
 *     fr-canary, etc.) — stripped from output.
 *   - No neutral-carrier vocabulary either (data-rt-carrier / data-rt-id /
 *     data-rt-token / fr-hidden-neutral — the audit forbids ANY static
 *     carrier-naming vocabulary, fr-* or rt-*).
 *   - No strategy IDs (P01–P04 / S01–S09) in markup.
 *   - No fr-client-config script id (production uses app-runtime-config —
 *     a plain JSON island indistinguishable from ordinary site config).
 *   - Instruction carriers are BARE inert <template> elements.
 *   - No data-fire-raid-notice template (audit item 7: removed entirely).
 *   - No fr-lab-banner.
 *
 * Lab mode (evaluationMode:true) KEEPS the explicit markers (research
 * greppability).
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { stripFireRaidSignatures } from "../../src/core/artifacts.js";
import type { DefenseProfile } from "../../src/types/profile.js";

const BASE_PROFILE: DefenseProfile = {
  version: 1,
  profileId: "test-profile",
  sessionId: "opacity-test-session",
  families: [],
  decoyField: undefined,
  decoyRoute: undefined,
  telemetry: {
    captureFocus: false,
    captureInput: false,
    captureChange: false,
    capturePointer: false,
    captureKey: false,
    captureSubmit: true,
  },
  scoringPolicy: "default-v1",
};

function makeProfile(overrides: Partial<DefenseProfile>): DefenseProfile {
  return { ...BASE_PROFILE, ...overrides };
}

/**
 * Production opacity: comprehensive regex scan — NO FireRaid signature
 * should appear anywhere in the production output. Includes the neutral
 * carrier vocabulary (data-rt-*, fr-hidden-neutral) and strategy IDs —
 * the audit forbids ANY static carrier-naming signature.
 */
const PRODUCTION_SIG_REGEX =
  /data-fr-|data-rt-|fr-client-config|rt-client-config|fr-canary|fr-decoy|fr-visually-hidden|fr-hidden-neutral|fire-raid-notice|fr-lab-banner/i;

const STRATEGY_ID_REGEX = /\b(P0[1-4]|S0[1-9])\b/;

/** Every production carrier is a BARE inert <template> (or a comment). */
const BARE_TEMPLATE = /<template>[^<]*<\/template>/;

describe("P1-22 opaque production carriers", () => {
  it("stripFireRaidSignatures: strips all known attribute shapes", () => {
    const input =
      '<p data-fr-canary="P04" data-fr-canary-id="test" ' +
      'data-fr-placement="P06" data-fr-marker="abc" data-fr-route data-fr-spot>' +
      'Session text</p>';
    const out = stripFireRaidSignatures(input);
    expect(out).not.toContain("data-fr-canary=");
    expect(out).not.toContain("data-fr-canary-id=");
    expect(out).not.toContain("data-fr-placement=");
    expect(out).not.toContain("data-fr-marker=");
    expect(out).not.toContain("data-fr-route");
    expect(out).not.toContain("data-fr-spot");
    // Instruction text preserved.
    expect(out).toContain("Session text");
  });

  it("stripFireRaidSignatures: strips class tokens AND the neutral carrier vocabulary", () => {
    const input =
      '<div class="fr-canary-wrap fr-canary-inert fr-decoy" ' +
      'data-rt-carrier="spot" data-rt-id="P04">Session text</div>';
    const out = stripFireRaidSignatures(input);
    expect(out).not.toContain("fr-canary-wrap");
    expect(out).not.toContain("fr-canary-inert");
    expect(out).not.toContain("fr-decoy");
    // The neutral vocabulary is stripped too — a static "ignore data-rt-*"
    // rule must never be a one-line bypass.
    expect(out).not.toContain('data-rt-carrier="spot"');
    expect(out).not.toContain('data-rt-id="P04"');
    // Text preserved.
    expect(out).toContain("Session text");
  });

  it("stripFireRaidSignatures: idempotent", () => {
    const input =
      '<div class="fr-canary-wrap" data-fr-canary="P04">text</div>';
    const out1 = stripFireRaidSignatures(input);
    const out2 = stripFireRaidSignatures(out1);
    expect(out2).toBe(out1);
  });

  it("stripFireRaidSignatures: empty class attr after strip", () => {
    const input = '<div class="fr-decoy">text</div>';
    const out = stripFireRaidSignatures(input);
    // class="" should be removed entirely.
    expect(out).not.toMatch(/class\s*=\s*"/);
    expect(out).toContain("<div");
    expect(out).toContain("text");
  });

  it("FULL profile production: NO FireRaid signatures survive", async () => {
    // Build a profile manually (bypass deriveProfilePure which has a
    // concurrent-agent bug with SPOT_ANCHORS import).
    const profile = makeProfile({
      sessionId: "p122-prod",
      families: ["semantic", "decoy-field", "decoy-route", "interaction"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "abc123def456",
        mode: "observe",
        spotCount: 2,
        spots: ["pre-form", "body-end"],
        formVariant: 0,
      },
      decoyField: { fieldName: "abc123def456", elementId: "abc123def456" },
      decoyRoute: { endpointToken: "abc123def456" },
      interaction: { scoringEnabled: true },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    // Comprehensive regex scan over the full production page.
    expect(html).not.toMatch(PRODUCTION_SIG_REGEX);
    // No strategy identifier survives in markup.
    expect(html).not.toMatch(STRATEGY_ID_REGEX);
    // Neutral client-config island instead (plain JSON, ordinary-looking).
    expect(html).toContain('id="app-runtime-config"');
    // Instruction carriers are BARE inert templates carrying real text.
    const templates = html.match(/<template>[^<]*<\/template>/g) ?? [];
    expect(templates.length).toBeGreaterThanOrEqual(2); // 2 spots drawn
    for (const t of templates) {
      expect(t).toMatch(BARE_TEMPLATE);
      expect(t.length).toBeGreaterThan("<template></template>".length);
    }
  });

  it("FULL profile production via host renderer: NO FireRaid signatures survive", async () => {
    const profile = makeProfile({
      sessionId: "p122-host-prod",
      families: ["semantic", "decoy-field", "decoy-route", "interaction"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "xyz789abc123",
        mode: "observe",
        spotCount: 2,
        spots: ["pre-form", "body-end"],
        formVariant: 0,
      },
      decoyField: { fieldName: "xyz789abc123", elementId: "xyz789abc123" },
      decoyRoute: { endpointToken: "xyz789abc123" },
      interaction: { scoringEnabled: true },
    });
    const html = referenceInject(
      "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile, "csrf-x", false
    );
    expect(html).not.toMatch(PRODUCTION_SIG_REGEX);
    expect(html).not.toMatch(STRATEGY_ID_REGEX);
    expect(html).toContain('id="app-runtime-config"');
  });

  it("FULL profile lab: markers survive", async () => {
    const profile = makeProfile({
      sessionId: "p122-lab",
      families: ["semantic", "decoy-field", "decoy-route", "interaction"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "lab123xyz",
        mode: "observe",
        spotCount: 2,
        spots: ["pre-form", "body-end"],
        formVariant: 0,
      },
      decoyField: { fieldName: "lab123xyz", elementId: "lab123xyz" },
      decoyRoute: { endpointToken: "lab123xyz" },
      interaction: { scoringEnabled: true },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: true,
    });
    expect(html).toContain("data-fr-");
    expect(html).toContain("fr-decoy");
    expect(html).toContain("fr-lab-banner");
    expect(html).toContain("id=\"fr-client-config\"");
  });

  it("FULL profile lab via host: markers survive", async () => {
    const profile = makeProfile({
      sessionId: "p122-host-lab",
      families: ["semantic", "decoy-field", "decoy-route", "interaction"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "labhost123",
        mode: "observe",
        spotCount: 2,
        spots: ["pre-form", "body-end"],
        formVariant: 0,
      },
      decoyField: { fieldName: "labhost123", elementId: "labhost123" },
      decoyRoute: { endpointToken: "labhost123" },
      interaction: { scoringEnabled: true },
    });
    const html = referenceInject(
      "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile, "csrf-x", true
    );
    expect(html).toContain("data-fr-");
    expect(html).toContain("fr-decoy");
    expect(html).toContain("fr-lab-banner");
    expect(html).toContain('id="fr-client-config"');
  });

  it("P02 individually: production has no signatures", async () => {
    const profile = makeProfile({
      sessionId: "p02-prod",
      families: ["semantic", "decoy-route"],
      semantic: {
        templateId: "P02",
        placementId: "P06",
        nonce: "p02nonce",
        mode: "observe",
        spotCount: 1,
        spots: ["pre-form"],
        formVariant: 0,
      },
      decoyRoute: { endpointToken: "p02token" },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    expect(html).not.toMatch(PRODUCTION_SIG_REGEX);
  });

  it("P03 individually: production has no signatures", async () => {
    const profile = makeProfile({
      sessionId: "p03-prod",
      families: ["semantic", "decoy-field"],
      semantic: {
        templateId: "P03",
        placementId: "P06",
        nonce: "p03nonce",
        mode: "decoy",
        spotCount: 1,
        spots: ["pre-form"],
        formVariant: 0,
      },
      decoyField: { fieldName: "p03field", elementId: "p03field" },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    expect(html).not.toMatch(PRODUCTION_SIG_REGEX);
  });

  it("production decoy field uses neutral class (not fr-decoy)", async () => {
    const profile = makeProfile({
      sessionId: "p122-field",
      families: ["decoy-field"],
      decoyField: { fieldName: "testfield123", elementId: "testfield123" },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    // Production decoy hides via SELF-CONTAINED inline styles — no class
    // dependency at all (the audit removed fr-hidden-neutral).
    const decoyEl = html.match(
      new RegExp(`<input type="text" name="testfield123"[^>]*>`)
    );
    expect(decoyEl).toBeTruthy();
    expect(decoyEl![0]).toContain("position:absolute");
    expect(decoyEl![0]).toContain("clip-path:inset(50%)");
    expect(decoyEl![0]).toContain("aria-hidden");
    expect(decoyEl![0]).toContain('tabindex="-1"');
    expect(decoyEl![0]).not.toContain("fr-decoy");
    expect(decoyEl![0]).not.toContain("fr-visually-hidden");
    expect(decoyEl![0]).not.toContain("fr-hidden-neutral");
  });

  it("host production decoy field uses self-contained inline hiding styles", async () => {
    const profile = makeProfile({
      sessionId: "ref-field-prod",
      families: ["decoy-field"],
      decoyField: { fieldName: "hostfield123", elementId: "hostfield123" },
    });
    const html = referenceInject(
      '<html><body><form id="signup-form"></form></body></html>',
      profile, "csrf-x", false
    );
    const input = html.match(
      new RegExp(`<input[^>]*hostfield123[^>]*>`)
    )?.[0] ?? "";
    expect(input).toContain("position:absolute");
    expect(input).toContain("clip-path:inset(50%)");
    expect(input).toContain("aria-hidden");
    expect(input).not.toContain("fr-decoy");
    expect(input).not.toContain("fr-hidden-neutral");
  });

  it("production has no data-fire-raid-notice template", async () => {
    const profile = makeProfile({
      sessionId: "p122-notice",
      families: ["semantic", "decoy-field", "decoy-route"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "notice123",
        mode: "observe",
        spotCount: 1,
        spots: ["pre-form"],
        formVariant: 0,
      },
      decoyField: { fieldName: "noticefield", elementId: "noticefield" },
      decoyRoute: { endpointToken: "noticetoken" },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: false,
    });
    expect(html).not.toContain("data-fire-raid-notice");
    expect(html).not.toContain("fire-raid-notice");
    // Host renderer too.
    const htmlHost = referenceInject(
      "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile, "csrf-x", false
    );
    expect(htmlHost).not.toContain("data-fire-raid-notice");
  });

  it("lab mode still has fr-lab-banner", async () => {
    const profile = makeProfile({
      sessionId: "p122-lab-banner",
      families: ["semantic"],
      semantic: {
        templateId: "P04",
        placementId: "P06",
        nonce: "banner123",
        mode: "observe",
        spotCount: 1,
        spots: ["pre-form"],
        formVariant: 0,
      },
    });
    const html = renderSignupPage({
      html: "<!doctype html><html><body><form id=\"signup-form\"></form></body></html>",
      profile,
      csrfToken: "csrf-x",
      evaluationMode: true,
    });
    expect(html).toContain("fr-lab-banner");
  });
});
