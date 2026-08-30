/**
 * Real-SQLite watermark tests (FR-R6-082, updated for FR-P0-2/3).
 * Mocked-D1 tests cannot catch the failure classes this audit actually hit:
 *   - NULL last_event_seq comparing as NULL/false (FR-R6-031, seen live: a
 *     fresh session 409'd on its FIRST /api/events batch)
 *   - batch commit semantics (does a rejected batch insert nothing?)
 *   - overlapping replays against the first-edge predicate (FR-R6-033)
 *   - unique batch-identity behavior (FR-R6-032, migration 0008)
 * So: run the real SQL through node:sqlite (D1-compatible) against the real
 * migration chain, with a minimal D1Database adapter over DatabaseSync.
 *
 * FR-P0-3: the canonical path is now ingestTelemetryBatch — an overlapping
 * batch is no longer rejected wholesale; its accepted prefix is stripped and
 * only the never-stored suffix persists. These tests verify that contract,
 * including that the old wholesale-rejection failure mode is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateTelemetryBatch,
  ingestTelemetryBatch,
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
 * Minimal D1Database surface over node:sqlite. ingestTelemetryBatch uses
 * prepare().bind().first() / .run() and db.batch([...]) — implemented with
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
            first: async () => {
              const row = db.prepare(stmt.sql).get(...(stmt.params as never[]));
              return (row ?? null) as never;
            },
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

async function ingest(
  d1: D1Database,
  sessionId: string,
  events: ValidatedEvent[]
): Promise<Extract<Awaited<ReturnType<typeof ingestTelemetryBatch>>, { kind: "accepted" | "conflict" }>> {
  const outcome = await ingestTelemetryBatch(d1, sessionId, events);
  if (outcome.kind === "too_large") throw new Error("unexpected TOO_LARGE");
  if (outcome.kind === "failed") throw new Error("unexpected FAILED");
  return outcome;
}

describe("ingestTelemetryBatch against real SQLite (FR-R6-082 + FR-P0-2/3)", () => {
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
    const outcome = await ingest(d1, "s1", v.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.acceptedThrough).toBe(3);
    expect(outcome.stored).toHaveLength(3);
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
    await ingest(d1, "s1", v1.events);
    const outcome = await ingest(d1, "s1", v2.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.acceptedThrough).toBe(6);
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(6);
  });

  it("FR-P0-3: OVERLAPPING batch (stored 1..3, incoming 1..50) stores only the SUFFIX 4..50", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    await ingest(d1, "s1", v1.events);

    // The old persistTelemetryBatch rejected this wholesale — losing seqs
    // 4..50 forever if the client trusted the failure. The canonical path
    // strips the stored prefix and persists the suffix.
    const v2 = validateTelemetryBatch(batch(1, 50));
    if (!v2.ok) throw new Error("fixture invalid");
    const outcome = await ingest(d1, "s1", v2.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.stored).toHaveLength(47); // seqs 4..50
    expect(outcome.stored[0].seq).toBe(4);
    expect(outcome.acceptedThrough).toBe(50);

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM event_batches WHERE session_id = 's1'`).get() as { c: number }).c;
    expect(count).toBe(2); // batch(1..3) + batch(4..50)
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(50);

    // The stored suffix covers exactly the never-stored seqs.
    const rows = db.prepare(
      `SELECT first_seq, last_seq FROM event_batches WHERE session_id = 's1' ORDER BY first_seq`
    ).all() as { first_seq: number; last_seq: number }[];
    expect(rows).toEqual([
      { first_seq: 1, last_seq: 3 },
      { first_seq: 4, last_seq: 50 },
    ]);
  });

  it("EXACT replay of an accepted batch → duplicate success reporting the watermark (FR-P0-2)", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    await ingest(d1, "s1", v1.events);

    const outcome = await ingest(d1, "s1", v1.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.duplicate).toBe(true);
    expect(outcome.stored).toHaveLength(0);
    expect(outcome.acceptedThrough).toBe(3);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM event_batches WHERE session_id = 's1'`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("partially-overlapping batch (stored 1..10, incoming 5..12) stores only 11..12", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 10));
    const v2 = validateTelemetryBatch(batch(5, 12));
    if (!v1.ok || !v2.ok) throw new Error("fixtures invalid");
    await ingest(d1, "s1", v1.events);
    const outcome = await ingest(d1, "s1", v2.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.stored.map((e) => e.seq)).toEqual([11, 12]);
    expect(outcome.acceptedThrough).toBe(12);
    // The stored rows cover 1..12 with no gaps and no duplicates.
    const rows = db.prepare(
      `SELECT first_seq, last_seq FROM event_batches WHERE session_id = 's1' ORDER BY first_seq`
    ).all() as { first_seq: number; last_seq: number }[];
    expect(rows).toEqual([
      { first_seq: 1, last_seq: 10 },
      { first_seq: 11, last_seq: 12 },
    ]);
  });

  it("identity index blocks two identical concurrent first batches (FR-R6-032 race window)", async () => {
    insertSession(db, "s1");
    const v1 = validateTelemetryBatch(batch(1, 3));
    if (!v1.ok) throw new Error("fixture invalid");
    await ingest(d1, "s1", v1.events);
    // Simulate the race: reset the watermark so the suffix-strip passes both
    // writers; the identity index must still reject the second identical INSERT,
    // surfacing as CONFLICT (benign — the first writer won). The reported
    // watermark is re-read AFTER the failure — the data IS stored (by the
    // first writer), but the sessions row was reset by the simulation, so
    // the authoritative answer here is -1... which is exactly why the
    // simulation resets a row that in production would never go backwards.
    // The contract under test: the outcome is CONFLICT, never a silent drop
    // or a 500.
    db.exec(`UPDATE sessions SET last_event_seq = NULL WHERE id = 's1'`);
    const outcome = await ingest(d1, "s1", v1.events);
    expect(outcome.kind).toBe("conflict");
  });

  it("legacy row with last_event_seq set behaves identically to COALESCE path", async () => {
    insertSession(db, "s1");
    db.exec(`UPDATE sessions SET last_event_seq = 10 WHERE id = 's1'`);
    const v = validateTelemetryBatch(batch(11, 20));
    if (!v.ok) throw new Error("fixture invalid");
    const outcome = await ingest(d1, "s1", v.events);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.acceptedThrough).toBe(20);
    const stored = db.prepare(`SELECT last_event_seq AS wm FROM sessions WHERE id = 's1'`).get() as { wm: number };
    expect(stored.wm).toBe(20);
    // And an overlap below the stored edge stores only the new suffix.
    const v2 = validateTelemetryBatch(batch(5, 25));
    if (!v2.ok) throw new Error("fixture invalid");
    const outcome2 = await ingest(d1, "s1", v2.events);
    expect(outcome2.kind).toBe("accepted");
    if (outcome2.kind !== "accepted") return;
    expect(outcome2.stored.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25]);
  });

  it("empty batch → duplicate success with the current watermark", async () => {
    insertSession(db, "s1");
    const outcome = await ingest(d1, "s1", []);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.duplicate).toBe(true);
    expect(outcome.acceptedThrough).toBe(-1); // nothing stored yet
  });
});
