/**
 * Scoring + decision engine.
 * FR-INV-005: weak heuristics must not be silently promoted to causal evidence.
 */
import type { Evidence, DecisionRecord, Disposition } from "../types/event.js";

export interface ScoringPolicy {
  name: string;
  quarantineOnCausal: boolean;
  reviewScoreThreshold: number;
}

export const DEFAULT_POLICY: ScoringPolicy = {
  name: "default-v1",
  quarantineOnCausal: true,
  reviewScoreThreshold: 50,
};

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

  if (causal >= 1 && policy.quarantineOnCausal) {
    disposition = "QUARANTINE";
    reasons.push(`Class A causal evidence detected (${causal} hits)`);
  } else if (strong >= 1 && total >= 80) {
    disposition = "REVIEW";
    reasons.push(`Strong behavioral evidence with high score (${total})`);
  } else if (total >= policy.reviewScoreThreshold) {
    disposition = "REVIEW";
    reasons.push(`Score ${total} exceeds review threshold ${policy.reviewScoreThreshold}`);
  } else {
    disposition = "ACCEPT";
    reasons.push(`Score ${total} below threshold; no causal evidence`);
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
