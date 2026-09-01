/**
 * FR-P0-1 parity test — incremental folding == full aggregation.
 *
 * The production telemetry path folds event batches INCREMENTALLY into
 * session_metrics state (src/telemetry/state.ts) because batches arrive
 * one at a time. This test proves that for ANY partition of an event
 * stream into batches, the incremental fold produces metrics identical to
 * aggregateTelemetry() over the full concatenated stream — the contract
 * the previous mergeSessionMetrics (per-batch aggregates + SQL OR/MAX)
 * violated.
 *
 * Also covers the SQLite persistence round-trip (node:sqlite) so the
 * state serialization (focused_targets_json etc.) is exercised end to end.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { validateTelemetryBatch, type ValidatedEvent } from "../../src/routes/telemetry.js";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import { emptyState, advance, toMetrics } from "../../src/telemetry/state.js";

function deepEqualMetrics(a: ReturnType<typeof toMetrics>, b: ReturnType<typeof aggregateTelemetry>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Build a realistic mixed event stream (focus/blur/input/pointer/key/submit). */
function buildStream(n: number): unknown[] {
  const out: unknown[] = [];
  let seq = 0;
  let dt = 0;
  const fields = ["name", "email", "org", "password"];
  // page_ready
  out.push({ seq: ++seq, dt: dt, kind: "page_ready" });
  for (let i = 0; i < n; i++) {
    dt += 80 + ((i * 37) % 200);
    const f = fields[i % fields.length];
    switch (i % 7) {
      case 0:
      case 1:
        out.push({ seq: ++seq, dt, kind: "focus", target: f });
        break;
      case 2:
        out.push({ seq: ++seq, dt, kind: "input", target: f, meta: { inputType: "text" } });
        break;
      case 3:
        out.push({ seq: ++seq, dt, kind: "key", target: f });
        break;
      case 4:
        out.push({ seq: ++seq, dt, kind: "pointer", target: f });
        break;
      case 5:
        // blur sometimes without matching focus (exercises removal miss)
        out.push({ seq: ++seq, dt, kind: i % 2 === 0 ? "blur" : "focus", target: i % 2 === 0 ? f : "ghost" });
        break;
      case 6:
        // Direct-fill pattern: input on a field that never saw focus.
        out.push({ seq: ++seq, dt, kind: "input", target: `hidden${i}`, meta: { inputType: "text" } });
        break;
    }
    // Interleave a submit halfway and at the end.
    if (i === Math.floor(n / 2) || i === n - 1) {
      dt += 50;
      out.push({ seq: ++seq, dt, kind: "submit_attempt" });
    }
  }
  return out;
}

