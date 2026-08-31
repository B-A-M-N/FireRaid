/**
 * P1-AUDIT-2 Phase D (audit item 5) — semantic parity between the two
 * presentation mappers.
 *
 * buildArtifactSet() (core/artifacts.ts) is the single policy point. The
 * Worker renderer (core/renderer.ts) and the host reference renderer
 * (host-adapter/reference-render.ts) must AGREE on every semantic invariant
 * for the same profile + mode:
 *   1. WHICH artifacts exist (decoy field / decoy route / semantic / notice).
 *   2. WHAT identifiers they carry (field name, element id, route token,
 *      canary template id, canonical semantic body).
 *   3. Their OPACITY POSTURE (production = neutral carriers, no data-fr-*,
 *      no fr-decoy class, no visible /c/<token>; lab = greppable markers).
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

function workerRender(profile: Awaited<ReturnType<typeof deriveProfilePure>>, labMode: boolean): string {
  return renderSignupPage({ html: BASE_HTML, profile, csrfToken: "csrf-x", labMode });
}

function hostRender(profile: Awaited<ReturnType<typeof deriveProfilePure>>, labMode: boolean): string {
  return referenceInject(BASE_HTML, profile, "csrf-x", labMode);
}

function clientConfigPayload(html: string): string | null {
  const m = html.match(/<script type="application\/json" id="fr-client-config">(.*)<\/script>/);
  return m ? m[1] : null;
}

async function fullProfile(sessionId: string, placementId = "P01") {
  const recipe: DefenseRecipe = { ...ABLATION_RECIPES.FULL, placementId };
  return deriveProfilePure({ secret: SECRET, version: 1, sessionId, mode: "lab" }, recipe);
}

describe("Phase D artifact parity: Worker vs host mappers", () => {
  it("PRODUCTION: both agree on which artifacts exist and their identifiers", async () => {
    const profile = await fullProfile("parity-prod");
    const worker = workerRender(profile, false);
    const host = hostRender(profile, false);

    for (const [label, html] of [["worker", worker], ["host", host]] as const) {
      // Decoy field EXISTS with the profile-bound name; hidden posture.
      expect(html, label).toContain(`name="${profile.decoyField!.fieldName}"`);
      expect(html, label).toContain(`id="${profile.decoyField!.elementId}"`);
      // Decoy route EXISTS as the neutral <template> carrier (P1-22).
      expect(html, label).toContain(`data-rt-token="${profile.decoyRoute!.endpointToken}"`);
      // Production notice EXISTS with the same machine-targeted text.
      expect(html, label).toContain('data-rt-carrier="prod-notice"');
      // OPACITY: no greppable signature anywhere.
      expect(html, label).not.toContain("data-fr-");
      expect(html, label).not.toContain("fr-decoy");
      expect(html, label).not.toContain("fr-lab-banner");
      expect(html, label).not.toMatch(/\/c\/[0-9a-f]+/);
      // FR-R7-013: NO semantic artifact AT ALL in production.
      expect(html, label).not.toContain("data-fr-canary-id");
      expect(html, label).not.toContain(profile.semantic!.nonce);
    }

    // Identifiers identical across mappers, modulo the hiding TECHNIQUE
    // (Worker: stylesheet utility class; host: inline styles — deliberate
    // presentation difference, no host CSS dependency).
    const normalize = (html: string) =>
      html
        .replace(/style="[^"]*"/g, "")
        .replace(/fr-visually-hidden/g, "")
        .replace(/class=""/g, "")
        .replace(/ +/g, " ");
    expect(normalize(worker)).toBe(normalize(host));
  });

  it("LAB: both agree and keep the greppable markers", async () => {
    const profile = await fullProfile("parity-lab");
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
    }

    // The canonical semantic body is embedded VERBATIM by both mappers.
    const { buildArtifactSet } = await import("../../src/core/artifacts.js");
    const canonical = buildArtifactSet(profile, { labMode: true }).semantic!.bodyHtml;
    expect(worker).toContain(canonical);
    expect(host).toContain(canonical);

    // No production-only notice in lab.
    expect(worker).not.toContain('data-rt-carrier="prod-notice"');
    expect(host).not.toContain('data-rt-carrier="prod-notice"');
  });

  it("semantic placement positions: canonical body present in both, for every placement", async () => {
    const { buildArtifactSet } = await import("../../src/core/artifacts.js");
    for (const placementId of ["P01", "P02", "P03", "P04", "P05", "P06"]) {
      const profile = await fullProfile(`parity-${placementId}`, placementId);
      const worker = workerRender(profile, true);
      const host = hostRender(profile, true);
      const art = buildArtifactSet(profile, { labMode: true }).semantic!;
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
    for (const labMode of [false, true]) {
      const worker = workerRender(profile, labMode);
      const host = hostRender(profile, labMode);
      for (const [label, html] of [["worker", worker], ["host", host]] as const) {
        expect(html, label).not.toContain("data-fr-canary-id");
        expect(html, label).not.toContain('data-rt-carrier="route"');
        // The prod notice is a mode-driven constant (emitted for every recipe);
        // what CONTROL must not carry is any PROFILE-BOUND defense artifact.
        expect(html, label).not.toMatch(/data-rt-token=/);
        expect(html, label).not.toMatch(/name="fr_/);
        // clientConfig script still ships (telemetry limits are profile-independent)
        expect(html, label).toContain('id="fr-client-config"');
      }
      expect(worker, `labMode=${labMode}`).not.toMatch(/name="fr_/);
      expect(host, `labMode=${labMode}`).not.toMatch(/name="fr_/);
    }
  });

  it("client config: BOTH mappers embed the IDENTICAL shared-core payload", async () => {
    const profile = await fullProfile("parity-client-config");
    for (const labMode of [false, true]) {
      const w = clientConfigPayload(workerRender(profile, labMode));
      const h = clientConfigPayload(hostRender(profile, labMode));
      expect(w).not.toBeNull();
      expect(h).not.toBeNull();
      // Byte-for-byte: one policy point, one JSON serialization.
      expect(w).toBe(h);
      const parsed = JSON.parse(w!) as { telemetry: unknown; limits: unknown };
      expect(parsed.telemetry).toEqual(profile.telemetry);
      expect(parsed.limits).toHaveProperty("maxEventsPerBatch");
    }
  });
});
