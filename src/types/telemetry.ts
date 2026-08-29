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

export const MAX_EVENTS_PER_BATCH = 64;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SUBMIT_BODY_BYTES = 32 * 1024;
