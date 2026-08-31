/**
 * Unit tests for profile recipe validation and FR-R4 audit fixes.
 * Tests: FR-R4-011, FR-R4-019, FR-R4-020, FR-R4-021, FR-R4-022, FR-R4-024.
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure, type DefenseRecipe } from "../../src/core/profile.js";
import { getPolicy, getPolicyOrThrow, decide } from "../../src/core/decision.js";
import { renderCanaryForProfile } from "../../src/core/renderer.js";

const TEST_SECRET = "a".repeat(64);

describe("FR-R4-021: recipe with unknown semanticTemplate throws UNKNOWN_TEMPLATE", () => {
  it("throws for non-existent template id", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S99",
      placementId: "P01",
      labOnly: true,
    };
    await expect(
      deriveProfilePure(
        { secret: TEST_SECRET, version: 1, sessionId: "test-unknown-tpl", mode: "lab" },
        recipe
      )
    ).rejects.toThrow("UNKNOWN_TEMPLATE: S99");
  });
});

describe("FR-R4-021: recipe with invalid placement for template throws INVALID_PLACEMENT_FOR_TEMPLATE", () => {
  it("throws when placement not in template.allowedPlacements", async () => {
    // S01 allowedPlacements: ["P01","P02","P03","P04","P05"] — P06 is NOT included
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S01",
      placementId: "P06",
      labOnly: true,
    };
    await expect(
      deriveProfilePure(
        { secret: TEST_SECRET, version: 1, sessionId: "test-invalid-pl", mode: "lab" },
        recipe
      )
    ).rejects.toThrow("INVALID_PLACEMENT_FOR_TEMPLATE: P06");
  });
});

describe("FR-R4-021: recipe with unknown scoringPolicy throws UNKNOWN_POLICY", () => {
  it("throws for non-existent policy", async () => {
    const recipe: DefenseRecipe = {
      scoringPolicy: "ghost-policy-xyz",
      labOnly: true,
    };
    await expect(
      deriveProfilePure(
        { secret: TEST_SECRET, version: 1, sessionId: "test-unknown-pol", mode: "lab" },
        recipe
      )
    ).rejects.toThrow("UNKNOWN_POLICY: ghost-policy-xyz");
  });
});

describe("FR-R4-011: interaction family => scoringEnabled === true (loop 30 sessions)", () => {
  it("scoringEnabled is deterministically true when interaction family present", async () => {
    for (let i = 0; i < 30; i++) {
      const recipe: DefenseRecipe = {
        families: ["interaction"],
        labOnly: true,
      };
      const profile = await deriveProfilePure(
        { secret: TEST_SECRET, version: 1, sessionId: `scoring-${i}`, mode: "lab" },
        recipe
      );
      expect(profile.families).toContain("interaction");
      expect(profile.interaction).toBeDefined();
      expect(profile.interaction!.scoringEnabled).toBe(true);
    }
  });
});

describe("FR-R4-019: S06 auto-adds decoy-field via requiresDecoyField", () => {
  it("recipe with S06 adds decoy-field automatically", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S06",
      placementId: "P01",
      labOnly: true,
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-s06-decoy", mode: "lab" },
      recipe
    );
    expect(profile.families).toContain("semantic");
    expect(profile.families).toContain("decoy-field");
    expect(profile.decoyField).toBeDefined();
    expect(profile.decoyField!.fieldName).toMatch(/^fr_/);
  });
});

describe("FR-R4-022: getPolicyOrThrow vs getPolicy legacy compat", () => {
  it("getPolicyOrThrow works for known policy", () => {
    const policy = getPolicyOrThrow("default-v1");
    expect(policy.name).toBe("default-v1");
  });

  it("getPolicyOrThrow throws for unknown policy", () => {
    expect(() => getPolicyOrThrow("nope")).toThrow("UNKNOWN_POLICY: nope");
  });

  it("getPolicy still falls back for unknown (legacy compat)", () => {
    const fallback = getPolicy("nope");
    expect(fallback.name).toBe("default-v1");
  });
});

describe("FR-R4-022: decide() quarantineScoreThreshold", () => {
  it("causal evidence >= threshold => QUARANTINE", () => {
    const evidence = [
      { id: "1", class: "A" as const, weight: 100, source: "test", verified: true },
    ];
    // default-v1 has quarantineScoreThreshold: 100, score=100 >= 100 => QUARANTINE
    const d = getPolicyOrThrow("default-v1");
    const result = decide(evidence, d);
    expect(result.disposition).toBe("QUARANTINE");
  });

  it("causal evidence < threshold => REVIEW (not QUARANTINE)", () => {
    const evidence = [
      { id: "1", class: "A" as const, weight: 99, source: "test", verified: true },
    ];
    // score 99 < quarantineScoreThreshold 100 => REVIEW
    const d = getPolicyOrThrow("default-v1");
    const result = decide(evidence, d);
    expect(result.disposition).toBe("REVIEW");
    expect(result.reasons.some((r) => r.toLowerCase().includes("quarantine threshold"))).toBe(true);
  });

  it("causal evidence 100 exactly at threshold => QUARANTINE (boundary)", () => {
    const evidence = [
      { id: "1", class: "A" as const, weight: 100, source: "test", verified: true },
    ];
    const d = getPolicyOrThrow("default-v1");
    const result = decide(evidence, d);
    expect(result.disposition).toBe("QUARANTINE");
  });
});

describe("FR-R4-024: profileVariantId includes all treatment variables", () => {
  it("variant IDs differ when semanticMode differs", async () => {
    const recipe1: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S01",
      placementId: "P01",
      semanticMode: "observe",
      labOnly: true,
    };
    const recipe2: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S01",
      placementId: "P01",
      semanticMode: "handoff",
      labOnly: true,
    };
    const p1 = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "mode-observe", mode: "lab" },
      recipe1
    );
    const p2 = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "mode-handoff", mode: "lab" },
      recipe2
    );
    expect(p1.profileVariantId).toBeDefined();
    expect(p2.profileVariantId).toBeDefined();
    expect(p1.profileVariantId).not.toBe(p2.profileVariantId);
  });
});

describe("FR-R4-020: S06 mode-dependent rendering", () => {
  it("decoy mode renders decoy instruction text", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic", "decoy-field"],
      semanticTemplate: "S06",
      placementId: "P01",
      semanticMode: "decoy",
      labOnly: true,
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "s06-decoy", mode: "lab" },
      recipe
    );
    expect(profile.semantic!.mode).toBe("decoy");
    const html = renderCanaryForProfile(profile, { labMode: true });
    expect(html).toContain("Decoy-control acknowledgement");
    expect(html).toContain("data-fr-canary=\"S06\"");
  });

  it("observe mode renders observe instruction text for S06", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic", "decoy-field"],
      semanticTemplate: "S06",
      placementId: "P01",
      semanticMode: "observe",
      labOnly: true,
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "s06-observe", mode: "lab" },
      recipe
    );
    expect(profile.semantic!.mode).toBe("observe");
    const html = renderCanaryForProfile(profile, { labMode: true });
    expect(html).toContain("Automation Test Marker");
    expect(html).toContain("data-fr-canary=\"S06\"");
  });

  it("handoff mode renders handoff instruction text for S06", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic", "decoy-field"],
      semanticTemplate: "S06",
      placementId: "P01",
      semanticMode: "handoff",
      labOnly: true,
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "s06-handoff", mode: "lab" },
      recipe
    );
    expect(profile.semantic!.mode).toBe("handoff");
    const html = renderCanaryForProfile(profile, { labMode: true });
    expect(html).toContain("Human confirmation required");
    expect(html).toContain("data-fr-canary=\"S06\"");
  });
});

describe("FR-R4-021: random fallback when no explicit override", () => {
  it("no recipe => default policy accepted without validation", async () => {
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "no-recipe", mode: "lab" }
    );
    expect(profile.scoringPolicy).toBe("default-v1");
  });
});

describe("FR-R4-021: labOnly guard still works", () => {
  it("labOnly recipe in production throws", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S01",
      placementId: "P01",
      labOnly: true,
    };
    await expect(
      deriveProfilePure(
        { secret: TEST_SECRET, version: 1, sessionId: "prod-fail", mode: "production" },
        recipe
      )
    ).rejects.toThrow("Lab-only recipe cannot be used in production mode");
  });
});
