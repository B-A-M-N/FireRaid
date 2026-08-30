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

export interface DecoyConfig {
  fieldName: string;
  endpointToken: string;
  elementId: string;
}

export interface DefenseProfile {
  version: number;
  profileId: string;
  /** Variant ID for grouping experimental treatments (FR-R3-049). */
  profileVariantId?: string;
  sessionId: string;
  families: DefenseFamilyName[];
  semantic?: SemanticConfig;
  /** Aggregate decoy config (field + route together). */
  decoy?: DecoyConfig;
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
