/**
 * Telemetry aggregation — computes behavioral metrics from raw events.
 * FR-R2-010: interaction family must produce actual defense signals.
 *
 * Input: all telemetry events for a session.
 * Output: structured metrics fed into correlation.
 *
 * FR-R4-012: capture-aware metrics (noPointerEvents/noKeyEvents can be
 *   undefined when capture was off => unknown).
 * FR-R4-013: per-field focus tracking replaces global hasFocus.
 * FR-R4-014: completionMs measures from first meaningful interaction.
 */
import type { ValidatedEvent } from "./validate.js";

export interface CaptureConfig {
  capturePointer?: boolean;
  captureKey?: boolean;
}

export interface TelemetryMetrics {
  directFill: boolean;
  completionMs: number;
  pageToSubmitMs: number;
  pointerCount: number;
  focusTransitions: number;
  keyCount: number;
  /**
   * FR-R4-012: undefined when capture was off (unknown),
   * true/false when both channels were captured.
   */
  missingInteractionSequence: boolean | undefined;
  /**
   * FR-R4-012: undefined when capture was off (unknown), true if captured
   * and no pointer events, false if captured and pointer events exist.
   */
  noPointerEvents?: boolean;
  /**
   * FR-R4-012: undefined when capture was off (unknown), true if captured
   * and no key events, false if captured and key events exist.
   */
  noKeyEvents?: boolean;
  /**
   * FR-R4-012: whether pointer capture was on for this session.
   */
  capturePointer: boolean;
  /**
   * FR-R4-012: whether key capture was on for this session.
   */
  captureKey: boolean;
  /**
   * E5 lever 5 (interaction depth) — zero-dwell fill: an input event on a
   * target whose focus event arrived within MIN_FIELD_DWELL_MS (or with no
   * focus event at all, which directFill already covers). Humans cannot
   * focus a field and type meaningfully faster than a tab/alt-tab; agents
   * fire fill() which focuses-and-types in one synthetic beat.
   * undefined when no input events (nothing to score).
   */
  zeroDwellFill?: boolean;
  /**
   * E5 lever 5 — uniform inter-input cadence: ≥3 input events whose gaps
   * are all within UNIFORM_CADENCE_TOLERANCE of each other (coefficient of
   * uniformity). Humans produce irregular, bursty cadence; synthetic
   * fill loops are near-constant. undefined under 3 inputs.
   */
  uniformCadence?: boolean;
  /**
   * E5 lever 5 — submitted without any blur: every focus stayed focused
   * until submit (humans blur fields by tabbing/clicking to the next one).
   * undefined when no focus events were captured.
   */
  noBlurBeforeSubmit?: boolean;
}

const MEANINGFUL_KINDS = new Set([
  "focus",
  "pointer",
  "key",
  "input",
  "change",
]);

/**
 * Aggregate raw telemetry events into behavioral metrics.
 *
 * FR-R4-013 — per-field focus tracking:
 *   Focus events add target to a focused-targets Set; blur events remove
 *   the target.  Input is "without-focus" when the event target is not in
 *   that Set (or if no events have a target, the Set is empty).  directFill
 *   is true when at least one such input occurred — the presence of any
 *   focus/blur transitions no longer affects the calculation (a session that
 *   had a real focus but later received programmatic input into an unfocused
 *   field is still directFill).
 *
 * FR-R4-014 — completion time:
 *   completionMs = time from first *meaningful* interaction (focus/pointer/
 *   key/input/change) to submit_attempt.  pageToSubmitMs = time from the
 *   very first event to submit_attempt.
 *
 * FR-R4-012 — capture awareness:
 *   noPointerEvents and noKeyEvents are undefined when capture was off
 *   (unknown), otherwise boolean based on actual counts.  missingInteractionSequence
 *   is true only when both capture channels were on AND both saw no events.
 */
import { emptyState } from "./state.js";

export { emptyState };

