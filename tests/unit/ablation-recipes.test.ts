/**
 * Unit tests for named ablation recipe semantics — FR-R6-079.
 *
 * Asserts that each ABLATION_RECIPES entry produces the expected profile
 * shape when passed through deriveProfilePure. Uses a fixed secret and
 * distinct sessionIds for determinism.
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure, ABLATION_RECIPES } from "../../src/core/profile.js";

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

  it("SEMANTIC_ONLY → families deep-equals [\"semantic\"], profile.semantic defined, others absent", async () => {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "sem-001", mode: "lab" },
      recipe("SEMANTIC_ONLY")
    );
    expect(p.families).toEqual(["semantic"]);
    expect(p.semantic).toBeDefined();
    expect(p.semantic!.templateId).toBeDefined();
    expect(p.semantic!.placementId).toBeDefined();
    expect(p.semantic!.nonce).toBeDefined();
    expect(p.semantic!.mode).toBeDefined();
    expect(p.decoyField).toBeUndefined();
    expect(p.decoyRoute).toBeUndefined();
    expect(p.interaction).toBeUndefined();
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
});
