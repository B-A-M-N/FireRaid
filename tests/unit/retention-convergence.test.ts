/**
 * FR-P0-01 — retention CONVERGENCE tests.
 *
 * The retention-sweep suite (retention-sweep.test.ts) pins per-table
 * bounding and cutoff discipline. These tests pin the property the audit
 * found broken: the sweep is a LIFECYCLE — run repeatedly against a
 * production-shaped database, it must reach a fixpoint where exactly the
 * rows still inside their windows remain, with no mutual-dependency
 * deadlock (session ↔ session_metrics), no permanently-pinned review rows,
 * and no immortal terminal lab statuses.
 *
 * Real SQLite (node:sqlite) over the real migration chain — FK enforcement
 * and change-count semantics are exactly what D1 runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetentionSweep, type RetentionSweepResult } from "../../src/cloudflare/retention.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

type BatchStmt = { run: () => Promise<{ meta: { changes: number } }> };

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
            first: async () => (db.prepare(stmt.sql).get(...(stmt.params as never[])) ?? null) as never,
          };
        },
        run: async () => runStmt(stmt),
      };
    },
    async batch(statements: BatchStmt[]) {
      const out: { meta: { changes: number } }[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fireraid-conv-"));
  db = new DatabaseSync(join(dir, "test.db"));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ─── Seed helpers (production-shaped) ─────────────────────────────────────

const ANCIENT = 1; // far below any cutoff used here
const FRESH = 1_000_000; // far above any cutoff used here

function seedSession(id: string, opts: { createdAt?: number; submitted?: 0 | 1 } = {}): void {
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
     VALUES (?, ?, ?, 1, 'p', 'h', ?)`
  ).run(id, opts.createdAt ?? ANCIENT, opts.createdAt ?? ANCIENT, opts.submitted ?? 0);
}

function seedMetrics(sessionId: string, createdAt = ANCIENT): void {
  db.prepare(
    `INSERT INTO session_metrics (session_id, created_at, updated_at) VALUES (?, ?, ?)`
  ).run(sessionId, createdAt, createdAt);
}

function seedSubmission(sessionId: string, opts: { createdAt?: number; publicId?: string } = {}): string {
  const publicId = opts.publicId ?? `pub-${sessionId}`;
  db.prepare(
    `INSERT INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy)
     VALUES (?, ?, ?, 1, 0, 0, 0, 0, 'ACCEPT', 'default-v1')`
  ).run(publicId, sessionId, opts.createdAt ?? ANCIENT);
  return publicId;
}

function seedEvidence(sessionId: string): void {
  db.prepare(
    `INSERT INTO submission_evidence (submission_id, evidence_class, source, weight, verified)
     SELECT id, 'A', 'CANARY_NONCE_REPRODUCED', 100, 1 FROM submissions WHERE session_id = ?`
  ).run(sessionId);
}

function seedReviewEntry(sessionId: string, publicId: string, opts: { status?: "pending" | "reviewed"; createdAt?: number } = {}): void {
  db.prepare(
    `INSERT INTO review_queue (session_id, public_id, created_at, risk_score, risk_tier, disposition, policy, reasons_json, status, reviewed_at)
     VALUES (?, ?, ?, 10, 'LOW', 'ACCEPT', 'default-v1', '[]', ?, ?)`
  ).run(sessionId, publicId, opts.createdAt ?? ANCIENT, opts.status ?? "pending", opts.status === "reviewed" ? ANCIENT : null);
}

function seedCalibration(sessionId: string, publicId: string): void {
  db.prepare(
    `INSERT INTO review_calibration (session_id, public_id, risk_score, risk_tier, fireraid_disposition, reviewer_decision, agreed, reviewed_at)
     VALUES (?, ?, 10, 'LOW', 'ACCEPT', 'rejected', 0, ?)`
  ).run(sessionId, publicId, ANCIENT);
}

function seedLabRun(id: string, status: string, opts: { sessionId?: string; createdAt?: number; expiresAt?: number | null; completedAt?: number | null } = {}): void {
  db.prepare(
    `INSERT INTO lab_runs (id, session_id, status, created_at, expires_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, opts.sessionId ?? null, status, opts.createdAt ?? ANCIENT, opts.expiresAt ?? null, opts.completedAt ?? null);
}

function seedBatches(sessionId: string, n: number, createdAt = ANCIENT): void {
  const ins = db.prepare(
    `INSERT INTO event_batches (session_id, first_seq, last_seq, event_count, payload_json, created_at)
     VALUES (?, ?, ?, 1, '[]', ?)`
  );
  for (let i = 0; i < n; i++) ins.run(sessionId, i + 1, i + 1, createdAt);
}

function seedCanaryHit(sessionId: string): void {
  db.prepare(
    `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, verified)
     VALUES (?, ?, 'semantic', 'A', 1)`
  ).run(sessionId, ANCIENT);
}

function seedVerificationAttempt(sessionId: string): void {
  db.prepare(
    `INSERT INTO verification_attempts (session_id, created_at, provider, result)
     VALUES (?, ?, 'turnstile', 'success')`
  ).run(sessionId, ANCIENT);
}

function counts(): Record<string, number> {
  const tables = [
    "sessions", "event_batches", "canary_hits", "verification_attempts",
    "session_metrics", "submissions", "submission_evidence",
    "review_queue", "review_calibration", "lab_runs",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}

/** Drive bounded sweeps until nothing changes; return the final deleting pass. */
async function sweepToFixpoint(
  opts: Parameters<typeof runRetentionSweep>[2] = {},
  maxPasses = 20
): Promise<RetentionSweepResult> {
  const d1 = makeD1(db);
  let total: RetentionSweepResult | null = null;
  let passes = 0;
  for (;;) {
    const r = await runRetentionSweep(d1, 500_000 /* between ANCIENT and FRESH */, opts);
    passes++;
    if (
      total &&
      r.telemetryBatches + r.canaryHits + r.verificationAttempts +
        r.sessionMetrics + r.orphanedSessionMetrics + r.submissionEvidence +
        r.reviewCalibration + r.reviewQueue + r.submissions +
        r.expiredLabRuns + r.labRuns + r.abandonedSessions + r.finalizedSessions === 0
    ) {
      return total!;
    }
    total = r;
    expect(passes, "sweep did not converge within the pass budget").toBeLessThanOrEqual(maxPasses);
  }
}

