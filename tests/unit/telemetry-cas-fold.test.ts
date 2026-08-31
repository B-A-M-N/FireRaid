/**
 * P1-AUDIT-2 (P0-6) — concurrent compact-metrics fold races, on REAL SQLite.
 *
 * The audit's exact scenario: two writers fold DISJOINT suffixes (A: seqs
 * 1..10, B: seqs 11..20). The prior forward-only `last_event_seq < ?` guard
 * let BOTH writes through (each watermark was ahead of the stored one at
 * write time), and the higher watermark won while permanently burying the
 * loser's events — the compact row claimed a watermark covering events it
 * never folded, and reconciliation (sessions watermark == metrics watermark)
 * could never detect the loss.
 *
 * These tests drive the REAL production fold owner (foldUpTo's log-driven
 * CAS in src/telemetry/state.ts) against node:sqlite. Invariant: whatever
 * the interleaving, the final compact row must equal the full raw
 * aggregation — asserted against aggregateTelemetry.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import {
  loadMetricsState,
  foldNewEvents,
  catchUpSessionMetrics,
  saveMetricsState,
  emptyState,
  advance,
  toMetrics,
} from "../../src/telemetry/state.js";
import type { ValidatedEvent } from "../../src/routes/telemetry.js";

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

/** D1-shaped wrapper over node:sqlite with REAL change counts and
 * statement-sequenced batch (no parallelism inside a batch — mirroring D1's
 * serialized single-statement execution). */
