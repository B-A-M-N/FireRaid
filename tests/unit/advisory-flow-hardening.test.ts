/**
 * Advisory-surface hardening (P2) — real-SQLite tests over the migration
 * chain, pinning the invariants the advisory deployment depends on:
 *
 *   1. createEntry NEVER resurrects a reviewed entry (the ON CONFLICT path
 *      is guarded on status='pending') — a duplicate/raced submit cannot
 *      re-queue a case a reviewer already decided.
 *   2. updateEntry matches ONLY pending rows (row-guard) and reports the
 *      matched-row count, so a double review decision is detectable and the
 *      calibration log stays one-row-per-decision.
 *   3. The retention sweep refuses to delete a session that still has a
 *      review_queue / review_calibration row (the calibration log outlives
 *      the behavioral data it annotates).
 *   4. Risk-projection x disposition matrix over the advisory flow: the
 *      runtime disposition the boundary emits never leaks score to the
 *      applicant, and advisory ALWAYS forwards (annotation only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { D1ReviewStore } from "../../src/cloudflare/review-store.js";
import { runRetentionSweep } from "../../src/cloudflare/retention.js";
import { createReviewQueueEntry } from "../../src/core/review.js";
import { finalizeReview } from "../../src/eval/review-workflow.js";
import { projectRisk, resolveRuntimeDisposition, projectWorkflowState, getRiskTier } from "../../src/core/risk.js";
import type { DecisionRecord, Evidence } from "../../src/types/event.js";

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
      // D1's .all() returns {results: [...]}, NOT a bare array (node:sqlite
      // returns the array directly — wrap it so store code reading
      // `.results` sees the D1 shape).
      const allRows = async (...p: unknown[]) => {
        const rows = db.prepare(stmt.sql).all(...(p as never[]));
        return { results: rows, meta: { changes: 0 } } as never;
      };
      return {
        bind(...params: unknown[]) {
          stmt.params = params;
          return {
            run: async () => runStmt(stmt),
            first: async () => (db.prepare(stmt.sql).get(...(stmt.params as never[])) ?? null) as never,
            all: async () => allRows(...(stmt.params as never[])),
          };
        },
        // D1 allows .run()/.all()/.first() directly on a prepared statement
        // (calibrationStats uses bare prepare().all()).
        run: async () => runStmt(stmt),
        first: async () => (db.prepare(stmt.sql).get(...(stmt.params as never[])) ?? null) as never,
        all: async () => allRows(),
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
let store: D1ReviewStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fireraid-advisory-"));
  db = new DatabaseSync(join(dir, "test.db"));
  applyMigrations(db);
  store = new D1ReviewStore(makeD1(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Seed one session + submission (FK targets) and return their ids. */
