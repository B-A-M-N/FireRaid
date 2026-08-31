/**
 * P1-AUDIT-2 (P1-26) — D1SubmissionFinalizer concurrent-loser semantics,
 * on REAL SQLite.
 *
 * The audit's defect: a plain INSERT into submissions breaks on the
 * UNIQUE(session_id) index when the second batch of a concurrent pair
 * loses the conditional session claim — the constraint error escapes the
 * batch instead of the loser reaching the claimed===false projection. The
 * fix (OR IGNORE + subselect evidence inserts) makes the whole batch
 * idempotent: the loser writes nothing, evidence included.
 *
 * These tests drive the REAL finalizer against node:sqlite with D1-shaped
 * wrappers, including true statement-level interleaving modeled by
 * batching order (D1 executes batch statements sequentially and
 * atomically per call; two CONCURRENT calls may interleave at the SQLite
 * layer — the same contract node:sqlite exhibits when driven serially
 * here: whichever call lands second must observe the winner's state).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { D1SubmissionFinalizer } from "../../src/cloudflare/session-store.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  // Schema mirrors migrations 0001 + 0002 (the unique index is the point).
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      submitted INTEGER NOT NULL DEFAULT 0,
      final_score INTEGER,
      final_disposition TEXT
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      turnstile_ok INTEGER NOT NULL,
      causal_hits INTEGER NOT NULL,
      strong_hits INTEGER NOT NULL,
      weak_hits INTEGER NOT NULL,
      risk_score INTEGER NOT NULL,
      disposition TEXT NOT NULL,
      policy TEXT,
      reasons_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    ALTER TABLE submissions ADD COLUMN verification_provider TEXT;
    CREATE UNIQUE INDEX idx_submissions_session_unique ON submissions(session_id);
    CREATE UNIQUE INDEX idx_submissions_public_id ON submissions(public_id);
    CREATE TABLE submission_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      evidence_class TEXT NOT NULL,
      source TEXT NOT NULL,
      weight INTEGER NOT NULL,
      verified INTEGER NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY(submission_id) REFERENCES submissions(id)
    );
    -- Migration 0013: evidence replay fingerprint.
    ALTER TABLE submission_evidence ADD COLUMN weight_verified TEXT;
    CREATE UNIQUE INDEX idx_evidence_fingerprint
      ON submission_evidence(submission_id, evidence_class, source, weight_verified);
  `);
  return db;
}

/** D1-shaped wrapper with REAL change counts. */
function makeWrappers(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              const res = db.prepare(sql).run(...(args as never[]));
              return { meta: { changes: Number(res.changes) } };
            },
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

function finalizeParams(sessionId: string, publicId: string, disposition = "REVIEW") {
  return {
    sessionClaim: { sessionId, score: 60, disposition },
    submission: {
      publicId,
      sessionId,
      createdAt: Date.now(),
      turnstileOk: false,
      causalHits: 0,
      strongHits: 1,
      weakHits: 1,
      riskScore: 60,
      disposition,
      policy: "default-v1",
      reasons: ["test"],
      verificationProvider: "none",
    },
    evidence: [
      { evidenceClass: "B", source: "DECOY_FIELD_POPULATED", weight: 60, verified: true, metadata: {} },
      { evidenceClass: "C", source: "DIRECT_FILL_PATTERN", weight: 15, verified: false, metadata: {} },
    ],
  };
}

