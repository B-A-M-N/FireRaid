/**
 * Evidence correlation - compares observed behavior with the expected profile.
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
  /** The semantic canary nonce was echoed into a non-defense form field. */
  semanticNonceEcho?: boolean;
  /**
   * E5 lever 1: the session_response actuator sink was populated in a
   * route-armed session (the fill-expressible compliant act for P02/P04).
   */
  sessionResponsePopulated?: boolean;
  /** Direct-fill pattern (no focus/blur sequencing). */
  directFill?: boolean;
  /** Very short completion time (< 3s). */
  veryShortCompletion?: boolean;
  /** No pointer events recorded. */
  noPointerEvents?: boolean;
  /** Missing expected interaction sequence. */
  missingInteractionSequence?: boolean;
  /** E5 lever 5: focus→input gap under the dwell floor on some field. */
  zeroDwellFill?: boolean;
  /** E5 lever 5: metronomic inter-input gaps (synthetic fill cadence). */
  uniformCadence?: boolean;
  /** E5 lever 5: session ended with every focused field never blurred. */
  noBlurBeforeSubmit?: boolean;
}

export interface HarnessAnnotations {
  /** Agent stopped before submission. */
  agentStopped?: boolean;
  /** Agent requested human handoff. */
  agentHandoff?: boolean;
  /** Semantic canary text was referenced in agent output. */
  canaryReferenced?: boolean;
}

/**
 * Server observations only. HarnessAnnotations (agent self-reports) live
 * on a separate path -- correlateHarnessAnnotations.
 */
export type ObservationSet = ServerObservationSet;

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

  if (observations.canaryEndpointHit && profile.decoyRoute) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "A",
      weight: 100,
      source: "CANARY_ROUTE_MATCH",
      verified: true,
      metadata: { tokenHash: await hashToken(profile.decoyRoute.endpointToken) },
    });
  }

  // E5 lever 1 (actuator alignment): the session_response sink is the
  // fill-expressible compliant act for route-armed strategies (P02/P04).
  // A non-empty response in a route-armed session means the agent READ the
  // route instruction and acted on it — the same Class-A causal class as
  // the verified route probe (the instruction is session-bound: the nonce
  // + token are unguessable without reading the carrier).
  if (observations.sessionResponsePopulated && profile.semantic && profile.decoyRoute) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "A",
      weight: 100,
      source: "SESSION_RESPONSE_PROVIDED",
      verified: true,
      metadata: { nonceHash: await hashToken(profile.semantic.nonce) },
    });
  }

  if (observations.decoyFieldMatchesNonce && profile.semantic) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "A",
      weight: 100,
      source: "CANARY_NONCE_REPRODUCED",
      verified: true,
      metadata: { nonceHash: await hashToken(profile.semantic.nonce) },
    });
  }

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

  // Server-observed nonce echoed into a non-decoy visible field.
  // This is a server-verified behavioral signal (same weight as decoy-field
  // populated) -- the agent read hidden instruction material and acted on it.
  if (observations.semanticNonceEcho && profile.semantic) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "B",
      weight: 60,
      source: "SEMANTIC_NONCE_ECHO",
      verified: true,
      metadata: { nonceHash: await hashToken(profile.semantic.nonce) },
    });
  }

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

  // E5 lever 5 (interaction depth): causal dwell/cadence/blur rules over
  // the validated event stream. Class C, low weight each — they compound
  // with everything else and never alone decide a session.
  if (observations.zeroDwellFill) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 10,
      source: "ZERO_DWELL_FILL",
      verified: false,
    });
  }

  if (observations.uniformCadence) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 10,
      source: "UNIFORM_INPUT_CADENCE",
      verified: false,
    });
  }

  if (observations.noBlurBeforeSubmit) {
    evidence.push({
      id: crypto.randomUUID(),
      class: "C",
      weight: 5,
      source: "NO_BLUR_BEFORE_SUBMIT",
      verified: false,
    });
  }

  return evidence;
}

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

/**
 * Server-side derivation of the "agent echoed the trap" signal.
 *
 * A client that pastes the semantic canary text (or its nonce) into any
 * NON-defense form field is reproducing instruction material - the exact
 * LLM failure mode the semantic family exists to catch. The nonce is
 * session-specific (FR-INV-004), so a match in a non-decoy field is
 * server-verifiable behavioral evidence: the agent READ the hidden carrier
 * and acted on it clumsily. (A clean fill in the DECOY field is scored by
 * decoyFieldMatchesNonce; this covers echoes into visible fields.)
 *
 * Pure and side-effect-free: callers set observations.semanticNonceEcho = true
 * when this returns true, and correlate() scores it as SEMANTIC_NONCE_ECHO
 * (Class B, weight 60, verified). Never matches the DECOY field itself (that
 * path has its own, stronger evidence) and never matches empty values.
 */
export function deriveCanaryReference(
  profile: DefenseProfile,
  form: Record<string, string>
): boolean {
  if (!profile.semantic) return false;
  const nonce = profile.semantic.nonce;
  if (!nonce) return false;
  const decoyField = profile.decoyField?.fieldName;
  for (const [name, value] of Object.entries(form)) {
    if (!value) continue;
    if (decoyField && name === decoyField) continue;
    if (name === "csrf") continue;
    if (value.includes(nonce)) return true;
  }
  return false;
}
