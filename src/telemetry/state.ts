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
import type { ValidatedEvent } from "../routes/telemetry.js";
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

// ---------------------------------------------------------------------------
// D1 persistence — one row per session holding the serialized state.
// ---------------------------------------------------------------------------

/**
 * Load the persisted state for a session, or null when absent.
 * The capture flags come back with the row so callers can detect a
 * mismatch with the profile they're about to fold under.
 */
export async function loadMetricsState(
  db: D1Database,
  sessionId: string
): Promise<SessionMetricsState | null> {
  const row = await db
    .prepare(
      `SELECT focused_targets_json, pointer_count, focus_transitions, key_count,
              input_without_focus, first_event_dt, first_meaningful_dt,
              submit_dt, last_event_dt, capture_pointer, capture_key, last_event_seq
         FROM session_metrics WHERE session_id = ?`
    )
    .bind(sessionId)
    .first<{
      focused_targets_json: string;
      pointer_count: number;
      focus_transitions: number;
      key_count: number;
      input_without_focus: number;
      first_event_dt: number | null;
      first_meaningful_dt: number | null;
      submit_dt: number | null;
      last_event_dt: number | null;
      capture_pointer: number;
      capture_key: number;
      last_event_seq: number;
    }>();
  if (!row) return null;
  let focused: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.focused_targets_json);
    if (Array.isArray(parsed)) focused = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // Corrupt row — start folding from empty focus state rather than crash.
    focused = [];
  }
  return {
    focusedTargets: focused,
    pointerCount: row.pointer_count,
    focusTransitions: row.focus_transitions,
    keyCount: row.key_count,
    inputWithoutFocus: row.input_without_focus,
    firstEventDt: row.first_event_dt,
    firstMeaningfulDt: row.first_meaningful_dt,
    submitDt: row.submit_dt,
    lastEventDt: row.last_event_dt,
    capturePointer: row.capture_pointer === 1,
    captureKey: row.capture_key === 1,
    lastSeq: row.last_event_seq,
  };
}

/**
 * Persist the state, WATERMARK-GUARDED. The prior implementation was an
 * unconditional `ON CONFLICT DO UPDATE` that could let an older state
 * overwrite a newer one (a lost race, or a replayed batch re-folding under
 * stale capture flags). P1-AUDIT-2: the write is now a two-statement batch —
 *  1. INSERT OR IGNORE  → the first writer owns the fresh row;
 *  2. UPDATE ... WHERE last_event_seq = ?base  → CAS on the watermark the
 *     fold STARTED from (null base = INSERT won = row is ours).
 *
 * Why CAS on the exact base rather than a forward-only `last_seq < ?` guard:
 * two writers folding DISJOINT suffixes from the same base state would both
 * pass a forward-only check, and the higher watermark would win while
 * permanently burying the loser's events (the compact row would claim a
 * watermark covering events it never folded). CAS makes the second writer
 * retry from the winner's state, so the compact row always equals the full
 * raw aggregation — the property
 * tests/unit/telemetry-cas-fold.test.ts proves under real concurrency.
 *
 * Returns "applied" when the write landed, "conflict" when another writer
 * advanced the watermark first — callers fold-own the retry (foldNewEvents
 * / catchUpSessionMetrics); this primitive never retries itself.
 */
