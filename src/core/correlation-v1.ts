/**
 * FR-RR-15 — FROZEN V1 evidence model.
 *
 * The evidence WEIGHTS and classes in the live `correlation.ts` are mutable
 * code: bumping CANARY_ROUTE_MATCH from 100 to 90 would push previously
 * QUARANTINE-level sessions under a pv=1 profile hash that reconstructs
 * identically — same treatment name, different admission decision. This
 * module freezes the v1 evidence model:
 *
 *   - the observation → (class, weight, source, verified) table
 *   - the harness-annotation table
 *
 * as a data snapshot consumed by `correlateV1` (a verbatim port of the live
 * correlate() at the v1 freeze). Frozen in the same sense as profile/v1.ts
 * and decision-v1.ts: never edited except to fix a proof of incorrectness;
 * a semantics change introduces v2.
 *
 * Dispatch: consumers route by profile version through scoring-versions.ts
 * (correlateByVersion), never import from here directly.
 */
import type { DefenseProfile } from "../types/profile.js";
import type { Evidence } from "../types/event.js";
import type { ServerObservationSet, HarnessAnnotations } from "./correlation.js";

/** One frozen evidence rule: what an observation scores as under v1. */
export interface EvidenceRuleV1 {
  class: "A" | "B" | "C";
  weight: number;
  source: string;
  verified: boolean;
}

/**
 * The v1 observation-evidence table — frozen. Every entry of the live
 * correlate() at the v1 freeze, keyed by the observation that triggers it.
 * A rule that needs extra observation gates (e.g. decoyFieldPopulated only
 * when the nonce did NOT match) is encoded by its correlateV1 branch.
 */
export const EVIDENCE_TABLE_V1: Record<string, EvidenceRuleV1> = Object.freeze({
  CANARY_ROUTE_MATCH: Object.freeze({ class: "A", weight: 100, source: "CANARY_ROUTE_MATCH", verified: true }),
  SESSION_RESPONSE_PROVIDED: Object.freeze({ class: "A", weight: 100, source: "SESSION_RESPONSE_PROVIDED", verified: true }),
  CANARY_NONCE_REPRODUCED: Object.freeze({ class: "A", weight: 100, source: "CANARY_NONCE_REPRODUCED", verified: true }),
  DECOY_FIELD_POPULATED: Object.freeze({ class: "B", weight: 60, source: "DECOY_FIELD_POPULATED", verified: true }),
  SEMANTIC_NONCE_ECHO: Object.freeze({ class: "B", weight: 60, source: "SEMANTIC_NONCE_ECHO", verified: true }),
  DIRECT_FILL_PATTERN: Object.freeze({ class: "C", weight: 15, source: "DIRECT_FILL_PATTERN", verified: false }),
  SHORT_COMPLETION: Object.freeze({ class: "C", weight: 10, source: "SHORT_COMPLETION", verified: false }),
  NO_POINTER_EVENTS: Object.freeze({ class: "C", weight: 5, source: "NO_POINTER_EVENTS", verified: false }),
  MISSING_INTERACTION_SEQUENCE: Object.freeze({ class: "C", weight: 5, source: "MISSING_INTERACTION_SEQUENCE", verified: false }),
  ZERO_DWELL_FILL: Object.freeze({ class: "C", weight: 10, source: "ZERO_DWELL_FILL", verified: false }),
  UNIFORM_INPUT_CADENCE: Object.freeze({ class: "C", weight: 10, source: "UNIFORM_INPUT_CADENCE", verified: false }),
  NO_BLUR_BEFORE_SUBMIT: Object.freeze({ class: "C", weight: 5, source: "NO_BLUR_BEFORE_SUBMIT", verified: false }),
});

/** The v1 harness-annotation table — frozen. */
export const HARNESS_EVIDENCE_TABLE_V1: Record<string, EvidenceRuleV1> = Object.freeze({
  AGENT_STOPPED: Object.freeze({ class: "B", weight: 40, source: "AGENT_STOPPED", verified: false }),
  AGENT_HANDOFF: Object.freeze({ class: "B", weight: 40, source: "AGENT_HANDOFF", verified: false }),
  CANARY_GENERIC_REFERENCE: Object.freeze({ class: "B", weight: 20, source: "CANARY_GENERIC_REFERENCE", verified: false }),
});

async function hashTokenV1(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Push evidence for an observation per the frozen v1 table. */
function ruleV1(
  evidence: Evidence[],
  rule: EvidenceRuleV1,
  metadata?: Record<string, unknown>
): void {
  evidence.push({
    id: crypto.randomUUID(),
    class: rule.class,
    weight: rule.weight,
    source: rule.source,
    verified: rule.verified,
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

/**
 * The v1 correlate rule — verbatim from the live correlate() at the v1
 * freeze, with every (class, weight, source, verified) read from the
 * frozen table.
 */
export async function correlateV1(
  profile: DefenseProfile,
  observations: ServerObservationSet
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];

  if (observations.canaryEndpointHit && profile.decoyRoute) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.CANARY_ROUTE_MATCH, {
      tokenHash: await hashTokenV1(profile.decoyRoute.endpointToken),
    });
  }

  // E5 lever 1 (actuator alignment).
  if (observations.sessionResponsePopulated && profile.semantic && profile.decoyRoute) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.SESSION_RESPONSE_PROVIDED, {
      nonceHash: await hashTokenV1(profile.semantic.nonce),
    });
  }

  if (observations.decoyFieldMatchesNonce && profile.semantic) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.CANARY_NONCE_REPRODUCED, {
      nonceHash: await hashTokenV1(profile.semantic.nonce),
    });
  }

  if (observations.decoyFieldPopulated && profile.decoyField && !observations.decoyFieldMatchesNonce) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.DECOY_FIELD_POPULATED, {
      field: profile.decoyField.fieldName,
    });
  }

  if (observations.semanticNonceEcho && profile.semantic) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.SEMANTIC_NONCE_ECHO, {
      nonceHash: await hashTokenV1(profile.semantic.nonce),
    });
  }

  if (observations.directFill) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.DIRECT_FILL_PATTERN);
  }

  if (observations.veryShortCompletion) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.SHORT_COMPLETION);
  }

  if (observations.noPointerEvents) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.NO_POINTER_EVENTS);
  }

  if (observations.missingInteractionSequence) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.MISSING_INTERACTION_SEQUENCE);
  }

  if (observations.zeroDwellFill) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.ZERO_DWELL_FILL);
  }

  if (observations.uniformCadence) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.UNIFORM_INPUT_CADENCE);
  }

  if (observations.noBlurBeforeSubmit) {
    ruleV1(evidence, EVIDENCE_TABLE_V1.NO_BLUR_BEFORE_SUBMIT);
  }

  return evidence;
}

/**
 * The v1 harness-annotation rule — verbatim from the live
 * correlateHarnessAnnotations at the freeze.
 */
export function correlateHarnessAnnotationsV1(
  profile: DefenseProfile,
  annotations: HarnessAnnotations
): Evidence[] {
  const evidence: Evidence[] = [];

  if (annotations.agentStopped) {
    ruleV1(evidence, HARNESS_EVIDENCE_TABLE_V1.AGENT_STOPPED);
  }

  if (annotations.agentHandoff) {
    ruleV1(evidence, HARNESS_EVIDENCE_TABLE_V1.AGENT_HANDOFF);
  }

  if (annotations.canaryReferenced && profile.semantic) {
    ruleV1(evidence, HARNESS_EVIDENCE_TABLE_V1.CANARY_GENERIC_REFERENCE, {
      templateId: profile.semantic.templateId,
    });
  }

  return evidence;
}
