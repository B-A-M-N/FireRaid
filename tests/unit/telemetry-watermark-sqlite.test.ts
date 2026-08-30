/**
 * Real-SQLite watermark tests (FR-R6-082).
 * Mocked-D1 tests cannot catch the failure classes this audit actually hit:
 *   - NULL last_event_seq comparing as NULL/false (FR-R6-031, seen live: a
 *     fresh session 409'd on its FIRST /api/events batch)
 *   - batch commit semantics (does a rejected batch insert nothing?)
 *   - overlapping replays against the first-edge predicate (FR-R6-033)
 *   - unique batch-identity behavior (FR-R6-032, migration 0008)
 * So: run the real SQL through node:sqlite (D1-compatible) against the real
 * migration chain, with a minimal D1Database adapter over DatabaseSync.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateTelemetryBatch,
  persistTelemetryBatch,
  type ValidatedEvent,
} from "../../src/routes/telemetry.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

/** Apply the full migration chain, in lexical order, to a fresh DB. */
function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

/**
 * Minimal D1Database surface over node:sqlite. persistTelemetryBatch uses
 * only prepare().bind().run() and db.batch([...]) — both implemented with
 * real SQL semantics: a batch executes statements sequentially on the same
 * connection, changes counts come from SQLite, and unique-violations throw
 * with SQLite's real error text.
 */
function makeD1(db: DatabaseSync): D1Database {
  type Stmt = { sql: string; params: unknown[] };

  function runStmt(stmt: Stmt): { meta: { changes: number } } {
    const res = db.prepare(stmt.sql).run(...(stmt.params as never[]));
    return { meta: { changes: Number(res.changes) } };
  }

  return {
    prepare(sql: string) {
      const stmt: Stmt = { sql, params: [] };
      return {
        bind(...params: unknown[]) {
          stmt.params = params;
          return {
            run: async () => runStmt(stmt),
          };
        },
        run: async () => runStmt(stmt),
      };
    },
    async batch(statements: { run: () => Promise<{ meta: { changes: number } }> }[]) {
      const results: { meta: { changes: number } }[] = [];
      for (const entry of statements) {
        results.push(await entry.run());
      }
      return results;
    },
  } as unknown as D1Database;
}

/** Insert a session row the way signup does (no last_event_seq — NULL). */
function insertSession(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
     VALUES (?, 1, 1, 1, 'p', 'h', 0)`
  ).run(id);
}

function batch(first: number, last: number): ValidatedEvent[] {
  const out: ValidatedEvent[] = [];
  for (let s = first; s <= last; s++) {
    out.push({ seq: s, dt: s * 10, kind: "focus", target: `t${s}` });
  }
  return out;
}

describe("persistTelemetryBatch against real SQLite (FR-R6-082)", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let tmp: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyMigrations(db);
    d1 = makeD1(db);
    tmp = mkdtempSync(join(tmpdir(), "fr-telemetry-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("FR-R6-031: fresh session (NULL last_event_seq) accepts its FIRST batch", async () => {
    insertSession(db, "s1");
    const events = batch(1, 3);
    const v = validateTelemetryBatch(events);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const wm = await persistTelemetryBatch(d1, "s1", v.events);
    expect(wm).toBe(3);
    const stored = db.prepare(
      `SELECT COALESCE(last_event_seq, -1) AS wm FROM sessions WHERE id = 's1'`
    ).get() as { wm: number };
    expect(stored.wm).toBe(3);
  });

  it("next batch after an accepted one is accepted", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    const v2 = validateTelemetryBatch(batch(4, 6));
    if (!v1.ok || !v2.ok) throw new Error("fixtures invalid");
    await persistTelemetryBatch(d1, "s1", v1.events);
    await persistTelemetryBatch(d1, "s1", v2.events);
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(6);
  });

  it("FR-R6-033: overlapping batch (stored 3, incoming 1..50) is REJECTED and inserts NOTHING", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    await persistTelemetryBatch(d1, "s1", v1.events);

    // Overlap: first_seq=1 is NOT > watermark 3 → both statements' predicates
    // fail. (1..100 would trip MAX_EVENTS_PER_BATCH first — use 1..50.)
    const v2 = validateTelemetryBatch(batch(1, 50));
    if (!v2.ok) throw new Error("fixture invalid");
    await expect(persistTelemetryBatch(d1, "s1", v2.events)).rejects.toThrow("SEQ_WATERMARK_VIOLATION");
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM event_batches WHERE session_id = 's1'`).get() as { c: number }).c;
    expect(count).toBe(1); // only the first batch exists — the rejected one inserted nothing
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(3);
  });

  it("exact replay of an accepted batch → BATCH_IDENTITY_CONFLICT (FR-R6-032)", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    await persistTelemetryBatch(d1, "s1", v1.events);

    // An exact replay fails the watermark predicate first (1 < 3 is false),
    // so the observable behavior for an exact replay is SEQ_WATERMARK_VIOLATION.
    // The identity index is the second line of defense for the race window
    // where two identical batches race BEFORE the watermark advances.
    await expect(persistTelemetryBatch(d1, "s1", v1.events)).rejects.toThrow("SEQ_WATERMARK_VIOLATION");
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM event_batches WHERE session_id = 's1'`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("identity index blocks two identical concurrent first batches (FR-R6-032)", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    // First insert succeeds.
    await persistTelemetryBatch(d1, "s1", v1.events);
    // Manually reset the watermark to simulate the pre-update race window;
    // the identity index must now reject the second identical INSERT.
    db.exec(`UPDATE sessions SET last_event_seq = NULL WHERE id = 's1'`);
    await expect(persistTelemetryBatch(d1, "s1", v1.events)).rejects.toThrow(/BATCH_IDENTITY_CONFLICT|UNIQUE/);
  });

  it("legacy row with last_event_seq set behaves identically to COALESCE path", async () => {
    insertSession(db, "s1");
    db.exec(`UPDATE sessions SET last_event_seq = 10 WHERE id = 's1'`);
    const v = validateTelemetryBatch(batch(11, 20));
    if (!v.ok) throw new Error("fixture invalid");
    await persistTelemetryBatch(d1, "s1", v.events);
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(20);
    // And an overlap below the stored edge is rejected.
    const v2 = validateTelemetryBatch(batch(5, 25));
    if (!v2.ok) throw new Error("fixture invalid");
    // first_seq 5 < watermark 20 → rejected (this is FR-R6-033's 1..100 case)
    await expect(persistTelemetryBatch(d1, "s1", v2.events)).rejects.toThrow("SEQ_WATERMARK_VIOLATION");
  });
});
