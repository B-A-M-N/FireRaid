/**
 * P1-AUDIT-2 (ops) — ONE retention implementation, three callers.
 *
 * The prior tree had TWO statement lists (adminCleanup's inline deletes and
 * the scheduled sweep) that had already drifted — the admin path never got
 * the session_metrics orphan cleanup or the lab-run expiry the cron path
 * had. This module is now the single source of truth for retention SQL, and
 * both entry points (admin one-shot and cron) run the exact same sweep.
 *
 * FR-P0-01 — the sweep is a DEPENDENCY-ORDERED LIFECYCLE, not a bag of
 * independent deletes. D1 enforces the child→parent foreign keys, so a
 * parent row can only leave after every row that references it. The prior
 * statement set could not converge:
 *
 *   - session_metrics was deleted ONLY as an orphan (session already gone),
 *     while sessions required "no session_metrics row" — a deadlock; either
 *     condition waits on the other forever.
 *   - review_queue / review_calibration were NEVER swept, while blocking
 *     submission AND session deletion — a permanent pin.
 *   - lab lifecycle (expireStaleLabRuns, reconciliation) actively moves runs
 *     into EXPIRED / ABANDONED / COMPLETE, but the sweep deleted only
 *     status='PENDING' — ordinary operation manufactured rows the sweep
 *     would never remove.
 *
 * The lifecycle order below deletes children before parents, and every
 * retained-beyond-the-derived-window family has an EXPLICIT window (never
 * silently immortal):
 *
 *   1. RAW PAYLOAD          event_batches                (rawCutoff, default 7d)
 *   2. DERIVED CHILDREN     canary_hits, verification_attempts,
 *                           session_metrics (of expired sessions), orphans
 *                                                        (cutoff, default 30d)
 *   3. SUBMISSION CHILDREN  submission_evidence, review_calibration,
 *                           review_queue                 (reviewCutoff, default 90d)
 *   4. APPLICATION RECORD   submissions                  (cutoff)
 *   5. LAB RUNS             PENDING-past-expiry (cutoff);
 *                           terminal statuses            (labCutoff, default 90d)
 *   6. ROOT                 sessions                     (cutoff)
 *
 * Review and lab records are the human-calibration and experiment datasets —
 * deliberately retained LONGER than ordinary derived state (90d defaults,
 * FIRERAID_REVIEW_RETENTION_DAYS / FIRERAID_LAB_RETENTION_DAYS), but never
 * forever: their window clocks are reviewed_at (calibration rows are only
 * written on review finalization; queue rows COALESCE(reviewed_at,
 * created_at)) and COALESCE(completed_at, reconciled_at, created_at)
 * respectively.
 *
 * Bounding: the cron path passes `unbounded: false` (default) and each table
 * loses at most RETENTION_SWEEP_BATCH rows per invocation — incremental
 * work across cron ticks instead of one giant D1 transaction per table on a
 * large deployment. The admin path passes `unbounded: true` — an operator-
 * invoked cleanup is expected to complete and is not on a timer. BOTH modes
 * converge: tests/unit/retention-convergence.test.ts drives seeded
 * production-shaped databases to a fixpoint and asserts exactly what
 * remains.
 *
 * SQLite portability (proven by the real-SQLite suite): `DELETE ... LIMIT n`
 * requires SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which neither node:sqlite nor
 * workerd/D1 compile in — the statement is a syntax error there. The bounded
 * delete uses the universally-supported `WHERE rowid IN (SELECT rowid ...
 * LIMIT n)` subquery instead. LIMIT -1 inside the subquery means "no limit"
 * (SQLite's documented sentinel), which is what the unbounded path emits.
 */

/** Per-table delete cap for ONE cron sweep invocation. */
export const RETENTION_SWEEP_BATCH = 500;

/**
 * P1-AUDIT-2 (P1-10): retention policy for RAW telemetry.
 *
 * event_batches.payload_json holds the keystroke-level event stream — the
 * most sensitive data FireRaid keeps, and the only table whose contents are
 * raw behavioral recordings rather than derived state. Its functional
 * readers (submit-time aggregation, watermark replay) only serve LIVE
 * sessions (30-minute TTL), so raw payloads have no purpose beyond a short
 * window; forensic/debug value is the only reason to keep them at all.
 *
 * Policy: raw payloads get their own cutoff — RAW_TELEMETRY_RETENTION_DAYS
 * (default 7), independent of the 30-day retention applied to derived
 * records (dispositions, evidence, canary hits — which ARE the experiment's
 * durable observables). The cron handler derives it from
 * FIRERAID_RAW_TELEMETRY_RETENTION_DAYS; every other table keeps the plain
 * `cutoff`. The admin one-shot uses the same two-cutoff policy.
 */