// ─── The FR-P0-01 deadlock, directly ──────────────────────────────────────

describe("FR-P0-01 convergence", () => {
  it("a submitted session with compact metrics converges (the audit's deadlock shape)", async () => {
    // The exact deadlock seed: session + session_metrics (no deadlock-breaker
    // orphan pass can ever run, because metrics deleted only as orphans and
    // sessions required no metrics).
    seedSession("deadlocked", { submitted: 1 });
    seedMetrics("deadlocked");
    seedBatches("deadlocked", 2);

    await sweepToFixpoint();

    // EVERYTHING leaves: batches on the raw clock, metrics WITH their
    // session (the repair), then the session itself.
    expect(counts()).toEqual({
      sessions: 0,
      event_batches: 0,
      canary_hits: 0,
      verification_attempts: 0,
      session_metrics: 0,
      submissions: 0,
      submission_evidence: 0,
      review_queue: 0,
      review_calibration: 0,
      lab_runs: 0,
    });
  });

  it("the full submitted production shape (metrics + submission + evidence + review + calibration) converges to empty once every window closes", async () => {
    seedSession("full", { submitted: 1 });
    seedMetrics("full");
    seedBatches("full", 3);
    seedCanaryHit("full");
    seedVerificationAttempt("full");
    const publicId = seedSubmission("full");
    seedEvidence("full");
    seedReviewEntry("full", publicId, { status: "reviewed", createdAt: FRESH });
    db.prepare(`UPDATE review_queue SET reviewed_at = ? WHERE public_id = ?`).run(FRESH, publicId);
    seedCalibration("full", publicId);
    db.prepare(`UPDATE review_calibration SET reviewed_at = ? WHERE public_id = ?`).run(FRESH, publicId);

    // All windows open (review rows clocked at FRESH, far inside the 500k
    // default review cutoff): the first fixpoint keeps the review-pinned
    // spine…
    await sweepToFixpoint();
    const c = counts();
    expect(c.sessions).toBe(1);
    expect(c.submissions).toBe(1);
    expect(c.review_queue).toBe(1);
    expect(c.review_calibration).toBe(1);
    // …while everything else expired (raw payloads, metrics, evidence…).
    expect(c.event_batches).toBe(0);
    expect(c.session_metrics).toBe(0);
    expect(c.submission_evidence).toBe(0);
    expect(c.canary_hits).toBe(0);
    expect(c.verification_attempts).toBe(0);

    // Close the review window (reviewCutoff past the rows' FRESH clock) —
    // the review rows leave, un-pinning submission and session.
    const d1 = makeD1(db);
    let passes = 0;
    for (;;) {
      const r = await runRetentionSweep(d1, 500_000, { reviewCutoff: 2_000_000 });
      const moved = r.reviewCalibration + r.reviewQueue + r.submissions + r.abandonedSessions + r.finalizedSessions;
      passes++;
      if (moved === 0) break;
      expect(passes).toBeLessThanOrEqual(20);
    }
    expect(counts()).toEqual({
      sessions: 0, event_batches: 0, canary_hits: 0, verification_attempts: 0,
      session_metrics: 0, submissions: 0, submission_evidence: 0,
      review_queue: 0, review_calibration: 0, lab_runs: 0,
    });
  });

  it("a pending review row expires on the review clock (COALESCE → created_at)", async () => {
    seedSession("pending", { submitted: 1 });
    const publicId = seedSubmission("pending");
    seedReviewEntry("pending", publicId, { status: "pending" }); // never reviewed

    await sweepToFixpoint();

    // reviewCutoff defaults to the derived cutoff here — the never-reviewed
    // entry expires by creation time, and its session follows.
    expect(counts().review_queue).toBe(0);
    expect(counts().sessions).toBe(0);
  });

  it("a fresh session (inside every window) survives repeated sweeps", async () => {
    seedSession("fresh", { createdAt: FRESH, submitted: 1 });
    seedMetrics("fresh", FRESH);
    seedBatches("fresh", 1, FRESH);
    const publicId = seedSubmission("fresh", { createdAt: FRESH });
    seedEvidence("fresh");
    seedReviewEntry("fresh", publicId, { status: "pending", createdAt: FRESH });

    await sweepToFixpoint();

    const c = counts();
    expect(c.sessions).toBe(1);
    expect(c.submissions).toBe(1);
    expect(c.session_metrics).toBe(1);
    expect(c.event_batches).toBe(1);
    expect(c.review_queue).toBe(1);
    expect(c.submission_evidence).toBe(1);
  });
});