export async function saveMetricsState(
  db: D1Database,
  sessionId: string,
  state: SessionMetricsState,
  /** last_event_seq the caller LOADED before folding; null = row absent then. */
  baseSeq: number | null
): Promise<"applied" | "conflict"> {
  // All folded fields, mirroring the stored row.
  const values = [
    sessionId,
    JSON.stringify(state.focusedTargets),
    state.pointerCount,
    state.focusTransitions,
    state.keyCount,
    state.inputWithoutFocus,
    state.firstEventDt,
    state.firstMeaningfulDt,
    state.submitDt,
    state.lastEventDt,
    state.capturePointer ? 1 : 0,
    state.captureKey ? 1 : 0,
    state.lastSeq,
    Date.now(),
    Date.now(),
  ];
  const now = values[13];

  if (baseSeq === null) {
    // The fold started from empty — the row must not exist yet. INSERT OR
    // IGNORE: if a concurrent writer created it first, we lost the race and
    // must NOT overwrite (our state lacks their folded prefix).
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO session_metrics (
           session_id, focused_targets_json, pointer_count, focus_transitions,
           key_count, input_without_focus, first_event_dt, first_meaningful_dt,
           submit_dt, last_event_dt, capture_pointer, capture_key,
           last_event_seq, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...values)
      .run();
    return (inserted.meta?.changes ?? 0) === 1 ? "applied" : "conflict";
  }

  // CAS: the stored watermark must still be exactly the one we folded on
  // top of. Statement-level atomicity (single D1 statement) makes this a
  // true compare-and-swap.
  const updated = await db
    .prepare(
      `UPDATE session_metrics SET
         focused_targets_json = ?,
         pointer_count = ?,
         focus_transitions = ?,
         key_count = ?,
         input_without_focus = ?,
         first_event_dt = ?,
         first_meaningful_dt = ?,
         submit_dt = ?,
         last_event_dt = ?,
         capture_pointer = ?,
         capture_key = ?,
         last_event_seq = ?,
         updated_at = ?
       WHERE session_id = ? AND last_event_seq = ?`
    )
    .bind(
      JSON.stringify(state.focusedTargets),
      state.pointerCount,
      state.focusTransitions,
      state.keyCount,
      state.inputWithoutFocus,
      state.firstEventDt,
      state.firstMeaningfulDt,
      state.submitDt,
      state.lastEventDt,
      state.capturePointer ? 1 : 0,
      state.captureKey ? 1 : 0,
      state.lastSeq,
      now,
      sessionId,
      baseSeq
    )
    .run();
  return (updated.meta?.changes ?? 0) === 1 ? "applied" : "conflict";
}

/** Retry budget for a fold under contention — each retry re-reads the
 * authoritative log on a strictly newer base, so it always converges.
 * 8 is generous: contention here is two flushes of one browser session. */
const FOLD_RETRIES = 8;

/**
 * P1-AUDIT-2 (P0-6): advance the compact metrics state through rawSeq,
 * folding the AUTHORITATIVE raw event log (event_batches) — never a
 * caller-supplied in-memory list.
 *
 * Why the log, not the request's events: two writers folding DISJOINT
 * suffixes from the same base (the audit's exact race) cannot be ordered by
 * CAS alone — the loser's retry would see the winner's HIGHER watermark and
 * skip its own lower events, permanently burying them while the watermarks
 * agree. Reading the suffix from the shared log makes every attempt (and
 * every retry) fold the same truth, so any interleaving converges to the
 * full aggregation.
 *
 * ONE owner of the load→fold→CAS loop. Routes must never assemble their own
 * load/save sequence; the CAS contract only holds when every writer goes
 * through here. Returns the persisted lastSeq.
 */
