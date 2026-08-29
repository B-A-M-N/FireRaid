/**
 * FR-INV-002: Defense profiles MUST be deterministic from server-controlled state.
 * Canonical DefenseProfile — the central FireRaid primitive.
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

export interface DecoyConfig {
  fieldName: string;
  endpointToken: string;
  elementId: string;
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
  sessionId: string;
  families: DefenseFamilyName[];
  semantic?: SemanticConfig;
  decoy?: DecoyConfig;
  telemetry: TelemetryConfig;
  scoringPolicy: string;
}

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_COOKIE = "__Host-fr_sid";
export const CSRF_COOKIE = "__Host-fr_csrf";
