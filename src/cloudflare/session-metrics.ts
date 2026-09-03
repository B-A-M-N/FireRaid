/**
 * Worker-plane session-metrics persistence (D1).
 *
 * P0 product-build split: the pure aggregation state machine
 * (telemetry/state.ts) and the pure batch aggregator (telemetry/aggregate.ts)
 * are product modules — the host middleware scores through them with no
 * database. Everything that touches D1 lives HERE, on the Cloudflare plane,
 * alongside the routes that own the schema (session_metrics, event_batches,
 * sessions).
 *
 * Imports run cloudflare → telemetry (product), never the reverse.
 */
import type { ValidatedEvent } from "../telemetry/validate.js";
import type { CaptureConfig, TelemetryMetrics } from "../telemetry/aggregate.js";
import type { SessionMetricsState } from "../telemetry/state.js";
import { emptyState, advance, toMetrics } from "../telemetry/state.js";
import { aggregateTelemetry } from "../telemetry/aggregate.js";

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
              submit_dt, last_event_dt, capture_pointer, capture_key, last_event_seq,
              focus_dt_by_target_json, zero_dwell_violation, input_dts_json, blur_count
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
      focus_dt_by_target_json: string;
      zero_dwell_violation: number;
      input_dts_json: string;
      blur_count: number;
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
  // E5 lever 5 state (0017 columns). A pre-0017 row carries the documented
  // defaults; corrupt JSON degrades to the empty state, never a crash.
  let focusDtByTarget = new Map<string, number>();
  try {
    const parsed: unknown = JSON.parse(row.focus_dt_by_target_json ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number") focusDtByTarget.set(k, v);
      }
    }
  } catch {
    focusDtByTarget = new Map();
  }
  let inputDts: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.input_dts_json ?? "[]");
    if (Array.isArray(parsed)) inputDts = parsed.filter((x): x is number => typeof x === "number");
  } catch {
    inputDts = [];
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
    focusDtByTarget,
    zeroDwellViolation: row.zero_dwell_violation === 1,
    inputDts,
    blurCount: row.blur_count,
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
  const focusDtObj: Record<string, number> = {};
  for (const [k, v] of state.focusDtByTarget) focusDtObj[k] = v;
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
    JSON.stringify(focusDtObj),
    state.zeroDwellViolation ? 1 : 0,
    JSON.stringify(state.inputDts),
    state.blurCount,
    Date.now(),
    Date.now(),
  ];
  const now = values[values.length - 2];

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
           last_event_seq, focus_dt_by_target_json, zero_dwell_violation,
           input_dts_json, blur_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
         focus_dt_by_target_json = ?,
         zero_dwell_violation = ?,
         input_dts_json = ?,
         blur_count = ?,
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
      JSON.stringify(focusDtObj),
      state.zeroDwellViolation ? 1 : 0,
      JSON.stringify(state.inputDts),
      state.blurCount,
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
  const { foldNewEvents } = await import("./session-metrics.js");
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
  const { foldNewEvents, loadMetricsState } = await import("./session-metrics.js");
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
  sessionId: string,
  capture?: CaptureConfig
): Promise<SessionMetricsRead> {

  // Reconcile FIRST (CAS fold of any persisted-but-unfolded raw suffix), so
  // the compact row never silently lags the accepted stream.
  // P1-AUDIT-2 (P1-2): forward the caller's capture mask so the row-CREATE
  // path of catch-up can fold an absent row from raw (without it, an absent
  // row stays absent and the caller judges integrity on a row that could
  // have been rebuilt). The mask is only consulted on CREATE — existing rows
  // carry their own persisted capture (foldSessionMetrics' CAS rule).
  await catchUpSessionMetrics(db, sessionId, capture);

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

