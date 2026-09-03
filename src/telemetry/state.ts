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

/** E5 lever 5: dwell floor + cadence band (mirrors aggregate.ts). */
const MIN_FIELD_DWELL_MS = 120;
const UNIFORM_CADENCE_MIN_INPUTS = 3;
const UNIFORM_CADENCE_BAND = 4;

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
  /** E5 lever 5: first-focus dt per target (zero-dwell scoring). */
  focusDtByTarget: Map<string, number>;
  /** E5 lever 5: any focused-then-instant input seen. */
  zeroDwellViolation: boolean;
  /** E5 lever 5: input event dts (uniform-cadence scoring). */
  inputDts: number[];
  /** E5 lever 5: blur count (no-blur-before-submit scoring). */
  blurCount: number;
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
    focusDtByTarget: new Map(),
    zeroDwellViolation: false,
    inputDts: [],
    blurCount: 0,
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
      if (e.target) {
        state.focusedTargets.push(e.target);
        // E5 lever 5: first focus wins per target (aggregate.ts uses
        // focusDt.set only when absent).
        if (!state.focusDtByTarget.has(e.target)) state.focusDtByTarget.set(e.target, e.dt);
      }
      break;
    case "blur":
      // Remove the LAST occurrence (mirrors Set.delete — one removal per blur).
      {
        const idx = state.focusedTargets.lastIndexOf(e.target ?? "");
        if (e.target && idx !== -1) state.focusedTargets.splice(idx, 1);
        state.blurCount++;
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
      // E5 lever 5: zero-dwell scoring (FOCUSED-then-instant only).
      state.inputDts.push(e.dt);
      if (e.target) {
        const fdt = state.focusDtByTarget.get(e.target);
        if (fdt !== undefined && e.dt - fdt < MIN_FIELD_DWELL_MS) {
          state.zeroDwellViolation = true;
        }
      }
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

  // ── E5 lever 5: project the incremental state through the same rules
  // aggregateTelemetry applies post-loop (parity contract).
  const zeroDwellFill = state.inputDts.length > 0 ? state.zeroDwellViolation : undefined;

  let uniformCadence: boolean | undefined;
  if (state.inputDts.length >= UNIFORM_CADENCE_MIN_INPUTS) {
    const gaps: number[] = [];
    for (let i = 1; i < state.inputDts.length; i++) {
      gaps.push(Math.max(1, state.inputDts[i] - state.inputDts[i - 1]));
    }
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    uniformCadence = max <= min * UNIFORM_CADENCE_BAND;
  }

  const noBlurBeforeSubmit =
    state.focusTransitions > 0 ? state.blurCount === 0 : undefined;

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
    zeroDwellFill,
    uniformCadence,
    noBlurBeforeSubmit,
  };
}

