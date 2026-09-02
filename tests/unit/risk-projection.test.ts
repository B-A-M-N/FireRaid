/**
 * Risk projection + advisory/enforcement mode tests.
 */
import { describe, it, expect } from "vitest";
import {
  projectRisk,
  getRiskTier,
  validateRiskTierConfig,
  inferConfidence,
  resolveRuntimeDisposition,
  projectWorkflowState,
  type RiskTierConfig,
  DEFAULT_RISK_TIERS,
} from "../../src/core/risk.js";
import type { Evidence } from "../../src/types/event.js";

function ev(
  classification: "A" | "B" | "C",
  weight: number,
  source: string,
  verified = true
): Evidence {
  return { id: "x", class: classification, weight, source, verified };
}

describe("risk projection", () => {
  it("maps scores to the four tiers", () => {
    expect(getRiskTier(0).tier).toBe("LOW");
    expect(getRiskTier(39).tier).toBe("LOW");
    expect(getRiskTier(40).tier).toBe("ELEVATED");
    expect(getRiskTier(99).tier).toBe("ELEVATED");
    expect(getRiskTier(100).tier).toBe("HIGH");
    expect(getRiskTier(199).tier).toBe("HIGH");
    expect(getRiskTier(200).tier).toBe("CAUSAL");
    expect(getRiskTier(500).tier).toBe("CAUSAL");
  });

  it("uses supplied tier configuration", () => {
    const custom: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 10,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 10,
        maxScore: null,
        tier: "CAUSAL",
        recommendedAction: "QUARANTINE",
        autoSuppress: true,
      },
    ];
    expect(getRiskTier(5, custom).tier).toBe("LOW");
    expect(getRiskTier(10, custom).tier).toBe("CAUSAL");
  });

  it("verified Class-A evidence forces CAUSAL tier regardless of score", () => {
    // DEFECT FIX: score 100 with verified Class-A was incorrectly HIGH.
    // One verified session-specific causal event is definitionally causal.
    const evidence = [ev("A", 100, "CANARY_ROUTE_MATCH", true)];
    const risk = projectRisk(100, evidence);
    expect(risk.tier).toBe("CAUSAL");
    expect(risk.recommendedAction).toBe("QUARANTINE");
    expect(risk.confidence).toBe("HIGH");
    expect(risk.hasCausalEvidence).toBe(true);
  });

  it("unverified Class-A evidence does NOT force CAUSAL tier", () => {
    // hasCausalEvidence stays true (any Class-A presence), but tier is
    // score-derived because the Class-A event was not verified.
    const evidence = [ev("A", 100, "CANARY_ROUTE_MATCH", false)];
    const risk = projectRisk(100, evidence);
    expect(risk.tier).toBe("HIGH"); // score 100 → HIGH band
    expect(risk.recommendedAction).toBe("SUPPRESS_AUTO_APPROVAL");
    expect(risk.hasCausalEvidence).toBe(true); // still reports Class-A presence
  });

  it("uses custom CAUSAL tier config when verified Class-A forces override", () => {
    const custom: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 50,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 50,
        maxScore: 100,
        tier: "HIGH",
        recommendedAction: "SUPPRESS",
        autoSuppress: false,
      },
      {
        minScore: 100,
        maxScore: null,
        tier: "CAUSAL",
        recommendedAction: "QUARANTINE_PERMANENT",
        autoSuppress: true,
      },
    ];
    const evidence = [ev("A", 30, "CANARY_ROUTE_MATCH", true)];
    const risk = projectRisk(30, evidence, custom);
    expect(risk.tier).toBe("CAUSAL");
    expect(risk.recommendedAction).toBe("QUARANTINE_PERMANENT");
  });

  it("infers HIGH confidence from causal evidence", () => {
    const evidence = [ev("A", 100, "CANARY_ROUTE_MATCH")];
    expect(inferConfidence(evidence, "HIGH")).toBe("HIGH");
  });

  it("infers MEDIUM confidence from a single strong signal", () => {
    const evidence = [ev("B", 60, "DECOY_FIELD_POPULATED")];
    expect(inferConfidence(evidence, "ELEVATED")).toBe("MEDIUM");
  });

  it("formats evidence descriptions for reviewers", () => {
    const risk = projectRisk(100, [ev("A", 100, "CANARY_ROUTE_MATCH")]);
    // FIXED: score 100 + verified Class-A now projects to CAUSAL (was HIGH).
    expect(risk.tier).toBe("CAUSAL");
    expect(risk.confidence).toBe("HIGH");
    expect(risk.evidence[0].description).toContain("decoy route");
    expect(risk.hasCausalEvidence).toBe(true);
  });

  it("projectWorkflowState never reveals score", () => {
    expect(projectWorkflowState("ACCEPT").status).toBe("accepted");
    expect(projectWorkflowState("REVIEW").status).toBe("review");
    expect(projectWorkflowState("QUARANTINE").status).toBe("quarantine");
  });
});

