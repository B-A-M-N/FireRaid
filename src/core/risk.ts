/**
 * Risk-tier + advisory/enforcement abstraction.
 *
 * FireRaid's product thesis is "admission risk assessment, not account
 * approval" (FR-INV-008). This module defines the risk tiers, confidence
 * levels, and runtime enforcement modes that let the same deterministic
 * evidence power three deployment postures:
 *
 *   advisory   - never block; annotate every submission for human review
 *   review     - quarantine/review blocks auto-approval; human can override
 *   enforcement- quarantine auto-rejects; review still allows override
 *
 * The decision engine (decision.ts) stays focused on evidence → score.
 * Risk projection (this module) turns that score into reviewer-facing
 * recommendations and applicant-facing workflow states.
 */

import type { Evidence, Disposition } from "../types/event.js";

export type RiskTier = "LOW" | "ELEVATED" | "HIGH" | "CAUSAL";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type EnforcementMode = "advisory" | "review" | "enforcement";

export interface RiskTierConfig {
  /** Inclusive lower bound. */
  minScore: number;
  /** Exclusive upper bound (null = unbounded). */
  maxScore: number | null;
  tier: RiskTier;
  /** Human-readable recommendation. */
  recommendedAction: string;
  /**
   * Whether this tier, by itself, is strong enough to warrant automatic
   * suppression when the deployment is in enforcement mode.
   */
  autoSuppress: boolean;
}

