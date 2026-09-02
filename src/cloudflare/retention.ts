/**
 * P1-AUDIT-2 (ops) — ONE retention implementation, three callers.
 *
 * The prior tree had TWO statement lists (adminCleanup's inline deletes and
 * the scheduled sweep) that had already drifted — the admin path never got
 * the session_metrics orphan cleanup or the lab-run expiry the cron path
 * had. This module is now the single source of truth for retention SQL, and
 * both entry points (admin one-shot and cron) run the exact same sweep.
 *
 * Bounding: the cron path passes `unbounded: false` (default) and each table
 * loses at most RETENTION_SWEEP_BATCH rows per invocation — incremental
 * work across cron ticks instead of one giant D1 transaction per table on a
 * large deployment. The admin path passes `unbounded: true` — an operator-
 * invoked cleanup is expected to complete and is not on a timer.
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

export interface RetentionSweepResult {
  telemetryBatches: number;
  canaryHits: number;
  verificationAttempts: number;
  submissionEvidence: number;
  submissions: number;
  abandonedSessions: number;
  finalizedSessions: number;
  sessionMetrics: number;
  expiredLabRuns: number;
}

export async function runRetentionSweep(
  db: D1Database,
  cutoff: number,
  opts: { unbounded?: boolean; rawCutoff?: number } = {}
): Promise<RetentionSweepResult> {
  const results: RetentionSweepResult = {
    telemetryBatches: 0,
    canaryHits: 0,
    verificationAttempts: 0,
    submissionEvidence: 0,
    submissions: 0,
    abandonedSessions: 0,
    finalizedSessions: 0,
    sessionMetrics: 0,
    expiredLabRuns: 0,
  };
  const limit = opts.unbounded ? -1 : RETENTION_SWEEP_BATCH;
  // P1-10: the raw-telemetry cutoff defaults to the plain cutoff when a
  // caller doesn't pass one (back-compat for tests/ops that only track one
  // clock), but the scheduled + admin paths always derive it.
  const rawCutoff = opts.rawCutoff ?? cutoff;
  // LIMIT -1 = no limit (SQLite sentinel). The admin path keeps its
  // delete-everything-eligible semantics through the same code path.
  const boundedWhere = (table: string, where: string) =>
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${limit})`;

  // P1-10: raw payloads expire on the SHORT raw-telemetry cutoff; every
  // other table keeps the plain cutoff.
  const r1 = await db
    .prepare(boundedWhere("event_batches", "created_at < ?"))
    .bind(rawCutoff)
    .run();
  results.telemetryBatches = r1.meta?.changes ?? 0;
  const r2 = await db
    .prepare(boundedWhere("canary_hits", "created_at < ?"))
    .bind(cutoff)
    .run();
  results.canaryHits = r2.meta?.changes ?? 0;
  const r3 = await db
    .prepare(boundedWhere("verification_attempts", "created_at < ?"))
    .bind(cutoff)
    .run();
  results.verificationAttempts = r3.meta?.changes ?? 0;
  const r4 = await db
    .prepare(
      boundedWhere(
        "submission_evidence",
        `submission_id IN (SELECT id FROM submissions WHERE created_at < ?)`
      )
    )
    .bind(cutoff)
    .run();
  results.submissionEvidence = r4.meta?.changes ?? 0;
  // A submission is deletable only when nothing references it: evidence
  // (FK on submissions.id) and review rows (FK on submissions.public_id —
  // review-queue entries pin their submission until the entry itself is
  // swept). NOT EXISTS, not NOT IN: public_id is TEXT while id is INTEGER,
  // and a NOT IN across mismatched types never excludes anything.
  const r5 = await db
    .prepare(
      boundedWhere(
        "submissions",
        `created_at < ?
         AND NOT EXISTS (SELECT 1 FROM submission_evidence WHERE submission_id = submissions.id)
         AND NOT EXISTS (SELECT 1 FROM review_queue WHERE public_id = submissions.public_id)`
      )
    )
    .bind(cutoff)
    .run();
  results.submissions = r5.meta?.changes ?? 0;
  // Session deletes are FK-guarded: D1 enforces the child references, and
  // under a per-table CAP a session's children may not all be gone yet (the
  // cap cut the child sweep short). A session is only deletable when NO
  // child rows remain anywhere; capped-out parents simply stay until a
  // later cron pass — bounded AND convergent.
  const noChildren = `NOT EXISTS (SELECT 1 FROM event_batches WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM canary_hits WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM verification_attempts WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM submissions WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM session_metrics WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM lab_runs WHERE session_id = sessions.id)
       AND NOT EXISTS (SELECT 1 FROM review_queue WHERE session_id = sessions.id)`;
  const r6 = await db
    .prepare(
      boundedWhere(
        "sessions",
        `created_at < ? AND submitted = 0 AND id NOT IN (SELECT session_id FROM submissions) AND ${noChildren}`
      )
    )
    .bind(cutoff)
    .run();
  results.abandonedSessions = r6.meta?.changes ?? 0;
  const r7 = await db
    .prepare(boundedWhere("sessions", `created_at < ? AND submitted = 1 AND ${noChildren}`))
    .bind(cutoff)
    .run();
  results.finalizedSessions = r7.meta?.changes ?? 0;
  // FR-R7-022: drop compact metrics rows for sessions whose parent session
  // row has been pruned — orphaned rows would otherwise accumulate.
  const r8 = await db
    .prepare(
      boundedWhere("session_metrics", `session_id NOT IN (SELECT id FROM sessions)`)
    )
    .run();
  results.sessionMetrics = r8.meta?.changes ?? 0;
  // Lab runs PENDING past expiry can be pruned; BOUND/COMPLETE runs past
  // their expires_at keep created_at + retention cutoff to remain auditable.
  const r9 = await db
    .prepare(
      boundedWhere("lab_runs", `status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < ?`)
    )
    .bind(cutoff)
    .run();
  results.expiredLabRuns = r9.meta?.changes ?? 0;

  return results;
}
