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
  | "turnstile_success"
  // FR-P0-5: the client emits these from turnstileOnError/turnstileOnExpired;
  // they were missing from the server schema, so the whole batch containing
  // one was rejected — server and client schemas must agree.
  | "turnstile_error"
  | "turnstile_expired";

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
  "turnstile_error",
  "turnstile_expired",
]);

// FR-R7-023 / FR-P0-5: the count cap alone does NOT bound payload size —
// 256 legal events with worst-case targets exceed 16 KiB. Clients must
// batch by BOTH count and encoded byte size (see fr-client-config, which
// surfaces both limits). The server keeps both checks.
export const MAX_EVENTS_PER_BATCH = 256;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const MAX_SUBMIT_BODY_BYTES = 32 * 1024;
