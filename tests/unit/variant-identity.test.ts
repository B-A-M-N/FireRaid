/**
 * FR-P0-17: the verification condition is part of the treatment identity.
 *
 * profileVariantId hashes turnstile_required (buildVariantId). The audit
 * found that issuance/reconstruction never PASSED the assigned condition
 * through, so every real variant encoded false even when the lab condition
 * required verification — otherwise-identical conditions collapsed onto the
 * same variant id.
 *
 * These tests pin the contract: deriveProfilePure/reconstructIssuedProfile
 * with the same inputs but turnstileRequired flipped MUST produce different
 * stable variant ids, and MUST produce identical ids when the flag is
 * threaded consistently (issuance == reconstruction).
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

const TEST_SECRET = "a".repeat(64);
const SID = "variant-identity-session";

const RECIPE: DefenseRecipe = {
  families: ["semantic", "decoy-field"],
  semanticTemplate: "S01",
  placementId: "P01",
  labOnly: true,
};

describe("FR-P0-17: turnstileRequired is part of the variant identity", () => {
  it("flipping the condition flips the variant id", async () => {
    const off = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: false },
      RECIPE
    );
    const on = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: true },
      RECIPE
    );
    expect(on.profileVariantId).not.toBe(off.profileVariantId);
  });

  it("same condition → identical variant id (stability)", async () => {
    const a = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: true },
      RECIPE
    );
    const b = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: true },
      RECIPE
    );
    expect(a.profileVariantId).toBe(b.profileVariantId);
  });

  it("the condition changes ONLY the variant id — profile fields are seed-derived and stay identical", async () => {
    // Scoring/correlation consume profile fields (seed-derived); the
    // verification condition must not perturb them, only the identity hash.
    const off = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: false },
      RECIPE
    );
    const on = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: true },
      RECIPE
    );
    expect(on.families).toEqual(off.families);
    expect(on.semantic?.templateId).toBe(off.semantic?.templateId);
    expect(on.telemetry).toEqual(off.telemetry);
    expect(on.scoringPolicy).toBe(off.scoringPolicy);
    expect(on.profileId).toBe(off.profileId);
  });

  it("default (unspecified) resolves to the same profile as explicit false", async () => {
    const implicit = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab" },
      RECIPE
    );
    const explicitFalse = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: SID, mode: "lab", turnstileRequired: false },
      RECIPE
    );
    expect(implicit.profileVariantId).toBe(explicitFalse.profileVariantId);
  });
});
