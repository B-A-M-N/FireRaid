/**
 * P1-AUDIT-2 Phase E — the production RANDOM family pool.
 *
 * FR-R7-013 makes S01–S08 lab-only, and FR-R6-041 excludes S09 (the only
 * labOnly:false template) from random selection. Net effect, BEFORE this
 * fix: a production random draw that picked the "semantic" family rendered
 * NOTHING (buildArtifactSet returns null semantic in production) while the
 * drawn slot still consumed 1–2 slots of the 2–4 family draw and skewed
 * variant identity (buildVariantId includes families + semantic dims).
 *
 * The fix filters the RANDOM pool to production-renderable families; these
 * tests pin that:
 *   1. no production random draw ever contains "semantic";
 *   2. no production random profile ever carries profile.semantic;
 *   3. the draw never throws ("sample count exceeds population") — the
 *      count is clamped to the filtered pool;
 *   4. lab mode keeps the FULL pool (semantic still drawn there);
 *   5. explicit recipes still reach semantic in production when legal
 *      (S09, the fail-closed validateExplicitOverrides path).
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure } from "../../src/core/profile.js";
import { buildArtifactSet } from "../../src/core/artifacts.js";

const SECRET = "production-family-pool-secret".padEnd(32, "x");

describe("Phase E: production random family pool", () => {
  it("production draws NEVER include the semantic family (300 sessions)", async () => {
    for (let i = 0; i < 300; i++) {
      const profile = await deriveProfilePure({
        secret: SECRET,
        version: 1,
        sessionId: `pool-prod-${i}`,
        mode: "production",
      });
      expect(profile.families, `session ${i}`).not.toContain("semantic");
      expect(profile.semantic, `session ${i}`).toBeUndefined();
      // And the shared core agrees: no semantic artifact to render.
      expect(buildArtifactSet(profile, { labMode: false }).semantic).toBeNull();
    }
  });

  it("production draw never throws; family count stays within [2, pool]", async () => {
    // The raw count draw can reach 4 but the production pool holds 3
    // families — the pre-fix code threw "sample count exceeds population".
    for (let i = 0; i < 300; i++) {
      const profile = await deriveProfilePure({
        secret: SECRET,
        version: 2,
        sessionId: `pool-clamp-${i}`,
        mode: "production",
      });
      expect(profile.families.length).toBeGreaterThanOrEqual(2);
      expect(profile.families.length).toBeLessThanOrEqual(3);
    }
  });

  it("lab draws still reach the semantic family (full pool retained)", async () => {
    let sawSemantic = 0;
    for (let i = 0; i < 100; i++) {
      const profile = await deriveProfilePure({
        secret: SECRET,
        version: 1,
        sessionId: `pool-lab-${i}`,
        mode: "lab",
      });
      if (profile.families.includes("semantic")) sawSemantic++;
    }
    // P(semantic in a 2–4 draw of 4) is high; flake-proof threshold 10/100.
    expect(sawSemantic).toBeGreaterThan(10);
  });

  it("explicit S09 recipe still works in production (fail-closed validation path)", async () => {
    const profile = await deriveProfilePure(
      {
        secret: SECRET,
        version: 1,
        sessionId: "pool-explicit-s09",
        mode: "production",
      },
      { families: ["semantic"], semanticTemplate: "S09", placementId: "P06" }
    );
    expect(profile.families).toContain("semantic");
    expect(profile.semantic?.templateId).toBe("S09");
  });

  it("explicit lab-only template in production still throws (guard intact)", async () => {
    await expect(
      deriveProfilePure(
        {
          secret: SECRET,
          version: 1,
          sessionId: "pool-explicit-s06",
          mode: "production",
        },
        { families: ["semantic"], semanticTemplate: "S06", placementId: "P01" }
      )
    ).rejects.toThrow();
  });
});