describe("session-metrics incremental parity (FR-P0-1)", () => {
  const captureVariants = [
    { capturePointer: true, captureKey: true },
    { capturePointer: true, captureKey: false },
    { capturePointer: false, captureKey: true },
    { capturePointer: false, captureKey: false },
  ] as const;

  for (const capture of captureVariants) {
    it(`parity across every batch boundary (size 1) — capture=${capture.capturePointer ? "P" : "p"}${capture.captureKey ? "K" : "k"}`, () => {
      const raw = buildStream(40);
      const validated = validateTelemetryBatch(raw);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const stream: ValidatedEvent[] = validated.events;

      // Reference: full aggregation.
      const reference = aggregateTelemetry(stream, capture);

      // Incremental: one event per batch (hardest partition).
      const state = emptyState(capture);
      for (const e of stream) {
        advance(state, [e]);
      }
      const incremental = toMetrics(state);

      expect(deepEqualMetrics(incremental, reference)).toBe(true);
    });

    it(`parity with random batch sizes — capture=${capture.capturePointer ? "P" : "p"}${capture.captureKey ? "K" : "k"}`, () => {
      const raw = buildStream(60);
      const validated = validateTelemetryBatch(raw);
      if (!validated.ok) throw new Error("stream must validate");
      const stream: ValidatedEvent[] = validated.events;

      const reference = aggregateTelemetry(stream, capture);

      // Deterministic pseudo-random batch sizes.
      let seed = 42;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

      const state = emptyState(capture);
      let i = 0;
      while (i < stream.length) {
        const size = 1 + Math.floor(rand() * 7);
        advance(state, stream.slice(i, i + size));
        i += size;
      }
      expect(deepEqualMetrics(toMetrics(state), reference)).toBe(true);
    });

    it(`out-of-order-blur robustness (blur for never-focused target) — capture=${JSON.stringify(capture)}`, () => {
      const raw: unknown[] = [
        { seq: 1, dt: 0, kind: "page_ready" },
        { seq: 2, dt: 100, kind: "blur", target: "nope" },
        { seq: 3, dt: 200, kind: "input", target: "name" }, // no focus ever
        { seq: 4, dt: 300, kind: "focus", target: "name" },
        { seq: 5, dt: 400, kind: "input", target: "name" }, // focused now
        { seq: 6, dt: 500, kind: "submit_attempt" },
      ];
      const v = validateTelemetryBatch(raw);
      if (!v.ok) throw new Error("validate failed");
      const reference = aggregateTelemetry(v.events, capture);
      const state = emptyState(capture);
      advance(state, v.events.slice(0, 3));
      advance(state, v.events.slice(3));
      expect(deepEqualMetrics(toMetrics(state), reference)).toBe(true);
      // directFill must be true (the first input had no focus)
      expect(toMetrics(state).directFill).toBe(true);
    });
  }

  it("submit in a LATER batch still revises completionMs (old bug regression)", () => {
    // Batch 1: focus + input events. Batch 2: submit_attempt.
    // The old mergeSessionMetrics wrote completion_ms from batch 1 (0) and
    // never revised it; the state machine must.
    const raw: unknown[] = [
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 100, kind: "focus", target: "name" },
      { seq: 3, dt: 5000, kind: "submit_attempt" },
    ];
    const v = validateTelemetryBatch(raw);
    if (!v.ok) throw new Error("validate failed");
    const capture = { capturePointer: true, captureKey: true };
    const reference = aggregateTelemetry(v.events, capture);

    const state = emptyState(capture);
    advance(state, v.events.slice(0, 2));
    const mid = toMetrics(state);
    expect(mid.completionMs).toBe(0); // not yet submitted

    advance(state, v.events.slice(2));
    const final = toMetrics(state);
    expect(final.completionMs).toBe(5000 - 100);
    expect(deepEqualMetrics(final, reference)).toBe(true);
  });

  it("pointer arriving after an empty batch clears noPointerEvents (old MAX bug regression)", () => {
    const capture = { capturePointer: true, captureKey: true };
    // Batch 1: only page_ready → noPointerEvents true.
    // Batch 2: pointer event → must become false.
    const state = emptyState(capture);
    advance(state, [
      { seq: 1, dt: 0, kind: "page_ready" } as ValidatedEvent,
    ]);
    expect(toMetrics(state).noPointerEvents).toBe(true);

    advance(state, [
      { seq: 2, dt: 100, kind: "pointer", target: "form" } as ValidatedEvent,
    ]);
    expect(toMetrics(state).noPointerEvents).toBe(false);
    expect(toMetrics(state).pointerCount).toBe(1);
    void capture;
  });

  it("empty stream → same 'no events' shape as aggregateTelemetry", () => {
    const capture = { capturePointer: true, captureKey: true };
    const reference = aggregateTelemetry([], capture);
    const incremental = toMetrics(emptyState(capture));
    expect(deepEqualMetrics(incremental, reference)).toBe(true);
    expect(incremental.completionMs).toBe(0);
    expect(incremental.noPointerEvents).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite persistence round-trip (mirrors the D1 schema in
// migrations/0011_session_metrics_state.sql)
// ---------------------------------------------------------------------------

describe("session-metrics state persistence (FR-P0-1)", () => {
  function makeDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE session_metrics (
        session_id TEXT PRIMARY KEY,
        focused_targets_json TEXT NOT NULL DEFAULT '[]',
        pointer_count INTEGER NOT NULL DEFAULT 0,
        focus_transitions INTEGER NOT NULL DEFAULT 0,
        key_count INTEGER NOT NULL DEFAULT 0,
        input_without_focus INTEGER NOT NULL DEFAULT 0,
        first_event_dt INTEGER,
        first_meaningful_dt INTEGER,
        submit_dt INTEGER,
        last_event_dt INTEGER,
        capture_pointer INTEGER NOT NULL DEFAULT 0,
        capture_key INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT -1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    return db;
  }

  /** In-memory stand-ins for the D1 wrappers, executing the same SQL. */
  function makeWrappers(db: DatabaseSync) {
    return {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first() {
                const row = db
                  .prepare(sql)
                  .get(...(args as never[])) as Record<string, unknown> | undefined;
                return row;
              },
              run() {
                // REAL changes count — the CAS save verdicts read meta.changes,
                // so a hardcoded 1 would make every conflict look "applied".
                const res = db.prepare(sql).run(...(args as never[]));
                return { meta: { changes: Number(res.changes) } };
              },
            };
          },
        };
      },
      // db.batch(statements): each statement is an already-bound
      // { run() } from prepare().bind(...); execute in order.
      batch(statements: { run(): unknown }[]) {
        return statements.map((s) => s.run());
      },
    };
  }

  it("save → load round-trip preserves the state exactly", async () => {
    const { loadMetricsState, saveMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeDb();
    const wrappers = makeWrappers(db);
    const capture = { capturePointer: true, captureKey: true };

    let state = emptyState(capture);
    advance(state, validateTelemetryBatch([
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 10, kind: "focus", target: "a" },
      { seq: 3, dt: 20, kind: "blur", target: "a" },
      { seq: 4, dt: 30, kind: "focus", target: "b" },
      { seq: 5, dt: 40, kind: "pointer", target: "b" },
      { seq: 6, dt: 50, kind: "input", target: "ghost" },
    ]).ok ? [] : []);
    // (validate inline instead — simpler)
    state = emptyState(capture);
    advance(state, [
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 10, kind: "focus", target: "a" },
      { seq: 3, dt: 20, kind: "blur", target: "a" },
      { seq: 4, dt: 30, kind: "focus", target: "b" },
      { seq: 5, dt: 40, kind: "pointer", target: "b" },
      { seq: 6, dt: 50, kind: "input", target: "ghost" },
    ] as ValidatedEvent[]);

    await saveMetricsState(wrappers as unknown as D1Database, "s1", state, null);
    const loaded = await loadMetricsState(wrappers as unknown as D1Database, "s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.focusedTargets).toEqual(["b"]);
    expect(loaded!.pointerCount).toBe(1);
    expect(loaded!.focusTransitions).toBe(2);
    expect(loaded!.inputWithoutFocus).toBe(1);
    expect(loaded!.lastSeq).toBe(6);
    expect(loaded!.firstMeaningfulDt).toBe(10);
    // Folding more events onto the LOADED state matches the full aggregate.
    advance(loaded!, [
      { seq: 7, dt: 60, kind: "input", target: "b" },
      { seq: 8, dt: 100, kind: "submit_attempt" },
    ] as ValidatedEvent[]);
    const reference = aggregateTelemetry(
      validateTelemetryBatch([
        { seq: 1, dt: 0, kind: "page_ready" },
        { seq: 2, dt: 10, kind: "focus", target: "a" },
        { seq: 3, dt: 20, kind: "blur", target: "a" },
        { seq: 4, dt: 30, kind: "focus", target: "b" },
        { seq: 5, dt: 40, kind: "pointer", target: "b" },
        { seq: 6, dt: 50, kind: "input", target: "ghost" },
        { seq: 7, dt: 60, kind: "input", target: "b" },
        { seq: 8, dt: 100, kind: "submit_attempt" },
      ]).ok ? [] : []
    );
    // (reference built directly below — the validateTelemetryBatch(...) ? [] : []
    //  construction above is a placeholder; compute it properly:)
    const all = [
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 10, kind: "focus", target: "a" },
      { seq: 3, dt: 20, kind: "blur", target: "a" },
      { seq: 4, dt: 30, kind: "focus", target: "b" },
      { seq: 5, dt: 40, kind: "pointer", target: "b" },
      { seq: 6, dt: 50, kind: "input", target: "ghost" },
      { seq: 7, dt: 60, kind: "input", target: "b" },
      { seq: 8, dt: 100, kind: "submit_attempt" },
    ];
    const v = validateTelemetryBatch(all);
    if (!v.ok) throw new Error("validate failed");
    const ref2 = aggregateTelemetry(v.events, capture);
    expect(deepEqualMetrics(toMetrics(loaded!), ref2)).toBe(true);
    void reference;
  });

  it("CAS save on a stale base reports conflict and does NOT write (P0-6)", async () => {
    const { loadMetricsState, saveMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeDb();
    const wrappers = makeWrappers(db);
    const capture = { capturePointer: true, captureKey: true };

    const state = emptyState(capture);
    advance(state, [{ seq: 1, dt: 0, kind: "pointer", target: "x" } as ValidatedEvent]);
    expect(await saveMetricsState(wrappers as unknown as D1Database, "s1", state, null)).toBe("applied");

    // Another writer loads the row (base = 1), folds seq 2, and saves.
    const theirs = await loadMetricsState(wrappers as unknown as D1Database, "s1");
    const theirsBase = theirs!.lastSeq; // captured BEFORE advancing (this IS the base)
    advance(theirs!, [{ seq: 2, dt: 5, kind: "key", target: "x" } as ValidatedEvent]);
    expect(await saveMetricsState(wrappers as unknown as D1Database, "s1", theirs!, theirsBase)).toBe("applied");
    expect(theirs!.pointerCount).toBe(1);
    expect(theirs!.keyCount).toBe(1);

    // Our write is based on the OLD base (lastSeq 1): the CAS must refuse —
    // a stale full-snapshot write would bury writer B's key event.
    const stale = emptyState(capture);
    advance(stale, [{ seq: 1, dt: 0, kind: "pointer", target: "x" }, { seq: 3, dt: 9, kind: "key", target: "y" } as ValidatedEvent]);
    expect(await saveMetricsState(wrappers as unknown as D1Database, "s1", stale, 1)).toBe("conflict");
    const loaded = await loadMetricsState(wrappers as unknown as D1Database, "s1");
    expect(loaded!.lastSeq).toBe(2); // theirs survives; stale write dropped
  });
});

