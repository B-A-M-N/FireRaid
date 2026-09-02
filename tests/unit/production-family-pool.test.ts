/**
 * P1-AUDIT-2 Phase E (updated) — the production random family pool.
 *
 * After the architecture correction: environment (production/lab) must NOT
 * determine which defense families are available. Both random and explicit
 * profiles can include the semantic family in production.
 *
 * What still varies by mode:
 *   - Template rendering (buildArtifactSet returns null semantic in production;
 *     lab renders all S01–S09 templates)
 *   - Artifact presentation (lab-marked vs neutral carriers)
 *
 * Invariants pinned here:
 *   1. production random draws CAN include semantic;
 *   2. family count stays within [2, 4];
 *   3. lab mode works the same way (full pool);
 *   4. explicit semantic recipes succeed in production;
 *   5. lab-only templates (S01–S08) still fail in production (template guard).
 */
import { describe, it, expect } from "vitest";
import { deriveProductionProfile, deriveEvaluationProfile, deriveProfilePure, LAB_FAMILIES, PRODUCTION_AGENT_STRATEGIES } from "../../src/core/profile.js";
import { buildArtifactSet } from "../../src/core/artifacts.js";

const SECRET = "production-family-pool-secret".padEnd(32, "x");

describe("Phase E: production random family pool", () => {
  it("production random draws can include the semantic family (200 sessions)", async () => {
    let sawSemantic = false;
    for (let i = 0; i < 200; i++) {
      const profile = await deriveProductionProfile({
        secret: SECRET,
        version: 1,
        sessionId: `pool-prod-${i}`,
      });
      expect(profile.families).toContain("semantic");
      expect(PRODUCTION_AGENT_STRATEGIES).toContain(profile.semantic!.templateId);
      if (profile.families.includes("semantic")) sawSemantic = true;
    }
    // With pool of 4 families and draw of 2–4, semantic should appear ~50% of time.
    expect(sawSemantic, "semantic appeared in production draws").toBe(true);
  });

  it("production draw never throws; composition invariants hold (semantic + >=1 independent layer)", async () => {
    for (let i = 0; i < 300; i++) {
      const profile = await deriveProductionProfile({
        secret: SECRET,
        version: 2,
        sessionId: `pool-clamp-${i}`,
      });
      expect(profile.families).toContain("semantic");
      expect(profile.families.length).toBeGreaterThanOrEqual(2);
      expect(profile.families.length).toBeLessThanOrEqual(4);
    }
  });

  it("lab draws still reach the semantic family (full pool retained)", async () => {
    let sawSemantic = 0;
    for (let i = 0; i < 100; i++) {
      const profile = await deriveEvaluationProfile({
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

  it("explicit semantic recipe in production SUCCEEDS (environment does not restrict families)", async () => {
    const profile = await deriveProfilePure(
      {
        secret: SECRET,
        version: 1,
        sessionId: "pool-explicit-s09-prod",
        mode: "production",
      },
      { families: ["semantic"], semanticTemplate: "S09", placementId: "P06" }
    );
    expect(profile.families).toContain("semantic");
    expect(profile.semantic).toBeDefined();
    expect(profile.semantic!.templateId).toBe("S09");
  });

  it("explicit S09 recipe still works in LAB (where its probe actually renders)", async () => {
    const profile = await deriveEvaluationProfile(
      {
        secret: SECRET,
        version: 1,
        sessionId: "pool-explicit-s09-lab",
        mode: "lab",
      },
      { families: ["semantic"], semanticTemplate: "S09", placementId: "P06" }
    );
    expect(profile.families).toContain("semantic");
    expect(profile.semantic?.templateId).toBe("S09");
    // And the artifact core agrees: lab mode renders the S09 marker.
    expect(buildArtifactSet(profile, { evaluationMode: true }).semantic).not.toBeNull();
  });

  it("explicit lab-only template in production still throws (template guard intact)", async () => {
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

  it("evaluation plane keeps the full family pool (no mode-based family exclusion)", async () => {
    // LAB_FAMILIES remains the evaluation-plane random pool (all 4 families).
    expect(LAB_FAMILIES.length).toBe(4);
  });
});
