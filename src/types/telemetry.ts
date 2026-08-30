/**
 * Telemetry event schema (coarse sequencing only — FR-INV).
 */
export type TelemetryEventType =
  | "page_ready"
  | "focus"
  | "blur"
  | "input"
  | "change"
  | "pointer"
  | "key"
  | "submit_attempt"
  | "turnstile_ready"
  | "turnstile_success";

export interface TelemetryEvent {
  seq: number;
  dt: number;
  kind: TelemetryEventType;
  target?: string;
  meta?: {
    synthetic?: boolean;
    inputType?: string;
  };
}

export interface TelemetryBatch {
  events: TelemetryEvent[];
}

export const ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set<TelemetryEventType>([
  "page_ready",
  "focus",
  "blur",
  "input",
  "change",
  "pointer",
  "key",
  "submit_attempt",
  "turnstile_ready",
  "turnstile_success",
]);

// FR-R7-023: re-benchmarked against the byte budget. A heavy typist for
// 30s produces <100 events; the per-event envelope is ~80–150 bytes JSON,
// so 256 events comfortably fit under MAX_EVENT_PAYLOAD_BYTES (16 KiB).
// Raising the cap lets most real users finish in a single submit request
// instead of being forced through additional /api/events round-trips.
export const MAX_EVENTS_PER_BATCH = 256;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SUBMIT_BODY_BYTES = 32 * 1024;