describe("D1SubmissionFinalizer concurrency (P1-26)", () => {
  it("first finalize claims the session and writes submission + evidence", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('s1')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));

    const { claimed } = await f.finalizeSubmission(finalizeParams("s1", "pub-1"));
    expect(claimed).toBe(true);

    const sub = db.prepare(`SELECT public_id, disposition FROM submissions WHERE session_id='s1'`).get() as { public_id: string; disposition: string };
    expect(sub.public_id).toBe("pub-1");
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM submission_evidence`).get() as { n: number };
    expect(ev.n).toBe(2);
  });

  it("concurrent loser: constraint-free loss — second batch does NOT throw, writes NOTHING", async () => {
    // The audit's exact defect shape: winner goes first, loser's batch runs
    // with an already-claimed session AND an already-used session_id.
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('race')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));

    const winner = await f.finalizeSubmission(finalizeParams("race", "pub-winner"));
    expect(winner.claimed).toBe(true);

    // Loser arrives with its own public_id but the same session.
    const loser = await f.finalizeSubmission(finalizeParams("race", "pub-loser"));
    expect(loser.claimed).toBe(false); // the projection the route relies on

    // Nothing from the loser landed.
    const subs = db.prepare(`SELECT public_id FROM submissions`).all() as { public_id: string }[];
    expect(subs).toHaveLength(1);
    expect(subs[0].public_id).toBe("pub-winner");
    // And the subselect evidence inserts attached NOTHING to the winner.
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM submission_evidence`).get() as { n: number };
    expect(ev.n).toBe(2); // winner's two rows only — loser's found no public_id
  });

  it("loser ordering: loser batch FIRST is impossible (claim would succeed) — but a full double-finalize replays cleanly", async () => {
    // Idempotent replay: same public_id twice → second is a no-op that
    // reports claimed=false and does not duplicate evidence.
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('replay')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));

    await f.finalizeSubmission(finalizeParams("replay", "pub-r"));
    const second = await f.finalizeSubmission(finalizeParams("replay", "pub-r"));
    expect(second.claimed).toBe(false);

    const subs = db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get() as { n: number };
    expect(subs.n).toBe(1);
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM submission_evidence`).get() as { n: number };
    expect(ev.n).toBe(2);
  });

  it("loser evidence NEVER attaches to the winner's submission row", async () => {
    // Directly pin the subselect semantics the audit prescribed.
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('ev')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));

    await f.finalizeSubmission(finalizeParams("ev", "pub-a", "REVIEW"));
    await f.finalizeSubmission(finalizeParams("ev", "pub-b", "QUARANTINE"));

    const rows = db.prepare(
      `SELECT s.disposition, e.source FROM submissions s
       LEFT JOIN submission_evidence e ON e.submission_id = s.id`
    ).all() as { disposition: string; source: string | null }[];
    expect(rows).toHaveLength(2); // winner + its evidence rows only
    expect(rows.every((r) => r.disposition === "REVIEW")).toBe(true);
    expect(rows.filter((r) => r.source === "DECOY_FIELD_POPULATED")).toHaveLength(1);
    expect(rows.filter((r) => r.source === "DIRECT_FILL_PATTERN")).toHaveLength(1);
  });

  it("EXACT replay of the same finalize batch does not double-append evidence (migration 0013 fingerprint)", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('fp')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));
    const params = finalizeParams("fp", "pub-fp");

    await f.finalizeSubmission(params);
    await f.finalizeSubmission(params);
    await f.finalizeSubmission(params);

    const ev = db.prepare(`SELECT COUNT(*) AS n FROM submission_evidence`).get() as { n: number };
    expect(ev.n).toBe(2); // exactly once, however many replays
  });

  it("distinguishable evidence (different source) still lands side by side", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id) VALUES ('multi')`).run();
    const f = new D1SubmissionFinalizer(makeWrappers(db));
    const p = finalizeParams("multi", "pub-multi");
    p.evidence = [
      { evidenceClass: "C", source: "DIRECT_FILL_PATTERN", weight: 15, verified: false, metadata: {} },
      { evidenceClass: "C", source: "SHORT_COMPLETION", weight: 10, verified: false, metadata: {} },
    ];

    await f.finalizeSubmission(p);
    const sources = db.prepare(`SELECT source FROM submission_evidence ORDER BY id`).all() as { source: string }[];
    expect(sources.map((r) => r.source)).toEqual(["DIRECT_FILL_PATTERN", "SHORT_COMPLETION"]);
  });
});