function makeWrappers(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () =>
              db.prepare(sql).get(...(args as never[])) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
            run: async () => {
              const res = db.prepare(sql).run(...(args as never[]));
              return { meta: { changes: Number(res.changes) } };
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function events(seqs: number[]): ValidatedEvent[] {
  return seqs.map((seq) => {
    const kind = seq % 3 === 0 ? "input" : seq % 3 === 1 ? "focus" : "pointer";
    return { seq, dt: seq * 10, kind, target: `#f${seq % 4}` } as ValidatedEvent;
  });
}

/** Store a suffix as the raw log (as the ingest route would). */
function storeLog(db: DatabaseSync, sessionId: string, evs: ValidatedEvent[]): void {
  db.prepare(
    `INSERT INTO event_batches (session_id, first_seq, last_seq, payload_json) VALUES (?, ?, ?, ?)`
  ).run(sessionId, evs[0].seq, evs[evs.length - 1].seq, JSON.stringify(evs));
}

describe("concurrent compact-metrics fold (P0-6)", () => {
  it("out-of-order owner folds (B's half, then A's half) yield the full aggregation", async () => {
    // Production models concurrency as ANY interleaving of owner calls: the
    // log is shared truth, so whichever order the folds land in, the row
    // converges to the full aggregation. The audit's burial (higher
    // watermark skips the loser's lower events) is structurally impossible
    // here because foldUpTo sources from the log, never a caller snapshot.
    const db = makeDb();
    const w = makeWrappers(db);
    const all = events(Array.from({ length: 20 }, (_, i) => i + 1));
    const A = all.slice(0, 10);
    const B = all.slice(10);
    storeLog(db, "race", A);
    storeLog(db, "race", B);
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('race', 20)`).run();
    const capture = { capturePointer: true, captureKey: true };

    await foldNewEvents(w, "race", B, capture); // target 20 first
    await foldNewEvents(w, "race", A, capture); // then target 10 (BELOW base)

    const persisted = await loadMetricsState(w, "race");
    expect(persisted!.lastSeq).toBe(20);
    const reference = aggregateTelemetry(all, capture);
    const final = toMetrics(persisted!);
    expect(final.pointerCount).toBe(reference.pointerCount);
    expect(final.focusTransitions).toBe(reference.focusTransitions);
    expect(final.directFill).toBe(reference.directFill);
    expect(final.keyCount).toBe(reference.keyCount);
  });

  it("raw snapshot write from a partial fold is REFUSED (no arbitrary high-watermark saves)", async () => {
    // The audit's burial required letting a writer save an arbitrary
    // in-memory snapshot at a higher watermark. The CAS primitive refuses
    // exactly that: writer B owns the row through the owner (covering the
    // log through 20); writer A's snapshot (holding only 1..10) at base
    // null or a stale base is rejected, never persisted.
    const db = makeDb();
    const w = makeWrappers(db);
    const all = events(Array.from({ length: 20 }, (_, i) => i + 1));
    const A = all.slice(0, 10);
    storeLog(db, "snap", all);
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('snap', 20)`).run();
    const capture = { capturePointer: true, captureKey: true };

    await foldNewEvents(w, "snap", all, capture); // owner: full coverage
    const aSnapshot = emptyState(capture);
    advance(aSnapshot, A);
    // A tries to install its partial snapshot over the covered row.
    expect(await saveMetricsState(w, "snap", aSnapshot, null)).toBe("conflict");
    expect(await saveMetricsState(w, "snap", aSnapshot, 10)).toBe("conflict");
    // And the pre-CAS burial (forward-only guard) can't happen either:
    // writing base 25 (never existed) is refused.
    expect(await saveMetricsState(w, "snap", aSnapshot, 25)).toBe("conflict");

    const persisted = await loadMetricsState(w, "snap");
    expect(persisted!.pointerCount).toBe(
      all.filter((e) => e.kind === "pointer").length
    );
  });

  it("out-of-order foldNewEvents (lower target after higher) still converges", async () => {
    const db = makeDb();
    const w = makeWrappers(db);
    const all = events(Array.from({ length: 20 }, (_, i) => i + 1));
    const A = all.slice(0, 10);
    const B = all.slice(10);
    storeLog(db, "ooo", A);
    storeLog(db, "ooo", B);
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('ooo', 20)`).run();
    const capture = { capturePointer: true, captureKey: true };

    // B first (target 20), then A (target 10 — BELOW the persisted
    // watermark). The old forward-only guard skipped A here, burying seqs
    // 1..10 forever; the log-driven fold must fold them on top.
    await foldNewEvents(w, "ooo", B, capture);
    await foldNewEvents(w, "ooo", A, capture);

    const persisted = await loadMetricsState(w, "ooo");
    const reference = aggregateTelemetry(all, capture);
    const final = toMetrics(persisted!);
    expect(final.pointerCount).toBe(reference.pointerCount);
    expect(final.focusTransitions).toBe(reference.focusTransitions);
    expect(final.directFill).toBe(reference.directFill);
  });

  it("double-fold of the same suffix does NOT double-count (idempotent replay)", async () => {
    const db = makeDb();
    const w = makeWrappers(db);
    const evs = events([1, 2, 3, 4]);
    storeLog(db, "idem", evs);
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('idem', 4)`).run();
    const capture = { capturePointer: true, captureKey: true };

    await foldNewEvents(w, "idem", evs, capture);
    // A reconciliation read re-folds an overlapping window; counts must not move.
    await catchUpSessionMetrics(w, "idem", capture);
    await foldNewEvents(w, "idem", evs, capture);
    const persisted = await loadMetricsState(w, "idem");
    expect(persisted!.pointerCount).toBe(evs.filter((e) => e.kind === "pointer").length);
    expect(persisted!.lastSeq).toBe(4);
  });

  it("CAS conflict is returned, not swallowed (stale base never writes)", async () => {
    const db = makeDb();
    const w = makeWrappers(db);
    const capture = { capturePointer: true, captureKey: true };

    const s0 = emptyState(capture);
    advance(s0, events([1, 2]));
    expect(await saveMetricsState(w, "cas", s0, null)).toBe("applied");

    // Writer B: loads base 2, folds seq 3, saves with base 2 → applied.
    const current = await loadMetricsState(w, "cas");
    expect(current!.lastSeq).toBe(2);
    const currentBase = current!.lastSeq;
    advance(current!, events([3]));
    expect(await saveMetricsState(w, "cas", current!, currentBase)).toBe("applied");

    // Writer A: still holds base 2 (pre-B). Its full-snapshot write MUST be
    // refused — otherwise it would bury B's seq-3 fold.
    const ghost = emptyState(capture);
    advance(ghost, events([1, 2, 9]));
    expect(await saveMetricsState(w, "cas", ghost, 2)).toBe("conflict");

    const persisted = await loadMetricsState(w, "cas");
    expect(persisted!.lastSeq).toBe(3);
    expect(persisted!.pointerCount).toBe(1); // ghost's seq-9 pointer never landed
    expect(persisted!.keyCount).toBe(0);     // seq 3 is an input; no key folded
  });

  it("reconciliation without a capture mask leaves an absent row absent (create needs the mask)", async () => {
    const db = makeDb();
    const w = makeWrappers(db);
    const evs = events([1, 2, 3]);
    storeLog(db, "mask", evs);
    db.prepare(`INSERT INTO sessions (id, last_event_seq) VALUES ('mask', 3)`).run();

    // No compact row, no mask supplied: foldUpTo must NOT guess capture=true.
    const seq = await catchUpSessionMetrics(w, "mask");
    expect(seq).toBe(-1);
    expect(await loadMetricsState(w, "mask")).toBeNull();

    // With the mask, the row is created from the log.
    const seq2 = await catchUpSessionMetrics(w, "mask", { capturePointer: true, captureKey: false });
    expect(seq2).toBe(3);
    const st = await loadMetricsState(w, "mask");
    expect(st!.captureKey).toBe(false);
  });
});
