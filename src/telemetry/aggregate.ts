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
import type { ValidatedEvent } from "../routes/telemetry.js";

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
  };
}

/**
 * Retrieve all telemetry events for a session from D1 and aggregate.
 * Used at submission time to build server observations.
 * FR-R4-012: passes capture config from profile.
 */
export async function aggregateSessionTelemetry(
  db: D1Database,
  sessionId: string,
  capture?: CaptureConfig
): Promise<TelemetryMetrics> {
  const rows = await db.prepare(
    `SELECT payload_json FROM event_batches WHERE session_id = ? ORDER BY first_seq`
  ).bind(sessionId).all<{ payload_json: string }>();

  const allEvents: ValidatedEvent[] = [];
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.payload_json) as ValidatedEvent[];
      allEvents.push(...parsed);
    } catch {
      // Skip malformed batch
    }
  }

  return aggregateTelemetry(allEvents, capture);
}

/**
 * FR-R7-022: compact server-side interaction state.
 *
 * Merge a freshly-validated batch into the session's metrics row in one
 * transactional UPSERT. The aggregate is computed against (existing-events
 * for the range not yet seen ∪ new batch), but in practice a session sees
 * batches in seq order (the watermark gate enforces this) — so we can
 * recompute incrementally: counts grow monotonically, while booleans
 * (directFill, noPointerEvents, noKeyEvents) take the OR of the per-batch
 * results and the cumulative state.
 *
 * Lab mode does NOT call this — research needs the raw batch rows intact,
 * and the existing aggregateSessionTelemetry path remains authoritative.
 */
export async function mergeSessionMetrics(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[],
  capture: CaptureConfig
): Promise<void> {
  if (events.length === 0) return;
  // Aggregate this batch alone — combine with the stored row via OR /
  // additive arithmetic in the SQL UPDATE below.
  const batch = aggregateTelemetry(events, capture);
  const firstSeq = events[0].seq;
  const lastSeq = events[events.length - 1].seq;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO session_metrics (
         session_id, direct_fill, completion_ms, page_to_submit_ms,
         pointer_count, focus_transitions, key_count,
         missing_interaction_sequence, no_pointer_events, no_key_events,
         capture_pointer, capture_key,
         first_event_seq, last_event_seq, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         direct_fill = MAX(direct_fill, excluded.direct_fill),
         pointer_count = pointer_count + excluded.pointer_count,
         focus_transitions = focus_transitions + excluded.focus_transitions,
         key_count = key_count + excluded.key_count,
         no_pointer_events = CASE
           WHEN excluded.no_pointer_events IS NULL THEN no_pointer_events
           WHEN no_pointer_events IS NULL THEN excluded.no_pointer_events
           ELSE MAX(no_pointer_events, excluded.no_pointer_events)
         END,
         no_key_events = CASE
           WHEN excluded.no_key_events IS NULL THEN no_key_events
           WHEN no_key_events IS NULL THEN excluded.no_key_events
           ELSE MAX(no_key_events, excluded.no_key_events)
         END,
         missing_interaction_sequence = CASE
           WHEN excluded.missing_interaction_sequence IS NULL THEN missing_interaction_sequence
           WHEN missing_interaction_sequence IS NULL THEN excluded.missing_interaction_sequence
           ELSE MAX(missing_interaction_sequence, excluded.missing_interaction_sequence)
         END,
         first_event_seq = MIN(first_event_seq, excluded.first_event_seq),
         last_event_seq  = MAX(last_event_seq,  excluded.last_event_seq),
         updated_at = excluded.updated_at`
    )
    .bind(
      sessionId,
      batch.directFill ? 1 : 0,
      batch.completionMs,
      batch.pageToSubmitMs,
      batch.pointerCount,
      batch.focusTransitions,
      batch.keyCount,
      batch.missingInteractionSequence === undefined ? null : (batch.missingInteractionSequence ? 1 : 0),
      batch.noPointerEvents === undefined ? null : (batch.noPointerEvents ? 1 : 0),
      batch.noKeyEvents === undefined ? null : (batch.noKeyEvents ? 1 : 0),
      batch.capturePointer ? 1 : 0,
      batch.captureKey ? 1 : 0,
      firstSeq,
      lastSeq,
      now
    )
    .run();
}

/**
 * FR-R7-022: read the compact metrics row for a session, if present. When
 * the row is absent (lab-only run, or production session that never sent a
 * batch), returns null so callers can fall back to aggregateSessionTelemetry.
 */
export async function loadSessionMetrics(
  db: D1Database,
  sessionId: string
): Promise<TelemetryMetrics | null> {
  const row = await db
    .prepare(
      `SELECT direct_fill, completion_ms, page_to_submit_ms,
              pointer_count, focus_transitions, key_count,
              missing_interaction_sequence, no_pointer_events, no_key_events,
              capture_pointer, capture_key
         FROM session_metrics WHERE session_id = ?`
    )
    .bind(sessionId)
    .first<{
      direct_fill: number;
      completion_ms: number;
      page_to_submit_ms: number;
      pointer_count: number;
      focus_transitions: number;
      key_count: number;
      missing_interaction_sequence: number | null;
      no_pointer_events: number | null;
      no_key_events: number | null;
      capture_pointer: number;
      capture_key: number;
    }>();
  if (!row) return null;
  return {
    directFill: row.direct_fill === 1,
    completionMs: row.completion_ms,
    pageToSubmitMs: row.page_to_submit_ms,
    pointerCount: row.pointer_count,
    focusTransitions: row.focus_transitions,
    keyCount: row.key_count,
    missingInteractionSequence:
      row.missing_interaction_sequence === null ? undefined : row.missing_interaction_sequence === 1,
    noPointerEvents:
      row.no_pointer_events === null ? undefined : row.no_pointer_events === 1,
    noKeyEvents:
      row.no_key_events === null ? undefined : row.no_key_events === 1,
    capturePointer: row.capture_pointer === 1,
    captureKey: row.capture_key === 1,
  };
}
