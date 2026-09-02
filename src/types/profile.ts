/**
 * FR-INV-002: Defense profiles MUST be deterministic from server-controlled state.
 * Canonical DefenseProfile — the central FireRaid primitive.
 * FIX: Split decoy-field/decoy-route into independent families (FR-R3-010).
 * FIX: Interaction family now has scoringEnabled flag (FR-R3-011).
 */
export type DefenseFamilyName =
  | "semantic"
  | "decoy-field"
  | "decoy-route"
  | "interaction";

export type SemanticMode = "observe" | "handoff" | "decoy";

export interface SemanticConfig {
  templateId: string;
  placementId: string;
  nonce: string;
  mode: SemanticMode;
  /**
   * Multi-spot injection (defense-in-depth widening): how many hidden
   * carriers the semantic trap renders into, and WHICH seed-chosen anchors
   * (from core/artifacts.ts SPOT_ANCHORS). Drawn per session from the
   * profile PRF — deterministic once issued, unpredictable to an attacker
   * without the secret. Empty for visible placements (P01–P05 are
   * single-carrier placement experiments); populated for non-rendered
   * placements (P06), which is the production plane.
   */
  spotCount: number;
  spots: string[];
  /**
   * Rereview item 27: deterministic intra-strategy presentation variant —
   * which reviewed static fragments composed this session's instruction
   * text (sentence set, ordering, code-reference style). Semantics are
   * FIXED per strategy; only reviewed-surface composition varies. Drawn
   * from its own PRF domain ("semantic-form"), reconstruction-stable.
   */
  formVariant: number;
}

export interface DecoyFieldConfig {
  fieldName: string;
  elementId: string;
}

export interface DecoyRouteConfig {
  endpointToken: string;
}

export interface TelemetryConfig {
  captureFocus: boolean;
  captureInput: boolean;
  captureChange: boolean;
  capturePointer: boolean;
  captureKey: boolean;
  captureSubmit: boolean;
}

export interface DefenseProfile {
  version: number;
  profileId: string;
  /** Variant ID for grouping experimental treatments (FR-R3-049). */
  profileVariantId?: string;
  sessionId: string;
  families: DefenseFamilyName[];
  semantic?: SemanticConfig;
  // FR-R6-027/049: the aggregate `decoy` object was removed — decoy-field and
  // decoy-route are independent families and must be read independently so the
  // ablations stay isolated (DECOY_FIELD_ONLY renders no route token,
  // DECOY_ROUTE_ONLY renders no field).
  decoyField?: DecoyFieldConfig;
  decoyRoute?: DecoyRouteConfig;
  interaction?: {
    scoringEnabled: boolean;
  };
  telemetry: TelemetryConfig;
  scoringPolicy: string;
}

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_COOKIE = "__Host-fr_sid";
export const CSRF_COOKIE = "__Host-fr_csrf";