export const DEFAULT_RISK_TIERS: RiskTierConfig[] = [
  { minScore: 0, maxScore: 40, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
  { minScore: 40, maxScore: 100, tier: "ELEVATED", recommendedAction: "MANUAL_REVIEW", autoSuppress: false },
  { minScore: 100, maxScore: 200, tier: "HIGH", recommendedAction: "SUPPRESS_AUTO_APPROVAL", autoSuppress: false },
  { minScore: 200, maxScore: null, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
];

export interface RiskProjection {
  score: number;
  tier: RiskTier;
  confidence: Confidence;
  recommendedAction: string;
  /** True when the evidence contains at least one Class-A causal signal. */
  hasCausalEvidence: boolean;
  /** Evidence list formatted for reviewers (no raw tokens/nonces). */
  evidence: Array<{
    id: string;
    class: "A" | "B" | "C";
    weight: number;
    source: string;
    verified: boolean;
    description: string;
  }>;
}

export function inferConfidence(
  evidence: Evidence[],
  tier: RiskTier
): Confidence {
  const causal = evidence.some((e) => e.class === "A");
  if (causal || tier === "CAUSAL") return "HIGH";
  const strongCount = evidence.filter((e) => e.class === "B").length;
  if (strongCount >= 2 || tier === "HIGH") return "HIGH";
  if (strongCount === 1 || tier === "ELEVATED") return "MEDIUM";
  return "LOW";
}

/**
 * Validate that a risk-tier configuration is well-formed.
 * Returns null when the config is valid; returns an error string otherwise.
 *
 * Checks:
 *  - Non-empty array.
 *  - Bands sorted ascending by minScore.
 *  - Every band: maxScore is null OR maxScore > minScore.
 *  - No gaps between consecutive bands (next.minScore must equal prev.maxScore
 *    when prev.maxScore !== null).
 *  - At least one tier named "CAUSAL" exists.
 */
export function validateRiskTierConfig(
  tiers: RiskTierConfig[]
): string | null {
  if (tiers.length === 0) return "RISK_TIERS_EMPTY";

  // EXACT PARTITION (P0): the bands must tile [0, ∞) with no gap, no
  // overlap, and no boundary ambiguity. Permissive orderings (overlaps,
  // gaps papered over by a fallback) make the tier a function of config
  // accident rather than of score.
  //
  //   first.minScore === 0
  //   tiers[i].maxScore === tiers[i+1].minScore   (adjacency)
  //   last.maxScore === null                       (open top)
  //   maxScore > minScore within every finite band
  //   ascending by minScore (implied by adjacency, checked explicitly)
  //   exactly one CAUSAL tier, and it must be the OPEN-TOPPED last band —
  //     causal evidence must always land in the strongest action band.
  if (tiers[0].minScore !== 0) return "RISK_TIERS_NOT_ANCHORED_AT_ZERO";

  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const curr = tiers[i];
    if (curr.minScore <= prev.minScore) return "RISK_TIERS_NOT_SORTED";
    if (prev.maxScore === null) return "RISK_TIERS_PREMATURE_OPEN_TOP";
    if (prev.maxScore !== curr.minScore) {
      return prev.maxScore > curr.minScore ? "RISK_TIERS_OVERLAP" : "RISK_TIERS_GAP";
    }
  }

  for (const tier of tiers) {
    if (tier.maxScore !== null && tier.maxScore <= tier.minScore) {
      return "RISK_TIERS_INVALID_BAND";
    }
  }

  if (tiers[tiers.length - 1].maxScore !== null) return "RISK_TIERS_NOT_EXHAUSTIVE";

  // Must contain a CAUSAL tier, and it must be the last (open-topped) band.
  const causalCount = tiers.filter((t) => t.tier === "CAUSAL").length;
  if (causalCount === 0) return "RISK_TIERS_MISSING_CAUSAL";
  if (causalCount > 1) return "RISK_TIERS_MULTIPLE_CAUSAL";
  if (tiers[tiers.length - 1].tier !== "CAUSAL") return "RISK_TIERS_CAUSAL_NOT_TERMINAL";

  return null;
}

/**
 * Resolve a score to the matching risk-tier configuration entry.
 *
 * The supplied tiers (or DEFAULT_RISK_TIERS) must form an EXACT partition
 * of [0, ∞) — validateRiskTierConfig enforces it. When the config is
 * invalid this function throws; there is deliberately NO fallback band: a
 * config that cannot partition the score space is a startup failure, never
 * a silent reclassification of out-of-band scores into a "highest tier".
 */
export function getRiskTier(
  score: number,
  tiers: RiskTierConfig[] = DEFAULT_RISK_TIERS
): RiskTierConfig {
  const err = validateRiskTierConfig(tiers);
  if (err) throw new Error("INVALID_RISK_TIERS: " + err);

  for (const tier of tiers) {
    if (score >= tier.minScore && (tier.maxScore === null || score < tier.maxScore)) {
      return tier;
    }
  }
  // Unreachable for a validated partition: bands tile [0, ∞) exactly, so
  // every nonnegative score matches exactly one band. A negative score is
  // a caller bug — fail loudly rather than invent a tier.
  throw new Error("SCORE_OUT_OF_PARTITION: " + score);
}

function describeEvidence(e: Evidence): string {
  switch (e.source) {
    case "CANARY_ROUTE_MATCH":
      return "Session-specific decoy route was accessed";
    case "CANARY_NONCE_REPRODUCED":
      return "Hidden machine-only field populated with the exact session nonce";
    case "DECOY_FIELD_POPULATED":
      return "Hidden decoy field was populated";
    case "AGENT_STOPPED":
      return "Automation reported stopping before submission";
    case "AGENT_HANDOFF":
      return "Automation requested human handoff";
    case "CANARY_GENERIC_REFERENCE":
      return "Semantic trap was referenced generically";
    case "DIRECT_FILL_PATTERN":
      return "Form fields filled without normal focus/blur sequencing";
    case "SHORT_COMPLETION":
      return "Completion was unusually fast";
    case "NO_POINTER_EVENTS":
      return "No pointer events recorded when capture was enabled";
    case "MISSING_INTERACTION_SEQUENCE":
      return "Expected interaction sequence was missing";
    default:
      return e.source;
  }
}

/**
 * projectRisk — map a decision score + evidence to a reviewer-facing risk
 * projection.
 *
 * hasCausalEvidence reports whether the evidence contains *any* Class-A
 * signal (verified or not). Callers may use this for metadata or UI hints.
 *
 * The projected tier is CAUSAL only when there is at least one **verified**
 * Class-A causal observation — a single verified session-specific causal
 * event is definitionally causal regardless of the numeric score sum. The
 * score bands classify only non-causal suspicion.
 */
export function projectRisk(
  score: number,
  evidence: Evidence[],
  tiers: RiskTierConfig[] = DEFAULT_RISK_TIERS
): RiskProjection {
  // Base tier from score bands (validates tier config internally)
  let tierConfig = getRiskTier(score, tiers);

  // Any verified Class-A observation forces CAUSAL tier.
  // Unverified Class-A does NOT force CAUSAL — it may indicate noise.
  if (evidence.some((e) => e.class === "A" && e.verified === true)) {
    // Find the CAUSAL tier config — use custom config if present, else
    // fall back to DEFAULT_RISK_TIERS.
    const causalConfig =
      tiers.find((t) => t.tier === "CAUSAL") ??
      DEFAULT_RISK_TIERS.find((t) => t.tier === "CAUSAL")!;
    tierConfig = causalConfig;
  }

  return {
    score,
    tier: tierConfig.tier,
    confidence: inferConfidence(evidence, tierConfig.tier),
    recommendedAction: tierConfig.recommendedAction,
    hasCausalEvidence: evidence.some((e) => e.class === "A"),
    evidence: evidence.map((e) => ({
      id: e.id,
      class: e.class,
      weight: e.weight,
      source: e.source,
      verified: e.verified,
      description: describeEvidence(e),
    })),
  };
}

/**
 * Determine the runtime disposition given the core decision and the
 * deployment enforcement mode.
 *
 * In advisory mode every submission is ACCEPT at the boundary so the
 * upstream/manual review workflow can see the annotation. The underlying
 * FireRaid decision is still persisted for calibration.
 */
export function resolveRuntimeDisposition(
  coreDisposition: Disposition,
  mode: EnforcementMode,
  tierConfig: RiskTierConfig
): Disposition {
  if (mode === "advisory") {
    return "ACCEPT";
  }
  if (mode === "enforcement" && tierConfig.autoSuppress) {
    return "QUARANTINE";
  }
  // review mode (and enforcement for non-auto-suppress tiers) keeps the
  // core decision — REVIEW or ACCEPT.
  return coreDisposition === "QUARANTINE" ? "REVIEW" : coreDisposition;
}

/**
 * Applicant-facing workflow state. Never reveals the real score or
 * disposition; only whether they proceed normally or enter review.
 */
export function projectWorkflowState(coreDisposition: Disposition): {
  status: "accepted" | "review" | "quarantine";
  message: string;
} {
  if (coreDisposition === "ACCEPT") {
    return { status: "accepted", message: "Submission received." };
  }
  if (coreDisposition === "QUARANTINE") {
    return {
      status: "quarantine",
      message: "Submission requires additional verification before it can proceed.",
    };
  }
  return {
    status: "review",
    message: "Submission is under review. You will be notified once it has been processed.",
  };
}
