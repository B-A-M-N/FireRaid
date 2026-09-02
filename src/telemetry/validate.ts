/**
 * Canonical telemetry-batch validation — the PRODUCT plane's home for it.
 *
 * P0 product-build split: this logic lived in src/routes/telemetry.ts (the
 * Worker route), which drags env.ts + cloudflare/session-envelope.ts into
 * any importer's dependency closure. The host middleware, the reference
 * telemetry adapter, and the Worker route all validate with the SAME
 * canonical function (P0-4 transport parity), so it belongs in the shared
 * telemetry module — pure, environment-free, no D1.
 *
 * The Worker route re-exports from here for back-compat.
 */
import {
  ALLOWED_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
} from "../types/telemetry.js";

/** Canonical validated telemetry event shape. */
export interface ValidatedEvent {
  seq: number;
  dt: number;
  kind: string;
  target?: string;
  meta?: {
    synthetic?: boolean;
    inputType?: string;
  };
}

export type ValidateResult =
  | { ok: true; events: ValidatedEvent[] }
  | {
      ok: false;
      code:
        | "TOO_MANY_EVENTS"
        | "NOT_AN_ARRAY"
        | "MALFORMED_EVENT"
        | "SEQ_ORDER_VIOLATION";
      detail?: string;
    };

/** UTF-8 byte length of a string (FR-R5-020). */
export function payloadByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a telemetry batch. Shared between /api/events and /api/submit.
 *
 * FR-R4-015: an array longer than MAX_EVENTS_PER_BATCH is rejected wholesale
 *   ({ok:false, code:"TOO_MANY_EVENTS"}) — never truncated silently.
 * FR-R6-034: seq/dt must be Number.isSafeInteger; dt nonnegative, seq >= 0.
 * FR-R6-035: a structurally bad event rejects the whole batch
 *   (MALFORMED_EVENT / SEQ_ORDER_VIOLATION) — the server never silently
 *   rewrites a malformed observation stream into a well-formed-looking one.
 */
export function validateTelemetryBatch(events: unknown): ValidateResult {
  if (!Array.isArray(events)) return { ok: false, code: "NOT_AN_ARRAY" };
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, code: "TOO_MANY_EVENTS" };
  }

  const valid: ValidatedEvent[] = [];
  let lastSeq = -1;
  let lastDt = -1;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, code: "MALFORMED_EVENT", detail: "event is not an object" };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== "string" || !ALLOWED_EVENT_TYPES.has(e.kind)) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `unknown kind: ${String(e.kind)}` };
    }
    // FR-R6-034: safe integers only — Number.isFinite allowed 1.5 through.
    if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 0) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `bad seq: ${String(e.seq)}` };
    }
    if (typeof e.dt !== "number" || !Number.isSafeInteger(e.dt) || e.dt < 0) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `bad dt: ${String(e.dt)}` };
    }
    // FR-R6-035: within-batch ordering must be strictly increasing by seq,
    // nondecreasing by dt — violations reject the WHOLE batch.
    if (e.seq <= lastSeq) {
      return { ok: false, code: "SEQ_ORDER_VIOLATION", detail: `seq ${e.seq} after ${lastSeq}` };
    }
    if (e.dt < lastDt) {
      return { ok: false, code: "SEQ_ORDER_VIOLATION", detail: `dt regressed at seq ${e.seq}` };
    }

    // Validate meta
    let meta: ValidatedEvent["meta"];
    if (e.meta !== undefined && e.meta !== null) {
      if (typeof e.meta !== "object") {
        return { ok: false, code: "MALFORMED_EVENT", detail: "meta is not an object" };
      }
      const metaObj = e.meta as Record<string, unknown>;
      meta = {};
      if (metaObj.synthetic !== undefined) {
        if (typeof metaObj.synthetic !== "boolean") {
          return { ok: false, code: "MALFORMED_EVENT", detail: "meta.synthetic not boolean" };
        }
        meta.synthetic = metaObj.synthetic;
      }
      if (metaObj.inputType !== undefined) {
        if (typeof metaObj.inputType !== "string" || metaObj.inputType.length > 32) {
          return { ok: false, code: "MALFORMED_EVENT", detail: "meta.inputType invalid" };
        }
        meta.inputType = metaObj.inputType;
      }
    }

    valid.push({
      seq: e.seq,
      dt: e.dt,
      kind: e.kind,
      target: typeof e.target === "string" ? e.target.slice(0, 128) : undefined,
      meta,
    });
    lastSeq = e.seq;
    lastDt = e.dt;
  }

  return { ok: true, events: valid };
}
