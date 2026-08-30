/**
 * Scoring + decision engine.
 * FR-INV-005: weak heuristics must not be silently promoted to causal evidence.
 */
import type { Evidence, DecisionRecord, Disposition } from "../types/event.js";

export interface ScoringPolicy {
  name: string;
  quarantineOnCausal: boolean;
  reviewScoreThreshold: number;
  quarantineScoreThreshold: number;
  /** Threshold for strong behavioral evidence to require human review. Default: 80. */
  strongReviewThreshold?: number;
}

export const DEFAULT_POLICY: ScoringPolicy = {
  name: "default-v1",
  quarantineOnCausal: true,
  reviewScoreThreshold: 50,
  quarantineScoreThreshold: 100,
  strongReviewThreshold: 80,
};

/** Known scoring policies — extend as new policies are added. */
export const KNOWN_POLICIES: Record<string, ScoringPolicy> = {
  "default-v1": DEFAULT_POLICY,
  "strict-v1": {
    name: "strict-v1",
    quarantineOnCausal: true,
    reviewScoreThreshold: 30,
    quarantineScoreThreshold: 80,
    strongReviewThreshold: 60,
  },
  "permissive-v1": {
    name: "permissive-v1",
    quarantineOnCausal: true,
    reviewScoreThreshold: 70,
    quarantineScoreThreshold: 120,
    strongReviewThreshold: 90,
  },
};

/** List all registered scoring policies (FR-R2-022). */
export function listPolicies(): ScoringPolicy[] {
  return Object.values(KNOWN_POLICIES);
}

/** Look up a named scoring policy, falling back to default for unknown names. */
export function getPolicy(name: string | undefined | null): ScoringPolicy {
  if (!name) return DEFAULT_POLICY;
  return KNOWN_POLICIES[name] ?? DEFAULT_POLICY;
}

/** Look up a named scoring policy or throw for unknown names. */
export function getPolicyOrThrow(name: string): ScoringPolicy {
  const policy = KNOWN_POLICIES[name];
  if (!policy) throw new Error(`UNKNOWN_POLICY: ${name}`);
  return policy;
}

export function score(evidence: Evidence[]): number {
  return evidence.reduce((sum, e) => sum + e.weight, 0);
}

export function countByClass(
  evidence: Evidence[]
): { causal: number; strong: number; weak: number } {
  let causal = 0, strong = 0, weak = 0;
  for (const e of evidence) {
    if (e.class === "A") causal++;
    else if (e.class === "B") strong++;
    else if (e.class === "C") weak++;
  }
  return { causal, strong, weak };
}

export function decide(
  evidence: Evidence[],
  policy: ScoringPolicy = DEFAULT_POLICY
): DecisionRecord {
  const { causal, strong } = countByClass(evidence);
  const total = score(evidence);
  const reasons: string[] = [];
  let disposition: Disposition = "ACCEPT";

  // Whether the causal branch reached a terminal QUARANTINE decision —
  // later review/accept branches must not run (and must not DOWNGRADE a
  // quarantine: the original single-if form let `total >= reviewScoreThreshold`
  // overwrite a just-issued QUARANTINE with REVIEW).
  let quarantined = false;

  if (causal >= 1 && total >= policy.quarantineScoreThreshold) {
    if (policy.quarantineOnCausal) {
      disposition = "QUARANTINE";
      quarantined = true;
      reasons.push(`Class A causal evidence detected (${causal} hits)`);
    } else {
      reasons.push(`Causal evidence present but policy disables quarantine-on-causal`);
      // Fall through to strong/review/accept logic below.
    }
  }

  if (!quarantined) {
    if (
      strong >= 1 &&
      total >= (policy.strongReviewThreshold ?? 80)
    ) {
      disposition = "REVIEW";
      reasons.push(
        `Strong behavioral evidence with high score (${total})`
      );
    } else if (total >= policy.reviewScoreThreshold) {
      disposition = "REVIEW";
      reasons.push(
        `Score ${total} exceeds review threshold ${policy.reviewScoreThreshold}`
      );
    } else {
      disposition = "ACCEPT";
      reasons.push(`Score ${total} below threshold; no causal evidence`);
    }
  }

  // When causal evidence is present but below quarantine threshold,
  // note that in the reasons.
  if (causal >= 1 && total < policy.quarantineScoreThreshold) {
    reasons.push(
      `Causal evidence detected but below quarantine threshold ${policy.quarantineScoreThreshold}`
    );
  }

  return {
    policy: policy.name,
    signals: evidence,
    score: total,
    disposition,
    reasons,
    createdAt: Date.now(),
  };
}
