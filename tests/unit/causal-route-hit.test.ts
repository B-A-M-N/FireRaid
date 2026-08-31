/**
 * P1-AUDIT-2 (P1-9) — compact production causal-hit state.
 *
 * The verified canary-route hit is persisted TWICE at hit time, atomically:
 * the canary_hits row (the evidence log) and sessions.causal_route_hit = 1
 * (the compact boolean submit reads). Submit therefore pays ZERO extra D1
 * round-trips for canary correlation; the flag arrives via the session
 * SELECT it performs anyway. Only legacy rows (flag NULL, sessions that
 * predate migration 0014) fall back to a canary_hits EXISTS probe.
 *
 * These tests drive persistVerifiedHit + the submit projection against
 * node:sqlite with D1-shaped wrappers (same harness as
 * submission-finalizer.test.ts).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { persistVerifiedHit } from "../../src/routes/canary.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  // Schema mirrors migrations 0001 + 0003 + 0014.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      causal_route_hit INTEGER
    );
    CREATE TABLE canary_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      family TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      expected_hash TEXT NOT NULL,
      observed_hash TEXT NOT NULL,
      verified INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_canary_dedup
      ON canary_hits(session_id, family, expected_hash);
  `);
  return db;
}

/** D1-shaped wrapper (batch = sequential statements, real persistence). */
function makeWrappers(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => db.prepare(sql).run(...(args as never[])),
            first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
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

describe("compact causal-hit state (P1-9)", () => {
  it("a verified hit sets sessions.causal_route_hit=1 in the same batch", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('s1')`).run();
    const ok = await persistVerifiedHit(makeWrappers(db), "s1", "tok", "tok", Date.now());
    expect(ok).toBe(true);

    const flag = db.prepare(`SELECT causal_route_hit AS f FROM sessions WHERE id='s1'`).get() as { f: number };
    expect(flag.f).toBe(1);
    const hits = db.prepare(`SELECT COUNT(*) AS n FROM canary_hits WHERE verified=1`).get() as { n: number };
    expect(hits.n).toBe(1);
  });

  it("an idempotent replay keeps the flag set and does not duplicate hits", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('s2')`).run();
    const w = makeWrappers(db);
    await persistVerifiedHit(w, "s2", "tok", "tok", Date.now());
    await persistVerifiedHit(w, "s2", "tok", "tok", Date.now());

    const hits = db.prepare(`SELECT COUNT(*) AS n FROM canary_hits`).get() as { n: number };
    expect(hits.n).toBe(1);
    const flag = db.prepare(`SELECT causal_route_hit AS f FROM sessions WHERE id='s2'`).get() as { f: number };
    expect(flag.f).toBe(1);
  });

  it("a session WITHOUT a hit keeps the flag NULL (submit's legacy fallback domain)", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('s3')`).run();
    // No hit at all.
    const flag = db.prepare(`SELECT causal_route_hit AS f FROM sessions WHERE id='s3'`).get() as { f: number | null };
    expect(flag.f).toBeNull();
  });

  it("legacy backfill shape: verified hits mark sessions, unverified do not", () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('legacy-hit'), ('legacy-clean')`).run();
    // A verified hit and an unverified one (pre-0014 history).
    db.prepare(
      `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES ('legacy-hit', 0, 'decoy-route', 'A', 'e', 'o', 1), ('legacy-clean', 0, 'decoy-route', 'A', 'e2', 'o2', 0)`
    ).run();
    // The migration's backfill statement, verbatim.
    db.exec(`
      UPDATE sessions
         SET causal_route_hit = 1
       WHERE causal_route_hit IS NULL
         AND id IN (SELECT session_id FROM canary_hits WHERE verified = 1);
    `);
    const rows = db.prepare(`SELECT id, causal_route_hit AS f FROM sessions ORDER BY id`).all() as { id: string; f: number | null }[];
    expect(rows.find((r) => r.id === "legacy-hit")!.f).toBe(1);
    expect(rows.find((r) => r.id === "legacy-clean")!.f).toBeNull();
  });
});