function seedSessionAndSubmission(): { sessionId: string; publicId: string } {
  const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
     VALUES (?, 1, 1, 1, 'p', 'h', 1)`
  ).run(sessionId);
  const publicId = `pub-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy)
     VALUES (?, ?, 1, 1, 0, 0, 0, 0, 'ACCEPT', 'default-v1')`
  ).run(publicId, sessionId);
  return { sessionId, publicId };
}

function decision(score: number, disposition: "ACCEPT" | "REVIEW" | "QUARANTINE"): DecisionRecord {
  return {
    policy: "default-v1",
    signals: [],
    score,
    disposition,
    reasons: ["advisory test"],
    createdAt: Date.now(),
  };
}

function causalEvidence(): Evidence[] {
  return [{ id: "e1", class: "A", weight: 100, source: "CANARY_NONCE_REPRODUCED", verified: true }];
}

describe("review-store hardening (real SQLite, migration chain)", () => {
  it("createEntry does NOT resurrect a reviewed entry", async () => {
    const { sessionId, publicId } = seedSessionAndSubmission();
    const d = decision(150, "REVIEW");
    await store.createEntry(createReviewQueueEntry(sessionId, publicId, d, projectRisk(d.score, causalEvidence())));

    // Reviewer finalizes (the same store calls admin.ts makes).
    const entry = await store.getBySession(sessionId);
    expect(entry).not.toBeNull();
    const finalized = finalizeReview(entry!, "rejected", { reviewerId: "rev-1" });
    expect(await store.updateEntry(finalized.entry)).toBe(1);
    await store.recordCalibration(finalized.calibration);

    // A duplicated/raced submit tries to re-create the entry — the reviewed
    // state (decision, reviewer, status) must survive untouched.
    const d2 = decision(250, "QUARANTINE");
    await store.createEntry(createReviewQueueEntry(sessionId, publicId, d2, projectRisk(d2.score, causalEvidence())));

    const after = await store.getBySession(sessionId);
    expect(after!.status).toBe("reviewed");
    expect(after!.reviewerDecision).toBe("rejected");
    expect(after!.reviewedBy).toBe("rev-1");
    expect(after!.riskScore).toBe(150); // NOT overwritten by the new insert

    // And exactly ONE calibration row exists (the reviewer's, not the
    // re-submit's — the re-submit path never writes calibration at all).
    const stats = await store.calibrationStats();
    expect(stats.total).toBe(1);
    // DEFECT FIX: verified Class-A evidence now projects to CAUSAL tier
    // (was HIGH). Calibration stats reflect the corrected tier.
    expect(stats.byTier["CAUSAL"]).toEqual({ total: 1, agreed: 1 });
  });

  it("updateEntry guards on pending: second decision matches zero rows", async () => {
    const { sessionId, publicId } = seedSessionAndSubmission();
    const d = decision(210, "QUARANTINE");
    await store.createEntry(createReviewQueueEntry(sessionId, publicId, d, projectRisk(d.score, causalEvidence())));
    const entry = (await store.getBySession(sessionId))!;

    // First reviewer wins.
    const first = finalizeReview(entry, "rejected", { reviewerId: "rev-A" });
    expect(await store.updateEntry(first.entry)).toBe(1);
    await store.recordCalibration(first.calibration);

    // A replayed/concurrent decision (built from the STALE pre-review entry)
    // must match zero rows — the caller detects the conflict and skips the
    // calibration write.
    const second = finalizeReview(entry, "approved", { reviewerId: "rev-B" });
    expect(await store.updateEntry(second.entry)).toBe(0);

    // Calibration stays one-row: only rev-A's decision counted.
    const stats = await store.calibrationStats();
    expect(stats.total).toBe(1);
    expect(stats.byTier["CAUSAL"]).toEqual({ total: 1, agreed: 1 });
  });

  it("retention sweep keeps sessions that still carry review rows", async () => {
    const { sessionId, publicId } = seedSessionAndSubmission();
    const d = decision(210, "QUARANTINE");
    await store.createEntry(createReviewQueueEntry(sessionId, publicId, d, projectRisk(d.score, causalEvidence())));

    // Everything the sweep could otherwise delete is ancient.
    const sweep = await runRetentionSweep(makeD1(db), 2 /* cutoff far above created_at=1 */);
    void sweep;

    const row = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`).get(sessionId) as { n: number };
    expect(row.n).toBe(1);
    const review = db.prepare(`SELECT COUNT(*) AS n FROM review_queue WHERE session_id = ?`).get(sessionId) as { n: number };
    expect(review.n).toBe(1);
  });

  it("finalizeReview calibration matrix matches the deployment thesis", () => {
    // ACCEPT + approved = agreement; ACCEPT + rejected = miss (false negative
    // for the defense); QUARANTINE + rejected = agreement; QUARANTINE +
    // approved = false positive (the dangerous direction).
    const cases: Array<[number, "ACCEPT" | "REVIEW" | "QUARANTINE", "approved" | "rejected", boolean]> = [
      [10, "ACCEPT", "approved", true],
      [10, "ACCEPT", "rejected", false],
      [120, "REVIEW", "rejected", true],
      [120, "REVIEW", "approved", false],
      [250, "QUARANTINE", "rejected", true],
      [250, "QUARANTINE", "approved", false],
    ];
    for (const [score, disp, reviewer, agreed] of cases) {
      const d = decision(score, disp);
      const entry = createReviewQueueEntry("s", "p", d, projectRisk(score, []));
      const { calibration } = finalizeReview(entry, reviewer);
      expect(calibration.agreed).toBe(agreed);
    }
  });
});

describe("advisory boundary invariants", () => {
  it("advisory mode NEVER blocks, at every tier, and the annotation still carries the true tier", () => {
    for (const score of [0, 39, 40, 99, 100, 199, 200, 500]) {
      const tier = getRiskTier(score);
      const core = score >= 200 ? "QUARANTINE" : score >= 100 ? "REVIEW" : score >= 50 ? "REVIEW" : "ACCEPT";
      const runtime = resolveRuntimeDisposition(core as never, "advisory", tier);
      expect(runtime).toBe("ACCEPT");
      // The reviewer-facing projection keeps the REAL assessment...
      const risk = projectRisk(score, score >= 100 ? causalEvidence() : []);
      expect(risk.score).toBe(score);
      // ...while the applicant-facing projection never carries it.
      const workflow = projectWorkflowState(runtime);
      expect(JSON.stringify(workflow)).not.toContain(String(score));
      expect(workflow.status).toBe("accepted");
    }
  });

  it("review mode collapses QUARANTINE to REVIEW but keeps annotation tier", () => {
    const tier = getRiskTier(250);
    expect(resolveRuntimeDisposition("QUARANTINE", "review", tier)).toBe("REVIEW");
    const risk = projectRisk(250, causalEvidence());
    expect(risk.tier).toBe("CAUSAL");
    expect(risk.hasCausalEvidence).toBe(true);
  });

  it("enforcement mode auto-suppresses exactly the autoSuppress tiers", () => {
    for (const score of [0, 40, 100, 199]) {
      const tier = getRiskTier(score);
      expect(tier.autoSuppress).toBe(false);
      expect(resolveRuntimeDisposition("REVIEW", "enforcement", tier)).toBe("REVIEW");
    }
    const causal = getRiskTier(200);
    expect(causal.autoSuppress).toBe(true);
    expect(resolveRuntimeDisposition("REVIEW", "enforcement", causal)).toBe("QUARANTINE");
  });
});