describe("validateRiskTierConfig", () => {
  it("accepts DEFAULT_RISK_TIERS", () => {
    expect(validateRiskTierConfig(DEFAULT_RISK_TIERS)).toBeNull();
  });

  it("rejects an empty array", () => {
    const err = validateRiskTierConfig([]);
    expect(err).not.toBeNull();
    expect(err).toBe("RISK_TIERS_EMPTY");
  });

  it("rejects a config with a gap between bands", () => {
    const flawed: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 100,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 200,
        maxScore: null,
        tier: "CAUSAL",
        recommendedAction: "QUARANTINE",
        autoSuppress: true,
      },
    ];
    const err = validateRiskTierConfig(flawed);
    expect(err).not.toBeNull();
    expect(err).toBe("RISK_TIERS_GAP");
  });

  it("rejects an inverted band (descending minScore)", () => {
    const inverted: RiskTierConfig[] = [
      {
        minScore: 100,
        maxScore: 200,
        tier: "HIGH",
        recommendedAction: "SUPPRESS",
        autoSuppress: false,
      },
      {
        minScore: 0,
        maxScore: 100,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
    ];
    const err = validateRiskTierConfig(inverted);
    expect(err).not.toBeNull();
    // P0 exact-partition: the anchor check fires first (first.minScore must
    // be 0), so a HIGH-before-LOW shape reports the partition violation.
    expect([
      "RISK_TIERS_NOT_SORTED",
      "RISK_TIERS_NOT_ANCHORED_AT_ZERO",
      "RISK_TIERS_OVERLAP",
      "RISK_TIERS_GAP",
    ]).toContain(err);
  });

  it("rejects a config missing the CAUSAL tier", () => {
    const noCausal: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 50,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 50,
        maxScore: null,
        tier: "HIGH",
        recommendedAction: "SUPPRESS",
        autoSuppress: true,
      },
    ];
    const err = validateRiskTierConfig(noCausal);
    expect(err).not.toBeNull();
    expect(err).toBe("RISK_TIERS_MISSING_CAUSAL");
  });

  it("rejects a band with maxScore <= minScore", () => {
    const badBand: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 0,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 1,
        maxScore: null,
        tier: "CAUSAL",
        recommendedAction: "QUARANTINE",
        autoSuppress: true,
      },
    ];
    const err = validateRiskTierConfig(badBand);
    expect(err).not.toBeNull();
    expect(["RISK_TIERS_INVALID_BAND", "RISK_TIERS_GAP"]).toContain(err);
  });

  it("getRiskTier throws INVALID_RISK_TIERS for gap config", () => {
    const gapConfig: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 100,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 200,
        maxScore: null,
        tier: "CAUSAL",
        recommendedAction: "QUARANTINE",
        autoSuppress: true,
      },
    ];
    expect(() => getRiskTier(50, gapConfig)).toThrow(
      "INVALID_RISK_TIERS: RISK_TIERS_GAP"
    );
  });

  it("getRiskTier throws INVALID_RISK_TIERS for empty config", () => {
    expect(() => getRiskTier(50, [])).toThrow(
      "INVALID_RISK_TIERS: RISK_TIERS_EMPTY"
    );
  });

  it("getRiskTier throws INVALID_RISK_TIERS for missing CAUSAL", () => {
    const noCausal: RiskTierConfig[] = [
      {
        minScore: 0,
        maxScore: 100,
        tier: "LOW",
        recommendedAction: "CONTINUE",
        autoSuppress: false,
      },
      {
        minScore: 100,
        maxScore: null,
        tier: "HIGH",
        recommendedAction: "SUPPRESS",
        autoSuppress: true,
      },
    ];
    expect(() => getRiskTier(50, noCausal)).toThrow(
      "INVALID_RISK_TIERS: RISK_TIERS_MISSING_CAUSAL"
    );
  });

  // ── P0 exact-partition contract ──────────────────────────────────────────
  // The bands must tile [0, ∞) exactly: first.min=0, adjacent max==next.min,
  // last.max=null, exactly one CAUSAL and it must be the terminal band. A
  // config that cannot partition the score space is a STARTUP FAILURE —
  // never papered over with a "highest tier" fallback.
  it("DEFAULT_RISK_TIERS is an exact partition of [0, ∞)", () => {
    expect(DEFAULT_RISK_TIERS[0].minScore).toBe(0);
    for (let i = 1; i < DEFAULT_RISK_TIERS.length; i++) {
      expect(
        DEFAULT_RISK_TIERS[i - 1].maxScore,
        `band ${i - 1}→${i} adjacency`
      ).toBe(DEFAULT_RISK_TIERS[i].minScore);
    }
    expect(DEFAULT_RISK_TIERS[DEFAULT_RISK_TIERS.length - 1].maxScore).toBeNull();
    expect(validateRiskTierConfig(DEFAULT_RISK_TIERS)).toBeNull();
  });

  it("rejects a config not anchored at 0", () => {
    const floating: RiskTierConfig[] = [
      { minScore: 10, maxScore: 50, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
      { minScore: 50, maxScore: null, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
    ];
    expect(validateRiskTierConfig(floating)).toBe("RISK_TIERS_NOT_ANCHORED_AT_ZERO");
  });

  it("rejects OVERLAPPING bands (the adjacency rule)", () => {
    const overlap: RiskTierConfig[] = [
      { minScore: 0, maxScore: 60, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
      { minScore: 50, maxScore: null, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
    ];
    expect(validateRiskTierConfig(overlap)).toBe("RISK_TIERS_OVERLAP");
  });

  it("rejects a config whose CAUSAL tier is not the terminal band", () => {
    const midCausal: RiskTierConfig[] = [
      { minScore: 0, maxScore: 50, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
      { minScore: 50, maxScore: 100, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
      { minScore: 100, maxScore: null, tier: "HIGH", recommendedAction: "SUPPRESS", autoSuppress: false },
    ];
    expect(validateRiskTierConfig(midCausal)).toBe("RISK_TIERS_CAUSAL_NOT_TERMINAL");
  });

  it("getRiskTier has NO out-of-partition fallback (throws, never reclassifies)", () => {
    // Valid partition: every nonnegative score resolves.
    for (const s of [0, 1, 39, 40, 99, 100, 199, 200, 10_000]) {
      expect(() => getRiskTier(s, DEFAULT_RISK_TIERS)).not.toThrow();
    }
    // The validated partition leaves NO unmatched score — the old
    // "highest band by minScore" fallback is gone; a caller passing an
    // unvalidated (gapped) config must crash, not silently reclassify.
    const gapped: RiskTierConfig[] = [
      { minScore: 0, maxScore: 40, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
      { minScore: 100, maxScore: null, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
    ];
    expect(validateRiskTierConfig(gapped)).toBe("RISK_TIERS_GAP");
    expect(() => getRiskTier(50, gapped)).toThrow();
  });
});

describe("enforcement mode runtime disposition", () => {
  it("advisory mode always returns ACCEPT at the boundary", () => {
    const tier = getRiskTier(250);
    expect(resolveRuntimeDisposition("QUARANTINE", "advisory", tier)).toBe(
      "ACCEPT"
    );
  });

  it("enforcement mode auto-suppresses CAUSAL tier", () => {
    const tier = getRiskTier(200);
    expect(tier.autoSuppress).toBe(true);
    expect(resolveRuntimeDisposition("REVIEW", "enforcement", tier)).toBe(
      "QUARANTINE"
    );
  });

  it("enforcement mode does not auto-suppress HIGH tier", () => {
    const tier = getRiskTier(150);
    expect(tier.autoSuppress).toBe(false);
    expect(resolveRuntimeDisposition("REVIEW", "enforcement", tier)).toBe(
      "REVIEW"
    );
  });

  it("review mode collapses QUARANTINE to REVIEW for human override", () => {
    const tier = getRiskTier(250);
    expect(resolveRuntimeDisposition("QUARANTINE", "review", tier)).toBe(
      "REVIEW"
    );
  });
});