export const RAW_TELEMETRY_RETENTION_DAYS = 7;

/**
 * FR-P0-01: explicit windows for the two retained-longer record families.
 * 90 days covers a quarterly calibration review; an operator shortens or
 * lengthens via FIRERAID_REVIEW_RETENTION_DAYS / FIRERAID_LAB_RETENTION_DAYS.
 * Neither family is immortal — the whole point of the FR-P0-01 repair.
 */
export const REVIEW_RETENTION_DAYS = 90;
export const LAB_RETENTION_DAYS = 90;

export interface RetentionSweepResult {
  telemetryBatches: number;
  canaryHits: number;
  verificationAttempts: number;
  /** session_metrics rows whose SESSION expired (the window that un-pins). */
  sessionMetrics: number;
  /** session_metrics rows whose session row is already gone (legacy safety). */
  orphanedSessionMetrics: number;
  submissionEvidence: number;
  reviewCalibration: number;
  reviewQueue: number;
  submissions: number;
  /** PENDING lab runs past their expires_at. */
  expiredLabRuns: number;
  /** Terminal lab runs (EXPIRED/ABANDONED/COMPLETE) past the lab window. */
  labRuns: number;
  abandonedSessions: number;
  finalizedSessions: number;
}

export async function runRetentionSweep(
  db: D1Database,
  cutoff: number,
  opts: {
    unbounded?: boolean;
    rawCutoff?: number;
    /** FR-P0-01: review-queue/calibration window (defaults to `cutoff`). */
    reviewCutoff?: number;
    /** FR-P0-01: terminal lab-run window (defaults to `cutoff`). */
    labCutoff?: number;
  } = {}
): Promise<RetentionSweepResult> {
  const results: RetentionSweepResult = {
    telemetryBatches: 0,
    canaryHits: 0,
    verificationAttempts: 0,
    sessionMetrics: 0,
    orphanedSessionMetrics: 0,
    submissionEvidence: 0,
    reviewCalibration: 0,
    reviewQueue: 0,
    submissions: 0,
    expiredLabRuns: 0,
    labRuns: 0,
    abandonedSessions: 0,
    finalizedSessions: 0,
  };
  const limit = opts.unbounded ? -1 : RETENTION_SWEEP_BATCH;
  // P1-10: the raw-telemetry cutoff defaults to the plain cutoff when a
  // caller doesn't pass one (back-compat for tests/ops that only track one
  // clock), but the scheduled + admin paths always derive it. Same shape for
  // the FR-P0-01 review/lab windows.
  const rawCutoff = opts.rawCutoff ?? cutoff;
  const reviewCutoff = opts.reviewCutoff ?? cutoff;
  const labCutoff = opts.labCutoff ?? cutoff;
  // LIMIT -1 = no limit (SQLite sentinel). The admin path keeps its
  // delete-everything-eligible semantics through the same code path.
  const boundedWhere = (table: string, where: string) =>
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${limit})`;
  const count = async (sql: string, ...params: unknown[]) =>
    (await db.prepare(sql).bind(...params).run()).meta?.changes ?? 0;

  // ── 1. RAW PAYLOAD ─────────────────────────────────────────────────────
  // P1-10: raw payloads expire on the SHORT raw-telemetry cutoff; every
  // other table keeps its own window.
  results.telemetryBatches = await count(
    boundedWhere("event_batches", "created_at < ?"),
    rawCutoff
  );

  // ── 2. DERIVED CHILDREN of sessions ────────────────────────────────────
  results.canaryHits = await count(
    boundedWhere("canary_hits", "created_at < ?"),
    cutoff
  );
  results.verificationAttempts = await count(
    boundedWhere("verification_attempts", "created_at < ?"),
    cutoff
  );
  // FR-P0-01 deadlock repair: a session's compact metrics row expires WITH
  // the session (same cutoff), BEFORE the session sweep — the metrics row
  // must never outlive its session's eligibility, and the session must not
  // wait on a row this same sweep could have removed first. The orphan pass
  // below remains as legacy-row safety, not as the primary path.
  results.sessionMetrics = await count(
    boundedWhere(
      "session_metrics",
      "session_id IN (SELECT id FROM sessions WHERE created_at < ?)"
    ),
    cutoff
  );
  results.orphanedSessionMetrics = await count(
    boundedWhere("session_metrics", "session_id NOT IN (SELECT id FROM sessions)")
  );

  // ── 3. SUBMISSION CHILDREN (evidence + review records) ─────────────────
  results.submissionEvidence = await count(
    boundedWhere(
      "submission_evidence",
      `submission_id IN (SELECT id FROM submissions WHERE created_at < ?)`
    ),
    cutoff
  );
  // FR-P0-01: the review dataset is retained on its OWN (longer) window —
  // the review clock is when the review happened, or creation for entries
  // still pending. Neither table was swept before; both pinned their
  // submission AND session forever.
  results.reviewCalibration = await count(
    boundedWhere("review_calibration", "reviewed_at < ?"),
    reviewCutoff
  );
  results.reviewQueue = await count(
    boundedWhere("review_queue", "COALESCE(reviewed_at, created_at) < ?"),
    reviewCutoff
  );

  // ── 4. APPLICATION RECORD ──────────────────────────────────────────────
  // A submission is deletable only when nothing references it: evidence
  // (FK on submissions.id), review rows (FK on submissions.public_id —
  // both tables). NOT EXISTS, not NOT IN: public_id is TEXT while id is
  // INTEGER, and a NOT IN across mismatched types never excludes anything.
  results.submissions = await count(
    boundedWhere(
      "submissions",
      `created_at < ?
       AND NOT EXISTS (SELECT 1 FROM submission_evidence WHERE submission_id = submissions.id)
       AND NOT EXISTS (SELECT 1 FROM review_queue WHERE public_id = submissions.public_id)
       AND NOT EXISTS (SELECT 1 FROM review_calibration WHERE public_id = submissions.public_id)`
    ),
    cutoff
  );

  // ── 5. LAB RUNS ────────────────────────────────────────────────────────
  // PENDING runs past expiry are garbage (never bound) — derived-cutoff
  // clock, as before. Terminal runs (EXPIRED/ABANDONED/COMPLETE — states the
  // lab lifecycle itself manufactures) live out the explicit LAB window from
  // their last activity, then leave; they no longer pin their session
  // forever. BOUND runs are deliberately NOT age-deleted: a live BOUND run
  // is mid-experiment, and a stale one is moved to ABANDONED by
  // expireStaleLabRuns within 24h — after which this window reclaims it.
  // Bounded AND convergent (convergence tests pin the BOUND path).
  results.expiredLabRuns = await count(
    boundedWhere("lab_runs", `status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < ?`),
    cutoff
  );
  results.labRuns = await count(
    boundedWhere(
      "lab_runs",
      `status IN ('EXPIRED','ABANDONED','COMPLETE')
       AND COALESCE(completed_at, reconciled_at, created_at) < ?`
    ),
    labCutoff
  );

  // ── 6. ROOT ────────────────────────────────────────────────────────────
  // Session deletes are FK-guarded: D1 enforces the child references, and
  // under a per-table CAP a session's children may not all be gone yet (the
  // cap cut the child sweep short). A session is only deletable when NO
  // child rows remain anywhere; capped-out parents simply stay until a
  // later cron pass — bounded AND convergent. (FR-P0-01: review_calibration
  // joined review_queue in the guard — both FK-pin sessions.)
  const noChildren = `NOT EXISTS (SELECT 1 FROM event_batches WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM canary_hits WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM verification_attempts WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM submissions WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM session_metrics WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM lab_runs WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM review_queue WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM review_calibration WHERE session_id = sessions.id)`;
  results.abandonedSessions = await count(
    boundedWhere(
      "sessions",
      `created_at < ? AND submitted = 0 AND id NOT IN (SELECT session_id FROM submissions) AND ${noChildren}`
    ),
    cutoff
  );
  results.finalizedSessions = await count(
    boundedWhere("sessions", `created_at < ? AND submitted = 1 AND ${noChildren}`),
    cutoff
  );

  return results;
}