// ---------------------------------------------------------------------------
// P1-AUDIT-2 — watermark reconciliation on metrics read.
// The metrics fold is best-effort (it may fail without failing the batch
// ingest), so session_metrics.last_event_seq can lag sessions.last_event_seq.
// loadSessionMetrics() must reconcile — replay the persisted-but-unfolded raw
// batches — rather than return stale metrics that under-count interactions.
// ---------------------------------------------------------------------------
describe("metrics watermark reconciliation (P1-AUDIT-2)", () => {
  function makeFullDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE session_metrics (
        session_id TEXT PRIMARY KEY,
        focused_targets_json TEXT NOT NULL DEFAULT '[]',
        pointer_count INTEGER NOT NULL DEFAULT 0,
        focus_transitions INTEGER NOT NULL DEFAULT 0,
        key_count INTEGER NOT NULL DEFAULT 0,
        input_without_focus INTEGER NOT NULL DEFAULT 0,
        first_event_dt INTEGER,
        first_meaningful_dt INTEGER,
        submit_dt INTEGER,
        last_event_dt INTEGER,
        capture_pointer INTEGER NOT NULL DEFAULT 0,
        capture_key INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT -1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        last_event_seq INTEGER
      );
      CREATE TABLE event_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    return db;
  }

  /** Self-contained D1 wrapper for this block (sessions/event_batches reads). */
  function makeWrappers(db: DatabaseSync) {
    return {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first() {
                const row = db
                  .prepare(sql)
                  .get(...(args as never[])) as Record<string, unknown> | undefined;
                return row;
              },
              all() {
                const rows = db
                  .prepare(sql)
                  .all(...(args as never[])) as unknown[];
                return { results: rows };
              },
              run() {
                db.prepare(sql).run(...(args as never[]));
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      batch(statements: { run(): unknown }[]) {
        return statements.map((s) => s.run());
      },
    } as unknown as D1Database;
  }

  it("metrics row behind the session watermark is caught up on read", async () => {
    const { loadSessionMetrics } = await import("../../src/telemetry/aggregate.js");
    const { loadMetricsState, saveMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeFullDb();
    const w = makeWrappers(db);

    // Session accepted through seq 4.
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('s1', 4)`).run();
    // Raw batches: [1..2] and [3..4].
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES ('s1', 1, 2, ?)`
    ).run(JSON.stringify([
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 100, kind: "pointer", target: "form" },
    ]));
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES ('s1', 3, 4, ?)`
    ).run(JSON.stringify([
      { seq: 3, dt: 200, kind: "focus", target: "name" },
      { seq: 4, dt: 300, kind: "input", target: "name" },
    ]));

    // Metrics row was folded ONLY through seq 2 (the fold for [3..4] failed).
    const capture = { capturePointer: true, captureKey: true };
    const partial = emptyState(capture);
    advance(partial, [{ seq: 1, dt: 0, kind: "page_ready" }, { seq: 2, dt: 100, kind: "pointer", target: "form" }] as ValidatedEvent[]);
    await saveMetricsState(w as unknown as D1Database, "s1", partial, null);

    // Record is behind (lastSeq 2). loadSessionMetrics must replay [3..4]
    // and report the read COMPLETE (the compact row now covers the stream).
    const caught = await loadSessionMetrics(w, "s1");
    expect(caught.status).toBe("complete");
    expect(caught.metrics).not.toBeNull();
    expect(caught.metrics!.focusTransitions).toBe(1);   // seq 3 folded in
    expect(caught.metrics!.pointerCount).toBe(1);       // seq 2, not double-counted
    // seq 3 focused "name"; seq 4 input "name" → the input HAS focus, so
    // directFill is false. (The pre-existing fold only saw seqs 1–2.)
    expect(caught.metrics!.directFill).toBe(false);
    // The state row itself is now caught up.
    const persisted = await loadMetricsState(w as unknown as D1Database, "s1");
    expect(persisted!.lastSeq).toBe(4);
  });

  it("behind metrics row with NO recoverable batches (pruned) reports incomplete (P0-7)", async () => {
    const { loadSessionMetrics } = await import("../../src/telemetry/aggregate.js");
    const { loadMetricsState, saveMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeFullDb();
    const w = makeWrappers(db);
    const capture = { capturePointer: true, captureKey: true };

    // Session accepted through 4, but raw batches were already pruned.
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('s2', 4)`).run();
    // (no event_batches rows — they were pruned by retention)

    // Metrics row only folded through seq 2.
    const partial = emptyState(capture);
    advance(partial, [{ seq: 1, dt: 0, kind: "page_ready" }, { seq: 2, dt: 100, kind: "pointer", target: "form" }] as ValidatedEvent[]);
    await saveMetricsState(w as unknown as D1Database, "s2", partial, null);

    // No raw rows to replay → the server KNOWS the compact window is
    // truncated. P0-7: that must surface as an INCOMPLETE integrity result
    // — never silently converted into behavioral evidence.
    const m = await loadSessionMetrics(w, "s2");
    expect(m.status).toBe("incomplete");
    expect(m.expectedThrough).toBe(4);
    expect(m.actualThrough).toBe(2);
    // The state row itself is unchanged (nothing recoverable to fold).
    const still = await loadMetricsState(w, "s2");
    expect(still!.lastSeq).toBe(2);
  });

  it("ABSENT metrics row with raw rows and capture supplied is REBUILT complete (P1-2)", async () => {
    const { loadSessionMetrics } = await import("../../src/telemetry/aggregate.js");
    const { loadMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeFullDb();
    const w = makeWrappers(db);

    // Session accepted through watermark 10; raw 1..10 persisted in two
    // batches. NO session_metrics row exists (every prior fold failed or
    // never ran — e.g. the D1 metrics write errored while the raw log went
    // in through the same batch()).
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('s3', 10)`).run();
    const mk = (seq: number, dt: number, kind: string, target?: string): ValidatedEvent =>
      ({ seq, dt, kind, ...(target ? { target } : {}) }) as ValidatedEvent;
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES ('s3', 1, 5, ?)`
    ).run(JSON.stringify([
      mk(1, 0, "page_ready"),
      mk(2, 100, "focus", "name"),
      mk(3, 200, "input", "name"),
      mk(4, 300, "key", "name"),
      mk(5, 400, "pointer", "form"),
    ]));
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES ('s3', 6, 10, ?)`
    ).run(JSON.stringify([
      mk(6, 500, "focus", "email"),
      mk(7, 600, "input", "email"),
      mk(8, 700, "blur", "email"),
      mk(9, 800, "input", "org"),
      mk(10, 900, "submit_attempt", "form"),
    ]));

    // P1-2: WITHOUT the capture mask, catch-up's row-CREATE path cannot
    // create the row, so the read falls to the "incomplete" branch (known
    // truncation) even though the raw log is fully recoverable.
    const noCapture = await loadSessionMetrics(w, "s3");
    expect(noCapture.status).toBe("incomplete");
    expect(noCapture.expectedThrough).toBe(10);
    expect(noCapture.actualThrough).toBe(-1);

    // WITH the profile's capture mask (what submit.ts now supplies), the
    // absent row is rebuilt from raw 1..10 and the run read is COMPLETE —
    // the caller gets behavioral evidence, not a silent truncation.
    const rebuilt = await loadSessionMetrics(w, "s3", { capturePointer: true, captureKey: true });
    expect(rebuilt.status).toBe("complete");
    expect(rebuilt.metrics).not.toBeNull();
    expect(rebuilt.metrics!.pointerCount).toBe(1);         // seq 5 only
    expect(rebuilt.metrics!.focusTransitions).toBe(2);     // seq 2 + seq 6
    expect(rebuilt.metrics!.keyCount).toBe(1);             // seq 4 only
    // seq 7/9: input on "email"/"org" while NOT focused (email blurred at
    // seq 8; org never focused) → direct-fill pattern present.
    expect(rebuilt.metrics!.directFill).toBe(true);
    // The rebuilt row persists (a second read is complete without needing
    // the mask again — the row carries its own capture).
    const persisted = await loadMetricsState(w as unknown as D1Database, "s3");
    expect(persisted!.lastSeq).toBe(10);
    const second = await loadSessionMetrics(w, "s3");
    expect(second.status).toBe("complete");
    expect(second.metrics!.keyCount).toBe(1);
  });

  it("complete stream reports complete; empty session reports absent (P0-7)", async () => {
    const { loadSessionMetrics } = await import("../../src/telemetry/aggregate.js");
    const { saveMetricsState } = await import("../../src/telemetry/state.js");
    const db = makeFullDb();
    const w = makeWrappers(db);
    const capture = { capturePointer: true, captureKey: true };

    // A session whose compact row is caught up → complete.
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('s3', 1)`).run();
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES ('s3', 1, 1, ?)`
    ).run(JSON.stringify([{ seq: 1, dt: 0, kind: "pointer", target: "f" }]));
    const st = emptyState(capture);
    advance(st, [{ seq: 1, dt: 0, kind: "pointer", target: "f" } as ValidatedEvent]);
    await saveMetricsState(w as unknown as D1Database, "s3", st, null);
    const okRead = await loadSessionMetrics(w, "s3");
    expect(okRead.status).toBe("complete");
    expect(okRead.metrics!.pointerCount).toBe(1);

    // A session with no events at all → absent (complete-by-vacuity).
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('s4', NULL)`).run();
    const absent = await loadSessionMetrics(w, "s4");
    expect(absent.status).toBe("absent");
    expect(absent.metrics).toBeNull();
  });
});
