/**
 * FR-RR-15 — FROZEN V1 decision policy + decision rule.
 *
 * The profile version freeze (FR-P0-04) froze the profile ARTIFACT
 * (families, placement, tokens, scoring-policy NAME) but not the ADMISSION
 * TREATMENT: the live `decision.ts` tables and `decide()` remained mutable,
 * so a deployment could change `default-v1`'s thresholds and every pv=1
 * session already in flight would decide DIFFERENTLY under a profile that
 * reconstructs to the exact same hash.
 *
 * This module is the v1 snapshot of:
 *   - the scoring-policy table (default-v1 / strict-v1 / permissive-v1)
 *   - the decide() rule (threshold branch order and downgrade guard)
 *
 * It is frozen in the same sense as profile/v1.ts: never edited except to
 * fix a proof of incorrectness in the freeze itself (with a ledger note).
 * A semantics change must introduce v2 and leave v1 untouched.
 *
 * Dispatch: consumers do NOT import from here directly — they route by the
 * profile's version through `scoring-versions.ts` (getScoringPolicyByVersion /
 * decideByVersion), so a v2 engine change cannot mutate "default-v1".
 */
import type { Evidence, DecisionRecord, Disposition } from "../types/event.js";
import { ScoringPolicyShapeError } from "./scoring-errors.js";

/** The ScoringPolicy shape, as consumed by decideV1. (Structurally
 * identical to decision.ts's interface; kept local so the frozen module
 * does not import the live one.) */
export interface ScoringPolicyV1 {
  name: string;
  quarantineOnCausal: boolean;
  reviewScoreThreshold: number;
  quarantineScoreThreshold: number;
  strongReviewThreshold?: number;
}

/** v1 policy table — frozen. Values as shipped at the v1 freeze. */
export const KNOWN_POLICIES_V1: Record<string, ScoringPolicyV1> = {
  "default-v1": Object.freeze({
    name: "default-v1",
    quarantineOnCausal: true,
    reviewScoreThreshold: 50,
    quarantineScoreThreshold: 100,
    strongReviewThreshold: 80,
  }),
  "strict-v1": Object.freeze({
    name: "strict-v1",
    quarantineOnCausal: true,
    reviewScoreThreshold: 30,
    quarantineScoreThreshold: 80,
    strongReviewThreshold: 60,
  }),
  "permissive-v1": Object.freeze({
    name: "permissive-v1",
    quarantineOnCausal: true,
    reviewScoreThreshold: 70,
    quarantineScoreThreshold: 120,
    strongReviewThreshold: 90,
  }),
};

Object.freeze(KNOWN_POLICIES_V1);

/** Look up a named v1 policy or throw for unknown names (fail closed).
 * FR-RR-31: the failure is TYPED — ScoringPolicyShapeError, the error class
 * callers map to their operational paths (FR-RR-34). */
export function getPolicyOrThrowV1(name: string): ScoringPolicyV1 {
  const policy = KNOWN_POLICIES_V1[name];
  if (!policy) throw new ScoringPolicyShapeError(`UNKNOWN_POLICY: ${name}`);
  return policy;
}

export function scoreV1(evidence: Evidence[]): number {
  return evidence.reduce((sum, e) => sum + e.weight, 0);
}

export function countByClassV1(
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

/** The v1 decide() rule — verbatim from the live engine at the freeze. */
export function decideV1(
  evidence: Evidence[],
  policy: ScoringPolicyV1 = KNOWN_POLICIES_V1["default-v1"]
): DecisionRecord {
  const { causal, strong } = countByClassV1(evidence);
  const total = scoreV1(evidence);
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