export function aggregateTelemetry(
  events: ValidatedEvent[],
  capture?: CaptureConfig
): TelemetryMetrics {
  const cfg = capture ?? { capturePointer: true, captureKey: true };
  const capturePointer = cfg.capturePointer ?? true;
  const captureKey = cfg.captureKey ?? true;

  if (events.length === 0) {
    // FR-R4-012: respect capture config even for empty event sets
    const missingInteractionSequence =
      capturePointer && captureKey ? true : undefined;
    return {
      directFill: false,
      completionMs: 0,
      pageToSubmitMs: 0,
      pointerCount: 0,
      focusTransitions: 0,
      keyCount: 0,
      missingInteractionSequence,
      noPointerEvents: capturePointer ? true : undefined,
      noKeyEvents: captureKey ? true : undefined,
      capturePointer,
      captureKey,
      // E5 lever 5: no input events → undefined (nothing to score).
      zeroDwellFill: undefined,
      uniformCadence: undefined,
      noBlurBeforeSubmit: undefined,
    };
  }

  // Sort by sequence number to ensure chronological order
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  const focusedTargets = new Set<string>();
  let pointerCount = 0;
  let focusTransitions = 0;
  let keyCount = 0;
  let inputWithoutFocus = 0;
  let firstMeaningfulDt: number | undefined;
  let submitDt: number | undefined;

  // FR-R4-014: pageToSubmitMs uses the very first event dt
  const firstEventDt = sorted[0].dt;
  const lastEventDt = sorted[sorted.length - 1].dt;

  for (const e of sorted) {
    // FR-R4-014: first meaningful interaction (not page_ready, not turnstile)
    if (
      firstMeaningfulDt === undefined &&
      MEANINGFUL_KINDS.has(e.kind)
    ) {
      firstMeaningfulDt = e.dt;
    }

    switch (e.kind) {
      case "pointer":
        pointerCount++;
        break;
      case "focus":
        focusTransitions++;
        // FR-R4-013: add target to focused set (ignore if no target)
        if (e.target) {
          focusedTargets.add(e.target);
        }
        break;
      case "blur":
        // FR-R4-013: remove target from focused set
        if (e.target) {
          focusedTargets.delete(e.target);
        }
        break;
      case "key":
        keyCount++;
        break;
      case "input":
        // FR-R4-013: input without focus means target not in focused set
        // If focusedTargets is empty and this input has no target, it counts
        if (
          e.target
            ? !focusedTargets.has(e.target)
            : focusedTargets.size === 0
        ) {
          inputWithoutFocus++;
        }
        break;
      case "submit_attempt":
        submitDt = e.dt;
        break;
    }
  }

  // FR-R4-013: directFill = any input without focus occurred
  const directFill = inputWithoutFocus > 0;

  // FR-R4-014: completionMs from first meaningful interaction
  const completionMs =
    submitDt !== undefined && firstMeaningfulDt !== undefined
      ? Math.max(0, submitDt - firstMeaningfulDt)
      : 0;

  // FR-R4-014: pageToSubmitMs from first event
  const pageToSubmitMs = submitDt !== undefined
    ? Math.max(0, submitDt - firstEventDt)
    : lastEventDt - firstEventDt;

  // FR-R4-012: capture-aware pointer/ key metrics
  const noPointerEvents = capturePointer
    ? pointerCount === 0
    : undefined;

  const noKeyEvents = captureKey ? keyCount === 0 : undefined;

  // FR-R4-012: missingInteractionSequence only true when BOTH channels
  // were captured and BOTH saw nothing
  const missingInteractionSequence =
    capturePointer && captureKey
      ? pointerCount === 0 && keyCount === 0
      : undefined;

  // ── E5 lever 5: causal interaction-depth signals ────────────────────────
  // All three are deterministic threshold rules over the same validated
  // event stream — no ML, no training data, replayable from the record.

  // Zero-dwell fill: per-target time from focus to first input.
  const MIN_FIELD_DWELL_MS = 120;
  let zeroDwellFill: boolean | undefined;
  {
    const focusDt = new Map<string, number>();
    let sawInput = false;
    let sawViolation = false;
    for (const e of sorted) {
      if (e.kind === "focus" && e.target && !focusDt.has(e.target)) {
        focusDt.set(e.target, e.dt);
      } else if (e.kind === "input" && e.target) {
        sawInput = true;
        const fdt = focusDt.get(e.target);
        // Unfocused input is directFill's domain; zero-dwell scores
        // FOCUSED-then-instant fills only.
        if (fdt !== undefined && e.dt - fdt < MIN_FIELD_DWELL_MS) {
          sawViolation = true;
        }
      }
    }
    if (sawInput) zeroDwellFill = sawViolation;
  }

  // Uniform inter-input cadence: irregular human typing vs metronomic
  // synthetic fill loops. ≥3 inputs, all pairwise-consecutive gaps within
  // a 4× band of each other.
  const UNIFORM_CADENCE_MIN_INPUTS = 3;
  const UNIFORM_CADENCE_BAND = 4;
  let uniformCadence: boolean | undefined;
  {
    const inputDts = sorted.filter((e) => e.kind === "input").map((e) => e.dt);
    if (inputDts.length >= UNIFORM_CADENCE_MIN_INPUTS) {
      const gaps: number[] = [];
      for (let i = 1; i < inputDts.length; i++) {
        gaps.push(Math.max(1, inputDts[i] - inputDts[i - 1]));
      }
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      uniformCadence = max <= min * UNIFORM_CADENCE_BAND;
    }
  }

  // No blur before submit: humans leave fields behind (tab/click forward);
  // programmatic form-fills never blur anything.
  let noBlurBeforeSubmit: boolean | undefined;
  {
    const blurCount = sorted.filter((e) => e.kind === "blur").length;
    if (focusTransitions > 0) noBlurBeforeSubmit = blurCount === 0;
  }

  return {
    directFill,
    completionMs,
    pageToSubmitMs,
    pointerCount,
    focusTransitions,
    keyCount,
    missingInteractionSequence,
    noPointerEvents,
    noKeyEvents,
    capturePointer,
    captureKey,
    zeroDwellFill,
    uniformCadence,
    noBlurBeforeSubmit,
  };
}
