/**
 * FR-RR-15 — VERSION-ROUTED scoring/evidence/decision dispatch.
 *
 * The profile-version freeze (FR-P0-04) pinned the profile ARTIFACT; this
 * module completes the freeze to the full ADMISSION TREATMENT: the evidence
 * model (weights/classes) and the decision policy+rule, dispatched by the
 * profile's OWN version rather than resolved from live code.
 *
 * The invariant this enforces:
 *
 *   A v2 change (new weights, new thresholds, new evidence rules) must not
 *   be able to mutate what a pv=1 session decides. Consumers route through
 *   here with the reconstructed profile; an UNKNOWN version fails closed —
 *   never a silent fall-through to live code.
 *
 * Parity: for v1, correlateV1/decideV1 are verbatim ports of the live
 * correlation/decision modules at the freeze, pinned by tests
 * (tests/unit/scoring-versions-parity.test.ts) that prove byte-equality of
 * evidence sequences and decisions between the frozen and live v1 paths —
 * so the freeze cannot silently drift from what shipped.
 */
import type { DefenseProfile } from "../types/profile.js";
import type { Evidence, DecisionRecord } from "../types/event.js";
import type { ServerObservationSet, HarnessAnnotations } from "./correlation.js";
import type { ScoringPolicy } from "./decision.js";
import { ScoringPolicyShapeError } from "./scoring-errors.js";
import {
  correlateV1,
  correlateHarnessAnnotationsV1,
} from "./correlation-v1.js";
import {
  getPolicyOrThrowV1,
  decideV1,
  type ScoringPolicyV1,
} from "./decision-v1.js";
import { SUPPORTED_PROFILE_VERSIONS } from "./profile-versions.js";

/**
 * FR-RR-44 — scoring owns ITS implementation REGISTRY, mirroring the
 * profile freeze's PROFILE_VERSION_IMPLEMENTATIONS: a version is scorable
 * ONLY through a frozen implementation REGISTERED here, never because its
 * number happens to appear in SUPPORTED_PROFILE_VERSIONS. The old
 * construction (a Set derived FROM SUPPORTED_PROFILE_VERSIONS, dispatch
 * hard-wired to the v1 calls) meant adding `2` to the profile registry
 * automatically granted SCORING support for v2 while V1 silently scored it
 * — the exact defect FR-RR-31 was filed to eliminate. Now the registries
 * are independent: registering a profile version does nothing for scoring
 * until its scoring freeze lands here, and vice versa.
 */
interface ScoringImplementation {
  correlate: typeof correlateV1;
  correlateHarnessAnnotations: typeof correlateHarnessAnnotationsV1;
  getPolicy: typeof getPolicyOrThrowV1;
  decide: typeof decideV1;
}

const SCORING_IMPLEMENTATIONS: ReadonlyMap<number, ScoringImplementation> = new Map([
  [
    1,
    {
      // The FROZEN v1 scoring implementation (correlation-v1 + decision-v1),
      // pinned by tests/unit/scoring-versions-parity.test.ts.
      correlate: correlateV1,
      correlateHarnessAnnotations: correlateHarnessAnnotationsV1,
      getPolicy: getPolicyOrThrowV1,
      decide: decideV1,
    },
  ],
]);

/**
 * Cross-registry ASSERTION: the two registries must AGREE on the currently
 * released set. This is a consistency check, not a source of truth — it
 * runs in dev/test to catch a registry that drifted (a version registered
 * for derivation but never scored, or the reverse), and FAILS on a
 * mismatch. It must never synthesize missing scoring support.
 * @internal
 */
export function assertScoringRegistryCoversProfileVersions(): void {
  const profile = new Set(SUPPORTED_PROFILE_VERSIONS as readonly number[]);
  const scoring = new Set(SCORING_IMPLEMENTATIONS.keys());
  const missingScoring = [...profile].filter((v) => !scoring.has(v));
  const missingProfile = [...scoring].filter((v) => !profile.has(v));
  if (missingScoring.length > 0 || missingProfile.length > 0) {
    throw new Error(
      `SCORING_REGISTRY_MISMATCH: profile versions without frozen scoring: ` +
        `[${missingScoring.join(", ") || "none"}]; scoring versions without frozen ` +
        `profiles: [${missingProfile.join(", ") || "none"}] — register the missing ` +
        `implementation, do not widen one registry to satisfy the other`
    );
  }
}

/** True when the version has a FROZEN scoring implementation on disk. */
export function isSupportedScoringVersion(version: number): boolean {
  return SCORING_IMPLEMENTATIONS.has(version);
}

function implementationFor(version: number): ScoringImplementation {
  const impl = SCORING_IMPLEMENTATIONS.get(version);
  if (!impl) {
    throw new ScoringPolicyShapeError(
      `UNSUPPORTED_PROFILE_VERSION: ${version} has no frozen scoring implementation ` +
        `(registered: ${[...SCORING_IMPLEMENTATIONS.keys()].join(", ")}) — refusing to score ` +
        `against live code (the FR-RR-15 treatment-drift hazard)`
    );
  }
  return impl;
}

/** Narrow the live ScoringPolicy type to the frozen v1 shape (identical). */
function asV1(policy: ScoringPolicyV1): ScoringPolicy {
  return policy;
}

/**
 * Version-routed scoring-policy resolution. Throws
 * ScoringPolicyShapeError on (a) an unregistered version or (b) a
 * policy name the frozen version's table does not know — callers convert
 * to their fail-closed denial (UNKNOWN_SCORING_POLICY), never a default-
 * policy fallback.
 */
export function getScoringPolicyByVersion(
  version: number,
  policyName: string
): ScoringPolicy {
  // v1's table is v1's; a future version registers its own getPolicy.
  return asV1(implementationFor(version).getPolicy(policyName));
}

/**
 * Version-routed evidence correlation. The profile's own version selects
 * the frozen evidence model. Unregistered version fails closed (throws).
 */
export async function correlateByVersion(
  profile: DefenseProfile,
  observations: ServerObservationSet
): Promise<Evidence[]> {
  return implementationFor(profile.version).correlate(profile, observations);
}

/** Version-routed harness-annotation correlation. Same contract. */
export function correlateHarnessAnnotationsByVersion(
  profile: DefenseProfile,
  annotations: HarnessAnnotations
): Evidence[] {
  return implementationFor(profile.version).correlateHarnessAnnotations(profile, annotations);
}

/**
 * Version-routed decision. The policy must come from
 * getScoringPolicyByVersion(version, profile.scoringPolicy) — the caller
 * resolves it so a resolution failure is distinguishable from a decision.
 * Unregistered version fails closed (throws).
 */
export function decideByVersion(
  profile: DefenseProfile,
  evidence: Evidence[],
  policy: ScoringPolicy
): DecisionRecord {
  return implementationFor(profile.version).decide(evidence, policy);
}