// ─── Lab-run lifecycle statuses ────────────────────────────────────────────

describe("FR-P0-01 lab-run convergence", () => {
  it("every terminal lab status (EXPIRED/ABANDONED/COMPLETE) is eventually reclaimed", async () => {
    seedLabRun("lr-exp", "EXPIRED");
    seedLabRun("lr-abn", "ABANDONED");
    seedLabRun("lr-cmp", "COMPLETE", { completedAt: ANCIENT });
    // PENDING past expiry is garbage on the derived clock.
    seedLabRun("lr-pnd", "PENDING", { expiresAt: ANCIENT });

    await sweepToFixpoint();

    expect(counts().lab_runs).toBe(0);
  });

  it("a BOUND run is never age-deleted (live experiment) but a stale one becomes ABANDONED and then leaves", async () => {
    // Live BOUND run far inside every window.
    seedLabRun("lr-live", "BOUND", { createdAt: FRESH });

    await sweepToFixpoint();
    expect(counts().lab_runs).toBe(1);

    // Simulate expireStaleLabRuns (24h stale BOUND → ABANDONED — the lab
    // lifecycle owns this transition; the sweep never touches BOUND). The
    // abandoned run's activity clock stays created_at=FRESH, so the lab
    // window must close before it leaves — pass labCutoff past FRESH.
    db.prepare(
      `UPDATE lab_runs SET status = 'ABANDONED', terminal_reason = 'abandoned_bound' WHERE id = 'lr-live'`
    ).run();

    await sweepToFixpoint({ labCutoff: 2_000_000 });
    expect(counts().lab_runs).toBe(0);
  });

  it("a terminal lab run no longer pins its session past the derived window", async () => {
    seedSession("lab-sess");
    seedLabRun("lr-pin", "ABANDONED", { sessionId: "lab-sess" });

    await sweepToFixpoint();

    expect(counts().lab_runs).toBe(0);
    expect(counts().sessions).toBe(0);
  });
});

// ─── Result accounting: every lifecycle-controlled table is counted ───────

describe("FR-P0-01 sweep accounting", () => {
  it("RetentionSweepResult counts every lifecycle-controlled table", async () => {
    seedSession("acct-1");
    seedBatches("acct-1", 1);
    seedCanaryHit("acct-1");
    seedVerificationAttempt("acct-1");
    seedMetrics("acct-1");
    seedLabRun("lr-a", "EXPIRED");

    const r = await runRetentionSweep(makeD1(db), 500_000);

    expect(r.telemetryBatches).toBe(1);
    expect(r.canaryHits).toBe(1);
    expect(r.verificationAttempts).toBe(1);
    expect(r.sessionMetrics).toBe(1);
    expect(r.labRuns).toBe(1);
    expect(r.abandonedSessions).toBe(1);
    // Nothing left behind that wasn't counted.
    const c = counts();
    expect(c.sessions + c.event_batches + c.canary_hits + c.verification_attempts + c.session_metrics + c.lab_runs).toBe(0);
  });

  it("orphaned session_metrics (legacy rows) are still reclaimed", async () => {
    // A metrics row whose session is ALREADY gone — the pre-FR-P0-01 sweep
    // could only ever remove this shape; keep that property pinned.
    db.prepare(
      `INSERT INTO session_metrics (session_id, created_at, updated_at) VALUES ('ghost', ?, ?)`
    ).run(ANCIENT, ANCIENT);

    const r = await runRetentionSweep(makeD1(db), 500_000);
    expect(r.orphanedSessionMetrics).toBe(1);
    expect(counts().session_metrics).toBe(0);
  });
});
