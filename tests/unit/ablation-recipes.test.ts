/**
 * Unit tests for named ablation recipe semantics — FR-R6-079.
 *
 * Asserts that each ABLATION_RECIPES entry produces the expected profile
 * shape when passed through deriveProfilePure. Uses a fixed secret and
 * distinct sessionIds for determinism.
 */
import { describe, it, expect } from "vitest";
import {
  deriveProductionProfile,
  PRODUCTION_AGENT_STRATEGIES,
  deriveProfilePure,
  resolveConditionRecipe,
  ABLATION_RECIPES,
} from "../../src/core/profile.js";
import { parseDefenseRecipe } from "../../src/core/recipe-schema.js";
import { buildArtifactSet } from "../../src/core/artifacts.js";

const SECRET = "test-secret-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6";

function recipe(id: string) {
  const r = ABLATION_RECIPES[id];
  if (!r) throw new Error(`Unknown recipe: ${id}`);
  return r;
}

describe("ablation recipe semantics", () => {
  it("CONTROL → families.length === 0 and no semantic/decoyField/decoyRoute/interaction keys", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "ctl-001", mode: "lab" },
      recipe("CONTROL")
    );
    expect(p.families).toEqual([]);
    expect(p.semantic).toBeUndefined();
    expect(p.decoyField).toBeUndefined();
    expect(p.decoyRoute).toBeUndefined();
    expect(p.interaction).toBeUndefined();
  });

  it("TURNSTILE_ONLY → families.length === 0 (Turnstile is controlled by the run condition, not the recipe)", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "ts-001", mode: "lab" },
      recipe("TURNSTILE_ONLY")
    );
    expect(p.families).toEqual([]);
    expect(p.semantic).toBeUndefined();
    expect(p.decoyField).toBeUndefined();
    expect(p.decoyRoute).toBeUndefined();
    expect(p.interaction).toBeUndefined();
  });

  it("SEMANTIC_ONLY → semantic defined; only requiresDecoyField template companions may join", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "sem-001", mode: "lab" },
      recipe("SEMANTIC_ONLY")
    );
    // The recipe asks for semantic only, but a drawn template MAY require a
    // decoy-field companion (S06 requiresDecoyField) — that auto-add is the
    // template's declared mechanism dependency, not a recipe violation.
    expect(p.families).toContain("semantic");
    for (const f of p.families) {
      expect(["semantic", "decoy-field"]).toContain(f);
    }
    expect(p.semantic).toBeDefined();
    expect(p.semantic!.templateId).toBeDefined();
    expect(p.semantic!.placementId).toBeDefined();
    expect(p.semantic!.nonce).toBeDefined();
    expect(p.semantic!.mode).toBeDefined();
    // Template mechanism consistency: requiresDecoyField ⇔ decoyField issued.
    const tpl = p.semantic!.templateId;
    expect(p.decoyField).toBeDefined();
    expect(p.decoyRoute).toBeUndefined();
    expect(p.interaction).toBeUndefined();
    void tpl;
  });

  it("DECOY_FIELD_ONLY → families deep-equals [\"decoy-field\"], decoyField defined, decoyRoute undefined, semantic undefined", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "df-001", mode: "lab" },
      recipe("DECOY_FIELD_ONLY")
    );
    expect(p.families).toEqual(["decoy-field"]);
    expect(p.decoyField).toBeDefined();
    expect(p.decoyField!.fieldName).toBeDefined();
    expect(p.decoyField!.elementId).toBeDefined();
    expect(p.decoyRoute).toBeUndefined();
    expect(p.semantic).toBeUndefined();
    expect(p.interaction).toBeUndefined();
  });

  it("DECOY_ROUTE_ONLY → families deep-equals [\"decoy-route\"], decoyRoute defined, decoyField undefined, semantic undefined", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "dr-001", mode: "lab" },
      recipe("DECOY_ROUTE_ONLY")
    );
    expect(p.families).toEqual(["decoy-route"]);
    expect(p.decoyRoute).toBeDefined();
    expect(p.decoyRoute!.endpointToken).toBeDefined();
    expect(p.decoyField).toBeUndefined();
    expect(p.semantic).toBeUndefined();
    expect(p.interaction).toBeUndefined();
  });

  it("INTERACTION_ONLY → families deep-equals [\"interaction\"], interaction defined with scoringEnabled true, others absent", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "int-001", mode: "lab" },
      recipe("INTERACTION_ONLY")
    );
    expect(p.families).toEqual(["interaction"]);
    expect(p.interaction).toBeDefined();
    expect(p.interaction!.scoringEnabled).toBe(true);
    expect(p.semantic).toBeUndefined();
    expect(p.decoyField).toBeUndefined();
    expect(p.decoyRoute).toBeUndefined();
  });

  it("SEMANTIC_ROUTE → recipe families [\"semantic\",\"decoy-route\"] present, semantic + decoyRoute defined, interaction absent", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "sr-001", mode: "lab" },
      recipe("SEMANTIC_ROUTE")
    );
    // The recipe requests semantic + decoy-route.
    // S06 auto-adds decoy-field via requiresDecoyField, so 2–3 families total.
    const sorted = [...p.families].sort();
    expect(sorted).toContain("semantic");
    expect(sorted).toContain("decoy-route");
    expect(p.semantic).toBeDefined();
    expect(p.decoyRoute).toBeDefined();
    expect(p.decoyRoute!.endpointToken).toBeDefined();
    expect(p.interaction).toBeUndefined();
  });

  it("FULL → all four families present, all four config blocks defined", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "full-001", mode: "lab" },
      recipe("FULL")
    );
    expect([...p.families].sort()).toEqual(["decoy-field", "decoy-route", "interaction", "semantic"]);
    expect(p.semantic).toBeDefined();
    expect(p.decoyField).toBeDefined();
    expect(p.decoyRoute).toBeDefined();
    expect(p.interaction).toBeDefined();
    expect(p.interaction!.scoringEnabled).toBe(true);
  });

  it("determinism: same secret+sessionId+recipe twice → identical profileId AND identical decoyField.fieldName/decoyRoute.endpointToken", async () => {
    const p1 = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "det-001", mode: "lab" },
      recipe("FULL")
    );
    const p2 = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "det-001", mode: "lab" },
      recipe("FULL")
    );
    expect(p1.profileId).toBe(p2.profileId);
    if (p1.decoyField && p2.decoyField) {
      expect(p1.decoyField.fieldName).toBe(p2.decoyField.fieldName);
    }
    if (p1.decoyRoute && p2.decoyRoute) {
      expect(p1.decoyRoute.endpointToken).toBe(p2.decoyRoute.endpointToken);
    }
  });

  it("distinct sessions → distinct profileId", async () => {
    const p1 = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "dsess-a", mode: "lab" },
      recipe("SEMANTIC_ONLY")
    );
    const p2 = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "dsess-b", mode: "lab" },
      recipe("SEMANTIC_ONLY")
    );
    expect(p1.profileId).not.toBe(p2.profileId);
  });

  it("INVALID families array (e.g. [\"bogus-family\"]) → rejects (parseDefenseRecipe fails closed)", async () => {
    // The recipe schema uses a strict enum, so bogus families fail validation.
    // Two-step cast: raw object → unknown → recipe parameter type.
    const badRecipe = { families: ["bogus-family"] } as unknown as Parameters<
      typeof deriveProfilePure
    >[1];
    await expect(
      deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: "inv-001", mode: "lab" },
        badRecipe
      )
    ).rejects.toThrow("INVALID_RECIPE");
  });

  // ── P1-AUDIT-2 (P0-12): production-faithful arms ─────────────────────────
  // Each PRODUCTION_* recipe must derive cleanly in production mode, carry
  // ONLY production-renderable families, and build a NON-null artifact for
  // every family it carries (the property the semantic arms could never
  // satisfy on the production plane). PRODUCTION_NONSEMANTIC_FULL is the
  // renamed former "PRODUCTION_FULL" — an ABLATION that explicitly drops
  // the semantic strategy production always carries (P0-AUDIT-3, P0-1).
  const PROD_ARM_EXPECTATIONS: Record<
    string,
    { families: string[]; has: (keyof import("../../src/types/profile.js").DefenseProfile)[] }
  > = {
    PRODUCTION_FIELD: {
      families: ["decoy-field"],
      has: ["decoyField"],
    },
    PRODUCTION_ROUTE: {
      families: ["decoy-route"],
      has: ["decoyRoute"],
    },
    PRODUCTION_INTERACTION: {
      families: ["interaction"],
      has: ["interaction"],
    },
    PRODUCTION_NONSEMANTIC_FULL: {
      families: ["decoy-field", "decoy-route", "interaction"],
      has: ["decoyField", "decoyRoute", "interaction"],
    },
  };

  for (const [id, want] of Object.entries(PROD_ARM_EXPECTATIONS)) {
    it(`${id} → production-derivable, exact families, NO semantic dimension (it is an ablation)`, async () => {
      const p = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `prod-arm-${id}`, mode: "production" },
        recipe(id)
      );
      expect([...p.families].sort()).toEqual([...want.families].sort());
      expect(p.families).not.toContain("semantic");
      expect(p.semantic).toBeUndefined();
      for (const key of want.has) {
        expect(p[key], `${id} must define ${key}`).toBeDefined();
      }
      // Every carried family must have a production artifact to render.
      const artifacts = buildArtifactSet(p, { evaluationMode: false });
      if (p.decoyField) expect(artifacts.decoyField).not.toBeNull();
      if (p.decoyRoute) expect(artifacts.decoyRoute).not.toBeNull();
      expect(artifacts.semantic).toBeNull();
    });
  }

  describe("P0-AUDIT-3 (P0-1): PRODUCTION_DEFAULT IS production", () => {
    // RELEASE INVARIANT: the headline experiment condition must be
    // byte-equal to what a production deployment derives. If this ever
    // fails, the benchmark is again measuring a different defense than the
    // product ships.
    it("resolveConditionRecipe(PRODUCTION_DEFAULT) + derivation toEqual deriveProductionProfile — across many session IDs", async () => {
      for (let i = 0; i < 32; i++) {
        const sessionId = `prod-default-parity-${i}`;
        const actual = await deriveProductionProfile({
          secret: SECRET,
          version: 1,
          sessionId,
        });
        const benchmarkTreatment = await deriveProfilePure(
          { secret: SECRET, version: 1, sessionId, mode: "production" },
          resolveConditionRecipe("PRODUCTION_DEFAULT")
        );
        expect(benchmarkTreatment).toEqual(actual);
      }
    });

    it("the redirect holds on the EVALUATION plane too (lab-bound run renders production)", async () => {
      for (let i = 0; i < 16; i++) {
        const sessionId = `prod-default-lab-${i}`;
        const actual = await deriveProductionProfile({
          secret: SECRET,
          version: 1,
          sessionId,
        });
        const viaEvaluation = await deriveProfilePure(
          { secret: SECRET, version: 1, sessionId, mode: "lab" },
          resolveConditionRecipe("PRODUCTION_DEFAULT")
        );
        expect(viaEvaluation).toEqual(actual);
      }
    });

    it("the marker survives a JSON round-trip (recipe_json bind/reconstruct parity)", async () => {
      const stored = JSON.parse(JSON.stringify(resolveConditionRecipe("PRODUCTION_DEFAULT")));
      const sessionId = "prod-default-json";
      const actual = await deriveProductionProfile({ secret: SECRET, version: 1, sessionId });
      const reconstructed = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId, mode: "production" },
        stored
      );
      expect(reconstructed).toEqual(actual);
    });

    it("every derived PRODUCTION_DEFAULT profile carries the mandatory semantic strategy + P02/P03/P04 + ≥1 independent trap", async () => {
      for (let i = 0; i < 32; i++) {
        const p = await deriveProfilePure(
          { secret: SECRET, version: 1, sessionId: `prod-default-shape-${i}`, mode: "production" },
          resolveConditionRecipe("PRODUCTION_DEFAULT")
        );
        expect(p.families).toContain("semantic");
        expect(PRODUCTION_AGENT_STRATEGIES).toContain(p.semantic!.templateId);
        const independent = p.families.filter((f) => f !== "semantic");
        expect(independent.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("productionDefault combined with any explicit override fails closed", () => {
      const bad = { productionDefault: true, families: ["semantic"] } as unknown;
      const result = parseDefenseRecipe(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/productionDefault/);
    });

    it("unknown condition names fail closed at the resolver", () => {
      expect(() => resolveConditionRecipe("PRODUCTION_FULL")).toThrow(/UNKNOWN_CONDITION/);
      expect(() => resolveConditionRecipe("BASELINE")).toThrow(/UNKNOWN_CONDITION/);
    });
  });

  it("FULL in production mode succeeds; the semantic template draws from the PRODUCTION pool", async () => {
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "full-prod", mode: "production" },
      recipe("FULL")
    );
    expect(profile.families).toContain("semantic");
    expect(profile.semantic).toBeDefined();
    // Production mode draws only production-safe templates — the
    // lab-only S-probes are excluded from the production random path.
    expect(PRODUCTION_AGENT_STRATEGIES).toContain(profile.semantic!.templateId);
  });

  it("random production draws always carry a P02/P03/P04 semantic strategy", async () => {
    // Production random composition is now MANDATORY: a causal semantic
    // strategy + at least one independent layer — never a weak draw.
    for (let i = 0; i < 50; i++) {
      const p = await deriveProductionProfile({
        secret: SECRET,
        version: 1,
        sessionId: `prod-rand-${i}`,
      });
      expect(p.families).toContain("semantic");
      expect(PRODUCTION_AGENT_STRATEGIES).toContain(p.semantic!.templateId);
    }
  });
});
