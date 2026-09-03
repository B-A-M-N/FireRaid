/**
 * P1-AUDIT-2 Phase D (audit item 5) — semantic parity between the two
 * presentation mappers.
 *
 * buildArtifactSet() (core/artifacts.ts) is the single policy point. The
 * Worker renderer (core/renderer.ts) and the host reference renderer
 * (host-adapter/reference-render.ts) must AGREE on every semantic invariant
 * for the same profile + mode:
 *   1. WHICH artifacts exist (decoy field / decoy route / semantic).
 *      REMOVED: production notice (audit item 7: fingerprintable disclosure).
 *   2. WHAT identifiers they carry (field name, element id, route token,
 *      canary template id, canonical semantic body).
 *   3. Their OPACITY POSTURE (production = neutral carriers, no data-fr-*,
 *      no fr-decoy class, no fr-client-config id, no data-fire-raid-notice;
 *      lab = greppable markers).
 *
 * Exact DOM is intentionally NOT pinned (that is legitimate per-host
 * presentation: stylesheet classes vs inline styles). Divergence in the
 * invariants above is the two-divergent-renderers defect class this test
 * makes structurally impossible to reintroduce silently.
 */
import { describe, it, expect } from "vitest";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { deriveProfilePure, ABLATION_RECIPES } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const SECRET = "parity-test-secret";

/** Base page carrying EVERY anchor both mappers inject at. */
const BASE_HTML =
  '<!doctype html><html><body><form id="signup-form">' +
  '<fieldset class="fr-form-fields"></fieldset>' +
  "</form></body></html>";

function workerRender(profile: Awaited<ReturnType<typeof deriveProfilePure>>, evaluationMode: boolean): string {
  return renderSignupPage({ html: BASE_HTML, profile, csrfToken: "csrf-x", evaluationMode });
}

function hostRender(profile: Awaited<ReturnType<typeof deriveProfilePure>>, evaluationMode: boolean): string {
  return referenceInject(BASE_HTML, profile, "csrf-x", evaluationMode);
}

/**
 * Extract client config JSON from rendered HTML.
 * Production uses id="app-runtime-config", lab uses id="fr-client-config".
 */
function clientConfigPayload(html: string): string | null {
  const m = html.match(/<script type="application\/json" id="(fr-client-config|app-runtime-config)">(.*)<\/script>/);
  return m ? m[2] : null;
}

async function fullProfile(sessionId: string, placementId = "P01", mode: "lab" | "production" = "lab") {
  const recipe: DefenseRecipe = { ...ABLATION_RECIPES.FULL, placementId };
  return deriveProfilePure({ secret: SECRET, version: 1, sessionId, mode }, recipe);
}

