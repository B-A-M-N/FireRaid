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
 * FR-P0-1: fold a freshly-validated batch into the session's persisted
 * aggregation state (load → advance → save). The state machine lives in
 * state.ts; this wrapper is what routes call. Batches must be watermark-
 * gated before reaching here (the caller enforces seq order).
 *
 * Lab mode does NOT call this — research needs the raw batch rows intact,
 * and aggregateSessionTelemetry remains the lab-authoritative path.
 */
export async function mergeSessionMetrics(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[],
  capture: CaptureConfig
): Promise<void> {
  // P1-AUDIT-2 (P0-6): the fold owner owns the CAS loop; this wrapper keeps
  // the route-facing signature.
  const { foldNewEvents } = await import("./state.js");
  await foldNewEvents(db, sessionId, events, capture);
}

/**
 * FR-P1-28: one-load fold. Loads the incremental state ONCE, resolves the
 * capture mask from the stored state when present (skipping profile
 * reconstruction entirely) or from the passed mask when absent (first
 * batch), advances, and saves. Returns the mask so a caller that also
 * needs it doesn't issue a second load.
 *
 * The route-level resolveCaptureMask() per batch was a hidden per-flush
 * cost: reconstruction + a D1 read on every flush, when only the FIRST
 * flush needs the real mask (the state row persists it thereafter).
 */
export async function foldSessionMetrics(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[],
  initialCapture: CaptureConfig
): Promise<CaptureConfig> {
  // P1-AUDIT-2 (P0-6): same CAS owner. The mask is resolved from the stored
  // state when a row exists (no reconstruction needed) — read AFTER the fold
  // so the answer reflects whichever writer won the race.
  const { foldNewEvents, loadMetricsState } = await import("./state.js");
  await foldNewEvents(db, sessionId, events, initialCapture);
  const state = await loadMetricsState(db, sessionId);
  if (state) {
    return { capturePointer: state.capturePointer, captureKey: state.captureKey };
  }
  return initialCapture;
}

/**
 * FR-R7-022 / FR-P0-1: read the compact metrics for a session. Prefers the
 * persisted incremental state (projects it via toMetrics); falls back to a
 * full raw aggregation when the state row is absent (lab sessions, or
 * production sessions whose first batch is only now arriving).
 *
 * P1-AUDIT-2: before returning, the state is RECONCILED against the session's
 * authoritative watermark (sessions.last_event_seq) via catchUpSessionMetrics
 * (the CAS owner). The result is an INTEGRITY result, not a bare metric:
 *  - { status: "complete", metrics }  — the compact row provably covers the
 *    whole accepted stream; safe to use as behavioral evidence.
 *  - { status: "incomplete", ... }    — the metrics watermark is BEHIND the
 *    session watermark and the missing raw rows are GONE (pruned or never
 *    stored). The server KNOWS the window is truncated; the caller must NOT
 *    convert known-incomplete data into behavioral evidence (P0-7 — the
 *    prior behavior returned the stale metrics, approving partial windows).
 *  - { status: "absent" }             — no state row and no raw rows at all
 *    (a session that never interacted): complete-by-vacuity, metrics null.
 */
export interface SessionMetricsRead {
  status: "complete" | "incomplete" | "absent";
  metrics: TelemetryMetrics | null;
  expectedThrough?: number;
  actualThrough?: number;
}

export async function loadSessionMetrics(
  db: D1Database,
  sessionId: string
): Promise<SessionMetricsRead> {
  const { loadMetricsState, toMetrics, catchUpSessionMetrics } = await import("./state.js");

  // Reconcile FIRST (CAS fold of any persisted-but-unfolded raw suffix), so
  // the compact row never silently lags the accepted stream.
  await catchUpSessionMetrics(db, sessionId);

  const state = await loadMetricsState(db, sessionId);
  const sessionWm = await readSessionWatermark(db, sessionId);

  if (!state) {
    // No compact row: either no events at all (complete-by-vacuity) or the
    // raw rows exist but no fold ever ran. Catch-up would have created the
    // row from raw rows, so absence here means genuinely nothing to fold —
    // EXCEPT lab mode, where catch-up is not called and raw aggregation is
    // the caller's path (this function is production-only in practice).
    if (sessionWm !== null && sessionWm >= 0) {
      // The session DID accept events but has no compact row and no way to
      // rebuild it here — treat as incomplete, not silent-zero.
      return { status: "incomplete", metrics: null, expectedThrough: sessionWm, actualThrough: -1 };
    }
    return { status: "absent", metrics: null };
  }

  if (sessionWm !== null && state.lastSeq < sessionWm) {
    // Catch-up ran and could not close the gap: the missing raw rows are
    // unrecoverable. Known-incomplete — the caller must not score it.
    return {
      status: "incomplete",
      metrics: toMetrics(state),
      expectedThrough: sessionWm,
      actualThrough: state.lastSeq,
    };
  }

  return { status: "complete", metrics: toMetrics(state) };
}

/** sessions.last_event_seq (COALESCE NULL → -1), or null when no row. */
async function readSessionWatermark(
  db: D1Database,
  sessionId: string
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT COALESCE(last_event_seq, -1) AS wm FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ wm: number }>();
  return row?.wm ?? null;
}

