/**
 * Regression tests for FR-R2 Pass B fixes.
 * Verifies: environment filtering, P06 production-eligible, distinct placements,
 * policy registry, profile recipes, telemetry mode.
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure, type DefenseRecipe } from "../../src/core/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS, lintAllCanaries } from "../../src/core/catalog.js";
import { getPolicy, listPolicies, DEFAULT_POLICY } from "../../src/core/decision.js";
import { correlate, correlateHarnessAnnotations } from "../../src/core/correlation.js";

const TEST_SECRET = "a".repeat(64);

describe("FR-R2-016: Environment filtering", () => {
  it("production mode excludes lab-only templates (S01-S08)", async () => {
    // In production mode, only labOnly=false templates are eligible
    // All S01-S08 are labOnly=true, so only S09 should be eligible
    for (let i = 0; i < 50; i++) {
      const profile = await deriveProfilePure({
        secret: TEST_SECRET,
        version: 1,
        sessionId: `prod-${i}`,
        mode: "production",
      });
      if (profile.semantic) {
        const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
        expect(template).toBeDefined();
        expect(template!.labOnly).toBe(false);
      }
    }
  });

  it("production mode only selects production-eligible placements", async () => {
    for (let i = 0; i < 50; i++) {
      const profile = await deriveProfilePure({
        secret: TEST_SECRET,
        version: 1,
        sessionId: `prod-${i}`,
        mode: "production",
      });
      if (profile.semantic) {
        const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
        expect(placement).toBeDefined();
        expect(placement!.productionEligible).toBe(true);
      }
    }
  });

  it("lab mode may select lab-only templates", async () => {
    let foundLabOnly = false;
    for (let i = 0; i < 100; i++) {
      const profile = await deriveProfilePure({
        secret: TEST_SECRET,
        version: 1,
        sessionId: `lab-${i}`,
        mode: "lab",
      });
      if (profile.semantic) {
        const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
        if (template?.labOnly) {
          foundLabOnly = true;
          break;
        }
      }
    }
    expect(foundLabOnly).toBe(true);
  });
});

describe("FR-R2-017: P06 is production-eligible", () => {
  it("P06 has productionEligible=true", () => {
    const p06 = PLACEMENTS.find((p) => p.id === "P06");
    expect(p06).toBeDefined();
    expect(p06!.productionEligible).toBe(true);
  });

  it("P01-P05 have productionEligible=false", () => {
    for (const p of PLACEMENTS) {
      if (p.id !== "P06") {
        expect(p.productionEligible).toBe(false);
      }
    }
  });

  it("each placement has a unique position", () => {
    const positions = PLACEMENTS.map((p) => p.position);
    const unique = new Set(positions);
    expect(unique.size).toBe(positions.length);
  });
});

describe("FR-R2-022: Scoring policy registry", () => {
  it("getPolicy returns policy by name", () => {
    const strict = getPolicy("strict-v1");
    expect(strict.name).toBe("strict-v1");
    expect(strict.reviewScoreThreshold).toBe(30);
  });

  it("getPolicy falls back to default for unknown name", () => {
    const unknown = getPolicy("nonexistent");
    expect(unknown.name).toBe(DEFAULT_POLICY.name);
  });

  it("listPolicies returns multiple policies", () => {
    const policies = listPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(3);
  });

  it("strict policy quarantines at lower score", () => {
    const strict = getPolicy("strict-v1");
    const permissive = getPolicy("permissive-v1");
    expect(strict.reviewScoreThreshold).toBeLessThan(permissive.reviewScoreThreshold);
  });
});

describe("FR-R2-021: Semantic mode from template", () => {
  it("deriveProfile uses template.defaultMode", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S06", // S06 has defaultMode "decoy"
      placementId: "P01",
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-mode", mode: "lab" },
      recipe
    );
    expect(profile.semantic).toBeDefined();
    expect(profile.semantic!.mode).toBe("decoy");
  });

  it("recipe can override template defaultMode", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S06",
      placementId: "P01",
      semanticMode: "observe",
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-override", mode: "lab" },
      recipe
    );
    expect(profile.semantic).toBeDefined();
    expect(profile.semantic!.mode).toBe("observe");
  });
});

describe("FR-R2-027: Profile recipes", () => {
  it("recipe can force specific families (semantic with requiresRoute adds decoy-route)", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic", "decoy-field"],
      semanticTemplate: "S04", // S04 has requiresRoute: true
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-recipe", mode: "lab" },
      recipe
    );
    // Semantic with requiresRoute auto-adds decoy-route
    expect(profile.families).toEqual(["decoy-field", "decoy-route", "semantic"]);
  });

  it("recipe can force semantic without route (no decoy-route added)", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S01", // S01 has requiresRoute: false
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-no-route", mode: "lab" },
      recipe
    );
    expect(profile.families).toEqual(["semantic"]);
    expect(profile.decoyRoute).toBeUndefined();
  });

  it("recipe can force decoy-field alone", async () => {
    const recipe: DefenseRecipe = {
      families: ["decoy-field"],
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-decoy-only", mode: "lab" },
      recipe
    );
    expect(profile.families).toEqual(["decoy-field"]);
  });

  it("recipe can force specific template and placement", async () => {
    const recipe: DefenseRecipe = {
      families: ["semantic"],
      semanticTemplate: "S04",
      placementId: "P03",
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-specific", mode: "lab" },
      recipe
    );
    expect(profile.semantic!.templateId).toBe("S04");
    expect(profile.semantic!.placementId).toBe("P03");
  });

  it("recipe can override scoring policy", async () => {
    const recipe: DefenseRecipe = {
      scoringPolicy: "strict-v1",
    };
    const profile = await deriveProfilePure(
      { secret: TEST_SECRET, version: 1, sessionId: "test-policy", mode: "lab" },
      recipe
    );
    expect(profile.scoringPolicy).toBe("strict-v1");
  });
});

describe("FR-R2-023: Correlation does not mutate input", () => {
  it("correlate does not modify observations", async () => {
    const profile = await deriveProfilePure({
      secret: TEST_SECRET,
      version: 1,
      sessionId: "test-mutation",
      mode: "lab",
    });
    profile.decoyRoute = { endpointToken: "abc123" };
    profile.semantic = { templateId: "S01", placementId: "P01", nonce: "NONCE1", mode: "observe" };

    const observations = {
      canaryEndpointHit: true,
      decoyFieldPopulated: true,
      decoyFieldMatchesNonce: false,
    };
    const before = JSON.stringify(observations);
    await correlate(profile, observations);
    const after = JSON.stringify(observations);
    expect(after).toBe(before);
  });
});

describe("FR-R2-024: Harness annotations separate from server observations", () => {
  it("correlateHarnessAnnotations returns evidence for agentStopped", async () => {
    const profile = await deriveProfilePure({
      secret: TEST_SECRET,
      version: 1,
      sessionId: "test-harness",
      mode: "lab",
    });
    const evidence = correlateHarnessAnnotations(profile, { agentStopped: true });
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("AGENT_STOPPED");
    expect(evidence[0].verified).toBe(false);
  });

  it("correlateHarnessAnnotations returns evidence for canaryReferenced", async () => {
    const profile = await deriveProfilePure({
      secret: TEST_SECRET,
      version: 1,
      sessionId: "test-ref",
      mode: "lab",
    });
    profile.semantic = { templateId: "S01", placementId: "P01", nonce: "NONCE1", mode: "observe" };
    const evidence = correlateHarnessAnnotations(profile, { canaryReferenced: true });
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("CANARY_GENERIC_REFERENCE");
    expect(evidence[0].verified).toBe(false);
  });
});

describe("Catalog linter", () => {
  it("finds no prohibited patterns in any template", () => {
    expect(lintAllCanaries()).toEqual([]);
  });
});