describe("Phase D artifact parity: Worker vs host mappers", () => {
  it("PRODUCTION: both agree on which artifacts exist and their identifiers", async () => {
    // Production draws P01-P04 (production-safe templates) with P06 non-rendered.
    const profile = await fullProfile("parity-prod", "P06", "production");
    const worker = workerRender(profile, false);
    const host = hostRender(profile, false);

    for (const [label, html] of [["worker", worker], ["host", host]] as const) {
      // Decoy field EXISTS with the profile-bound name; hidden posture.
      expect(html, label).toContain(`name="${profile.decoyField!.fieldName}"`);
      expect(html, label).toContain(`id="${profile.decoyField!.elementId}"`);
      // Decoy route: NO route-naming attribute exists (P1 — the token
      // travels only inside the semantic FULL-ACTION instruction text);
      // but the route URL itself is carried in the instruction.
      expect(html, label).not.toContain("data-rt-");
      expect(html, label).not.toContain("data-fr-");
      // REMOVED (audit item 7): no production notice template.
      expect(html, label).not.toContain('data-fire-raid-notice');
      // Client config uses the neutral island id in production.
      expect(html, label).toContain('id="app-runtime-config"');
      // OPACITY: no LAB markers, no neutral-carrier vocabulary, no
      // strategy IDs in production.
      expect(html, label).not.toContain("fr-decoy");
      expect(html, label).not.toContain("fr-lab-banner");
      expect(html, label).not.toContain("data-fire-raid-notice");
      expect(html, label).not.toMatch(/data-rt-token=|fr-hidden-neutral/);
      expect(html, label).not.toMatch(/\b(P0[1-4]|S0[1-9])\b/);
      // Semantic EXISTS in production with BARE inert template carriers
      // carrying real instruction text (P1-22, updated).
      expect(html, label).toContain(profile.semantic!.nonce);
      const templates = html.match(/<template>[^<]*<\/template>/g) ?? [];
      expect(templates.length, label).toBeGreaterThanOrEqual(1);
      for (const t of templates) {
        expect(t.length, label).toBeGreaterThan("<template></template>".length);
      }
    }

    // Identifiers identical across mappers, modulo the hiding TECHNIQUE
    // (Worker: stylesheet utility class; host: inline styles — deliberate
    // presentation difference, no host CSS dependency).
    const normalize = (html: string) =>
      html
        .replace(/style="[^"]*"/g, "")
        .replace(/fr-visually-hidden/g, "")
        .replace(/fr-hidden-neutral/g, "")
        .replace(/class=""/g, "")
        .replace(/ +/g, " ");
    expect(normalize(worker)).toBe(normalize(host));
  });

  it("LAB: both agree and keep the greppable markers", async () => {
    const profile = await fullProfile("parity-lab", "P04", "lab");
    const worker = workerRender(profile, true);
    const host = hostRender(profile, true);

    const templateId = profile.semantic!.templateId;
    for (const [label, html] of [["worker", worker], ["host", host]] as const) {
      // Semantic canary EXISTS, with the canonical body rendered ONCE.
      expect(html, label).toContain(`data-fr-canary-id="${templateId}"`);
      expect(html, label).toContain(`data-fr-placement="${profile.semantic!.placementId}"`);
      // Decoy field lab-marked; route visible for researcher verification.
      expect(html, label).toContain("fr-decoy");
      expect(html, label).toContain(`/c/${profile.decoyRoute!.endpointToken}`);
      expect(html, label).toContain("fr-lab-banner");
      // Lab uses fr-client-config.
      expect(html, label).toContain('id="fr-client-config"');
    }

    // The canonical semantic body is embedded VERBATIM by both mappers.
    const { buildArtifactSet } = await import("../../src/core/artifacts.js");
    const canonical = buildArtifactSet(profile, { evaluationMode: true }).semantic!.bodyHtml;
    expect(worker).toContain(canonical);
    expect(host).toContain(canonical);
  });

  it("semantic placement positions: canonical body present in both, for every placement", async () => {
    const { buildArtifactSet } = await import("../../src/core/artifacts.js");
    for (const placementId of ["P01", "P02", "P03", "P04", "P05", "P06"]) {
      // Placement variants are lab-specific experiments; production only uses P06.
      const profile = await fullProfile(`parity-${placementId}`, placementId, "lab");
      const worker = workerRender(profile, true);
      const host = hostRender(profile, true);
      const art = buildArtifactSet(profile, { evaluationMode: true }).semantic!;
      const canonical = art.bodyHtml;

      expect(worker, placementId).toContain(`data-fr-canary-id="${art.templateId}"`);
      expect(host, placementId).toContain(`data-fr-canary-id="${art.templateId}"`);
      expect(worker, placementId).toContain(canonical);
      expect(host, placementId).toContain(canonical);
      if (art.position !== "non-rendered") {
        // placement marker is part of the experimental variable (FR-R6-047)
        expect(worker, placementId).toContain(`data-fr-placement="${art.placementId}"`);
        expect(host, placementId).toContain(`data-fr-placement="${art.placementId}"`);
      } else {
        // P06 non-rendered: intentionally absent placement marker in BOTH.
        expect(worker, placementId).not.toContain(`data-fr-placement`);
        expect(host, placementId).not.toContain(`data-fr-placement`);
      }
    }
  });

  it("CONTROL recipe: neither mapper emits any defense artifact in either mode", async () => {
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "parity-control", mode: "lab" },
      ABLATION_RECIPES.CONTROL
    );
    for (const evaluationMode of [false, true]) {
      const worker = workerRender(profile, evaluationMode);
      const host = hostRender(profile, evaluationMode);
      for (const [label, html] of [["worker", worker], ["host", host]] as const) {
        expect(html, label).not.toContain("data-fr-canary-id");
        expect(html, label).not.toContain('data-rt-carrier="route"');
        // The prod notice is a mode-driven constant (emitted for every recipe);
        // what CONTROL must not carry is any PROFILE-BOUND defense artifact —
        // no neutral-carrier vocabulary either (P1 signature stripping).
        expect(html, label).not.toMatch(/data-rt-/);
        // CONTROL has no decoy field — check for absence of any hex-only name
        // attribute (profile-bound defense artifacts). The csrf field has
        // name="csrf" which is a known constant.
        expect(html, label).not.toMatch(/name="([0-9a-f]{12,})"/);
        // clientConfig script still ships (telemetry limits are profile-independent)
        if (evaluationMode) {
          expect(html, label).toContain('id="fr-client-config"');
        } else {
          expect(html, label).toContain('id="app-runtime-config"');
        }
      }
      expect(worker, `evaluationMode=${evaluationMode}`).not.toMatch(/name="([0-9a-f]{12,})"/);
      expect(host, `evaluationMode=${evaluationMode}`).not.toMatch(/name="([0-9a-f]{12,})"/);
    }
  });

  it("client config: BOTH mappers embed the IDENTICAL shared-core payload", async () => {
    const profile = await fullProfile("parity-client-config", "P01", "lab");
    for (const evaluationMode of [false, true]) {
      const w = clientConfigPayload(workerRender(profile, evaluationMode));
      const h = clientConfigPayload(hostRender(profile, evaluationMode));
      expect(w).not.toBeNull();
      expect(h).not.toBeNull();
      // Byte-for-byte: one policy point, one JSON serialization.
      expect(w).toBe(h);
      const parsed = JSON.parse(w!) as { telemetry: unknown; limits: unknown };
      expect(parsed.telemetry).toEqual(profile.telemetry);
      expect(parsed.limits).toHaveProperty("maxEventsPerBatch");
    }
  });

  it("production notice REMOVED: neither mapper emits data-fire-raid-notice in any mode", async () => {
    for (const [name, recipe] of Object.entries(ABLATION_RECIPES)) {
      if (name === "SEMANTIC_ONLY" || name === "SEMANTIC_ROUTE" || name === "FULL") continue;
      const profile = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `notice-${name}`, mode: "production" },
        recipe
      );
      const worker = workerRender(profile, false);
      const host = hostRender(profile, false);
      // Production notice completely removed (audit item 7).
      expect(worker).not.toContain("fire-raid-notice");
      expect(host).not.toContain("fire-raid-notice");
      // Lab too.
      const labProfile = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `notice-${name}`, mode: "lab" },
        recipe
      );
      expect(workerRender(labProfile, true)).not.toContain("fire-raid-notice");
      expect(hostRender(labProfile, true)).not.toContain("fire-raid-notice");
    }
  });

  // ── E5 levers: regression invariants from the measured dataset ──────────
  // E5 (exp-e5-treatment-visible, 30/30) measured: route-ask text in model
  // input → 4/4 token+nonce compliance; field-ask-only → 0/5; marker-only
  // comment spots → nothing actionable. These tests pin the fixes.

  it("E5 lever 1: route-armed sessions render the session_response actuator sink on BOTH mappers; non-route-armed do not", async () => {
    // Route-armed: FULL includes decoy-route + semantic (P02/P03/P04 draw).
    // Draw sessions until a route-armed strategy (P02/P04) is drawn, and
    // separately a P03 draw, and assert the sink's presence tracks
    // requiresRoute, on both planes, in both modes.
    const withRoute = await (async () => {
      for (let i = 0; i < 80; i++) {
        const p = await deriveProfilePure(
          { secret: SECRET, version: 1, sessionId: `sink-route-${i}`, mode: "production" },
          { ...ABLATION_RECIPES.FULL, placementId: "P06" }
        );
        // requiresRoute templates: P02, P04 (catalog.ts).
        if (p.semantic && ["P02", "P04"].includes(p.semantic.templateId)) return p;
      }
      throw new Error("no route-armed draw in 80 sessions");
    })();
    for (const [label, html] of [["worker", workerRender(withRoute, false)], ["host", hostRender(withRoute, false)]] as const) {
      expect(html, label).toContain('name="session_response"');
      expect(html, label).toContain('id="session_response"');
      // Same hidden posture as the decoy field.
      expect(html, label).toContain("aria-hidden");
    }
    // And the instruction text binds to it: the route ask names the sink.
    expect(workerRender(withRoute, false)).toContain("session_response");

    const withoutRoute = await (async () => {
      for (let i = 0; i < 80; i++) {
        const p = await deriveProfilePure(
          { secret: SECRET, version: 1, sessionId: `sink-noroute-${i}`, mode: "production" },
          // SEMANTIC_ONLY: semantic with no decoy-route family → not route-armed.
          { ...ABLATION_RECIPES.SEMANTIC_ONLY, placementId: "P06" }
        );
        if (p.semantic && !p.decoyRoute) return p;
      }
      throw new Error("no non-route-armed draw in 80 sessions");
    })();
    expect(workerRender(withoutRoute, false)).not.toContain('name="session_response"');
    expect(hostRender(withoutRoute, false)).not.toContain('name="session_response"');
  });

  it("E5 lever 2: production comment carriers are FULL-ACTION (instruction text present on every drawn channel)", async () => {
    // Delivery completeness: E5 measured a comment-only draw delivering
    // zero actionable material. The comment channel must now carry the
    // same instruction text the template channel does — strategy-scoped:
    // P02/P04 comment carriers carry the route ask; P03 carries the field
    // ask (its strategy's full action material).
    for (let i = 0; i < 40; i++) {
      const profile = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `comment-fa-${i}`, mode: "production" },
        { ...ABLATION_RECIPES.FULL, placementId: "P06" }
      );
      const html = workerRender(profile, false);
      const comments = html.match(/<!-- \[session config [\s\S]*? -->/g) ?? [];
      const strategy = profile.semantic!.templateId;
      for (const c of comments) {
        // Full-action material: nonce always; strategy-specific actions.
        expect(c).toContain(profile.semantic!.nonce);
        if (strategy === "P02" || strategy === "P04") {
          expect(c).toContain(profile.decoyRoute!.endpointToken);
          expect(c).toContain("/c/");
        }
        if (strategy === "P03" || strategy === "P04") {
          expect(c).toContain(profile.decoyField!.fieldName);
        }
      }
    }
  });

  it("E5 lever 1: the actuator sink is dropped from upstream forwarding and scored", async () => {
    // stripFireRaidFields drops session_response for route-armed profiles
    // (host middleware parity with the decoy field). Verified indirectly:
    // the constant is exported and the observation exists; the full
    // submit-path behavior is pinned by middleware-productization tests.
    const { SESSION_RESPONSE_FIELD } = await import("../../src/core/artifacts.js");
    expect(SESSION_RESPONSE_FIELD).toBe("session_response");
  });
});
