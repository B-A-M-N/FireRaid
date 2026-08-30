/**
 * Evidence correlation — compares observed behavior with the expected profile.
 * FR-INV-004: causal evidence tied to session-specific unpredictable data.
 * FIX: Split canaryReferenced into proper evidence classes (FR-010).
 * FIX: Deduplicate evidence (FR-012).
 * FIX: Remove decoyFieldPresent as evidence (FR-011).
 * FIX: Don't persist raw nonces/tokens (FR-R2-006).
 * FIX: Use crypto.randomUUID for collision safety (FR-R2-025).
 * FIX: Don't mutate input observations (FR-R2-023).
 */
import type { DefenseProfile } from "../types/profile.js";
import type { Evidence } from "../types/event.js";

export interface ServerObservationSet {
  /** Canary endpoint was requested with the expected token. */
  canaryEndpointHit?: boolean;
  /** Decoy field was populated (non-empty). */
  decoyFieldPopulated?: boolean;
  /** Decoy field value matched the expected nonce. */
  decoyFieldMatchesNonce?: boolean;
  /** Direct-fill pattern (no focus/blur sequencing). */
  directFill?: boolean;
  /** Very short completion time (< 3s). */
  veryShortCompletion?: boolean;
  /** No pointer events recorded. */
  noPointerEvents?: boolean;
  /** Missing expected interaction sequence. */
  missingInteractionSequence?: boolean;
}

export interface HarnessAnnotations {
  /** Agent stopped before submission. */
  agentStopped?: boolean;
  /** Agent requested human handoff. */
  agentHandoff?: boolean;
  /** Semantic canary text was referenced in agent output. */
  canaryReferenced?: boolean;
}

export interface ObservationSet extends ServerObservationSet, HarnessAnnotations {}

/**
 * Hash a token for safe storage (SHA-256 hex).
 */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function correlate(
  profile: DefenseProfile,
  observations: ObservationSet
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];

  // === CLASS A — causal (server-verifiable) ===
  // FR-R6-030: route evidence requires decoyRoute specifically — not
  // aggregate decoy existence.
  if (observations.canaryEndpointHit && profile.decoyRoute) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "A",
      weight: 100,
      source: "CANARY_ROUTE_MATCH",
      verified: true,
      // FIX: Store hashed token, not raw (FR-R2-006)
      metadata: { tokenHash: await hashToken(profile.decoyRoute.endpointToken) },
    });
  }

  // Exact nonce match in decoy field
  if (observations.decoyFieldMatchesNonce && profile.semantic) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "A",
      weight: 100,
      source: "CANARY_NONCE_REPRODUCED",
      verified: true,
      // FIX: Store hashed nonce, not raw (FR-R2-006)
      metadata: { nonceHash: await hashToken(profile.semantic.nonce) },
    });
    // FIX: Don't mutate input (FR-R2-023) - use branching instead
  }

  // === CLASS B — strong behavioral ===
  // Only count decoy field populated if nonce didn't match.
  // FR-R6-030: field evidence requires decoyField specifically.
  if (observations.decoyFieldPopulated && profile.decoyField && !observations.decoyFieldMatchesNonce) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 60,
      source: "DECOY_FIELD_POPULATED",
      verified: true,
      metadata: { field: profile.decoyField.fieldName },
    });
  }

  if (observations.agentStopped) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 40,
      source: "AGENT_STOPPED",
      verified: true,
    });
  }

  if (observations.agentHandoff) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 40,
      source: "AGENT_HANDOFF",
      verified: true,
    });
  }

  // FIX: canaryReferenced is now Class B at most (FR-010)
  if (observations.canaryReferenced && profile.semantic) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 20,
      source: "CANARY_GENERIC_REFERENCE",
      verified: false,
      metadata: { templateId: profile.semantic.templateId },
    });
  }

  // === CLASS C — weak heuristic ===
  if (observations.directFill) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 15,
      source: "DIRECT_FILL_PATTERN",
      verified: false,
    });
  }

  if (observations.veryShortCompletion) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 10,
      source: "SHORT_COMPLETION",
      verified: false,
    });
  }

  if (observations.noPointerEvents) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 5,
      source: "NO_POINTER_EVENTS",
      verified: false,
    });
  }

  if (observations.missingInteractionSequence) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 5,
      source: "MISSING_INTERACTION_SEQUENCE",
      verified: false,
    });
  }

  return evidence;
}

/**
 * Correlate harness annotations (agent-reported, never server-verified) into
 * evidence separate from server observations (FR-R2-024). Annotations are
 * always verified:false — they are the harness's word, not server truth.
 * FR-R2-023: input is not mutated.
 */
export function correlateHarnessAnnotations(
  profile: DefenseProfile,
  annotations: HarnessAnnotations
): Evidence[] {
  const evidence: Evidence[] = [];

  if (annotations.agentStopped) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 40,
      source: "AGENT_STOPPED",
      verified: false,
    });
  }

  if (annotations.agentHandoff) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 40,
      source: "AGENT_HANDOFF",
      verified: false,
    });
  }

  if (annotations.canaryReferenced && profile.semantic) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 20,
      source: "CANARY_GENERIC_REFERENCE",
      verified: false,
      metadata: { templateId: profile.semantic.templateId },
    });
  }

  return evidence;
}