async function foldUpTo(
  db: D1Database,
  sessionId: string,
  targetSeq: number,
  captureForCreate: CaptureConfig | null
): Promise<number> {
  const { advance } = await import("./state.js");
  for (let attempt = 0; attempt <= FOLD_RETRIES; attempt++) {
    const base = await loadMetricsState(db, sessionId);
    // Skip ONLY when the compact row has reached the SESSION's authoritative
    // watermark — never merely the caller's target. A row can legitimately
    // carry a watermark HIGHER than a given caller's target (the audit's
    // disjoint-suffix race: writer B folded 11..20, writer A holds 1..10);
    // trusting target >= base there would bury A's half forever. The
    // session watermark is the accepted-stream truth both writers share.
    const wmRow = await db
      .prepare(`SELECT COALESCE(last_event_seq, -1) AS wm FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ wm: number }>();
    const sessionWm = wmRow?.wm ?? -1;
    if (base && base.lastSeq >= sessionWm && sessionWm >= targetSeq) {
      return base.lastSeq;
    }
    // No session row (lab replay, deleted parent): fall back to the
    // caller's target for the skip check.
    if (base && sessionWm < 0 && base.lastSeq >= targetSeq) {
      return base.lastSeq;
    }

    if (!base) {
      // No compact row. Rebuild from the log — but only when the caller can
      // supply the profile's capture mask (a fresh row PERSISTS the mask it
      // was created under; guessing true/true here could later score
      // capture-disabled channels as evidence). Without a mask, leave the
      // row absent — the read path reports the gap as incomplete (P0-7).
      if (!captureForCreate) return -1;
      const rows = await readRawBatchesAbove(db, sessionId, -1);
      if (rows.length === 0) return -1; // nothing recoverable from the log
      const fresh = emptyState(captureForCreate);
      for (const evs of rows) {
        advance(fresh, evs.filter((e) => e.seq > fresh.lastSeq));
      }
      const verdict = await saveMetricsState(db, sessionId, fresh, null);
      if (verdict === "applied") return fresh.lastSeq;
      continue; // lost the create race — fold on the winner's base
    }

    // CAS base: the watermark the fold STARTS from — captured BEFORE any
    // advance() mutates it. Passing the post-advance watermark here would
    // make the predicate `WHERE last_event_seq = <new>` match nothing (the
    // row still holds the base) and the fold would report a phantom
    // conflict forever.
    const baseSeq = base.lastSeq;
    // Fold the log's suffix above the base watermark. Events within a batch
    // at or below the base are skipped (partial-overlap batches).
    const rows = await readRawBatchesAbove(db, sessionId, baseSeq);
    if (rows.length === 0) return baseSeq; // log has nothing new
    for (const evs of rows) {
      advance(base, evs.filter((e) => e.seq > baseSeq));
    }
    const verdict = await saveMetricsState(db, sessionId, base, baseSeq);
    if (verdict === "applied") return base.lastSeq;
    // CAS lost — refold on the winner's base.
  }
  throw new Error(`session_metrics CAS fold did not converge (retries exhausted)`);
}

/**
 * Fold NEW events into the compact metrics state after an ingest. The
 * events argument is the never-stored suffix the caller just persisted —
 * it sets the fold TARGET; the fold source is always the raw log.
 */
export async function foldNewEvents(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[],
  initialCapture: CaptureConfig
): Promise<number> {
  if (events.length === 0) {
    return (await loadMetricsState(db, sessionId))?.lastSeq ?? -1;
  }
  return foldUpTo(db, sessionId, events[events.length - 1].seq, initialCapture);
}

/**
 * P1-AUDIT-2 (P0-7): reconcile the compact row against the session's
 * authoritative watermark (sessions.last_event_seq). Same CAS owner as the
 * ingest fold, so a concurrent flush and a reconciliation read can never
 * interleave.
 *
 * captureForCreate: the profile's capture mask, when the caller knows it —
 * required for the row-create path (see foldUpTo). Without it, an absent
 * row stays absent and the caller judges integrity.
 *
 * Returns the persisted lastSeq after reconciliation. lastSeq < session
 * watermark afterwards means the raw rows were pruned (known-incomplete).
 */
export async function catchUpSessionMetrics(
  db: D1Database,
  sessionId: string,
  captureForCreate?: CaptureConfig
): Promise<number> {
  const sessionWmRow = await db
    .prepare(`SELECT COALESCE(last_event_seq, -1) AS wm FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ wm: number }>();
  const sessionWm = sessionWmRow?.wm ?? null;
  if (sessionWm === null || sessionWm < 0) {
    // No accepted stream (or no session row) — nothing to reconcile.
    return (await loadMetricsState(db, sessionId))?.lastSeq ?? -1;
  }
  return foldUpTo(db, sessionId, sessionWm, captureForCreate ?? null);
}

/** Raw event_batches above a seq, oldest first, parsed. Malformed rows are
 * skipped (the rest of the suffix still replays). */
async function readRawBatchesAbove(
  db: D1Database,
  sessionId: string,
  aboveSeq: number
): Promise<ValidatedEvent[][]> {
  const rows = await db
    .prepare(
      `SELECT first_seq, payload_json FROM event_batches
        WHERE session_id = ? AND first_seq > ?
        ORDER BY first_seq`
    )
    .bind(sessionId, aboveSeq)
    .all<{ first_seq: number; payload_json: string }>();
  const out: ValidatedEvent[][] = [];
  for (const row of rows.results) {
    try {
      const events = JSON.parse(row.payload_json) as ValidatedEvent[];
      if (Array.isArray(events) && events.length > 0) out.push(events);
    } catch {
      // Skip a malformed batch; continue replaying the rest.
    }
  }
  return out;
}

