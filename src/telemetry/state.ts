/**
 * FR-P0-1: incremental telemetry aggregation state machine.
 *
 * aggregateTelemetry() computes metrics from a FULL event list. Production
 * sessions deliver events across many batches, so the server must fold
 * incrementally: SessionMetricsState is the running state, advance() folds
 * one batch into it, and toMetrics() projects it into the same TelemetryMetrics
 * shape aggregateTelemetry would have produced over the concatenation.
 *
 * Correctness contract (enforced by tests/unit/session-metrics-parity.test.ts):
 * for any partition of an event stream into batches (applied in order),
 * fold(advance(state_i, batch_i)) produces metrics identical to
 * aggregateTelemetry(concat(batches), capture).
 *
 * The 0010-era mergeSessionMetrics failed this contract: it aggregated each
 * batch IN ISOLATION and combined per-batch aggregates with OR/MAX/sum, which
 * loses cross-batch focus state, can never clear no_pointer_events, and never
 * revises completion_ms once written.
 */
import type { ValidatedEvent } from "./validate.js";
import type { CaptureConfig, TelemetryMetrics } from "./aggregate.js";

/** Event kinds that count as "meaningful" for completionMs (mirrors aggregate.ts). */
const MEANINGFUL_KINDS = new Set(["focus", "pointer", "key", "input", "change"]);

/** Mutable running state — exactly the variables aggregateTelemetry closes over. */
export interface SessionMetricsState {
  focusedTargets: string[];
  pointerCount: number;
  focusTransitions: number;
  keyCount: number;
  inputWithoutFocus: number;
  firstEventDt: number | null;
  firstMeaningfulDt: number | null;
  submitDt: number | null;
  lastEventDt: number | null;
  capturePointer: boolean;
  captureKey: boolean;
  /** Highest seq folded in (watermark for idempotent resume). */
  lastSeq: number;
}

export function emptyState(capture: CaptureConfig): SessionMetricsState {
  return {
    focusedTargets: [],
    pointerCount: 0,
    focusTransitions: 0,
    keyCount: 0,
    inputWithoutFocus: 0,
    firstEventDt: null,
    firstMeaningfulDt: null,
    submitDt: null,
    lastEventDt: null,
    capturePointer: capture.capturePointer ?? true,
    captureKey: capture.captureKey ?? true,
    lastSeq: -1,
  };
}

/**
 * Fold one event into the state. Events MUST arrive in nondecreasing seq
 * order (the caller applies the watermark gate before calling).
 * Semantics mirror aggregateTelemetry's loop body exactly.
 */
function foldEvent(state: SessionMetricsState, e: ValidatedEvent): void {
  if (state.firstEventDt === null) state.firstEventDt = e.dt;
  state.lastEventDt = e.dt;

  if (state.firstMeaningfulDt === null && MEANINGFUL_KINDS.has(e.kind)) {
    state.firstMeaningfulDt = e.dt;
  }

  switch (e.kind) {
    case "pointer":
      state.pointerCount++;
      break;
    case "focus":
      state.focusTransitions++;
      if (e.target) state.focusedTargets.push(e.target);
      break;
    case "blur":
      // Remove the LAST occurrence (mirrors Set.delete — one removal per blur).
      {
        const idx = state.focusedTargets.lastIndexOf(e.target ?? "");
        if (e.target && idx !== -1) state.focusedTargets.splice(idx, 1);
      }
      break;
    case "key":
      state.keyCount++;
      break;
    case "input": {
      const withoutFocus = e.target
        ? !state.focusedTargets.includes(e.target)
        : state.focusedTargets.length === 0;
      if (withoutFocus) state.inputWithoutFocus++;
      break;
    }
    case "submit_attempt":
      // Last submit wins (aggregate.ts assigns submitDt in loop order too).
      state.submitDt = e.dt;
      break;
  }
  state.lastSeq = e.seq;
}

/**
 * Fold a batch of events (in array order) into the state.
 * Returns the same mutated state for chaining.
 */
export function advance(
  state: SessionMetricsState,
  events: ValidatedEvent[]
): SessionMetricsState {
  for (const e of events) foldEvent(state, e);
  return state;
}

/**
 * Project the running state into the TelemetryMetrics shape.
 * Derivations mirror aggregateTelemetry's post-loop math.
 */
export function toMetrics(state: SessionMetricsState): TelemetryMetrics {
  const sawAnyEvent = state.firstEventDt !== null;

  const directFill = state.inputWithoutFocus > 0;

  const completionMs =
    state.submitDt !== null && state.firstMeaningfulDt !== null
      ? Math.max(0, state.submitDt - state.firstMeaningfulDt)
      : 0;

  const pageToSubmitMs = state.submitDt !== null
    ? Math.max(0, state.submitDt - (state.firstEventDt ?? state.submitDt))
    : sawAnyEvent
      ? Math.max(0, (state.lastEventDt ?? 0) - (state.firstEventDt ?? 0))
      : 0;

  const noPointerEvents = state.capturePointer
    ? state.pointerCount === 0
    : undefined;
  const noKeyEvents = state.captureKey ? state.keyCount === 0 : undefined;
  const missingInteractionSequence =
    state.capturePointer && state.captureKey
      ? state.pointerCount === 0 && state.keyCount === 0
      : undefined;

  return {
    directFill,
    completionMs,
    pageToSubmitMs,
    pointerCount: state.pointerCount,
    focusTransitions: state.focusTransitions,
    keyCount: state.keyCount,
    missingInteractionSequence,
    noPointerEvents,
    noKeyEvents,
    capturePointer: state.capturePointer,
    captureKey: state.captureKey,
  };
}

