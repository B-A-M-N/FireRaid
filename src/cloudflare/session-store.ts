/**
 * D1-backed session store (FR-R3-084).
 * Cloudflare-specific implementation of storage interfaces.
 * FIX: persists profile_key_id for rotation (FR-R4-077).
 *
 * FR-R5-030: This class is the single source of D1 SQL for session CRUD.
 * core/session.ts delegates here, keeping route imports intact.
 */
import type {
  SessionStore,
  SubmissionFinalizer,
} from "../core/storage.js";

export class D1SessionStore implements SessionStore {
  constructor(private db: D1Database) {}

  async create(session: {
    id: string;
    createdAt: number;
    profileVersion: number;
    profileId: string;
    profileHash: string;
    // FR-P0-18: REQUIRED. A session persisted without its issuing key id
    // reconstructs under the CURRENT key after rotation — silently mutating
    // the defense profile issued to a real user. Fail the insert instead.
    profileKeyId: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .bind(session.id, session.createdAt, Date.now(), session.profileVersion, session.profileKeyId, session.profileId, session.profileHash)
      .run();
  }

  async load(sessionId: string): Promise<{
    id: string;
    createdAt: number;
    profileVersion: number;
    profileKeyId: string | null;
    /** Numeric submitted (0 = unsubmitted, 1 = submitted). Compatible with SessionPayload. */
    submitted: number | undefined;
    finalScore: number | null;
    finalDisposition: string | null;
    /** P1-9: verified canary-route hit compacted onto the session row. */
    causalRouteHit: number | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, created_at, profile_version, profile_key_id, submitted, final_score, final_disposition, causal_route_hit FROM sessions WHERE id = ?`
      )
      .bind(sessionId)
      .first<{
        id: string;
        created_at: number;
        profile_version: number;
        profile_key_id: string | null;
        submitted: number;
        final_score: number | null;
        final_disposition: string | null;
        causal_route_hit: number | null;
      }>();
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      profileVersion: row.profile_version,
      profileKeyId: row.profile_key_id,
      submitted: row.submitted,
      finalScore: row.final_score,
      finalDisposition: row.final_disposition,
      causalRouteHit: row.causal_route_hit,
    };
  }

  async markSubmitted(sessionId: string, score: number, disposition: string): Promise<void> {
    await this.db
      .prepare(`UPDATE sessions SET submitted = 1, final_score = ?, final_disposition = ? WHERE id = ?`)
      .bind(score, disposition, sessionId)
      .run();
  }

  /**
   * P1-9: compact causal-hit state. Set ONCE when a verified decoy-route
   * hit lands (never cleared). Submit reads the flag from the session row
   * it loads anyway instead of paying a per-submit canary_hits COUNT.
   */
  async markCausalRouteHit(sessionId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE sessions SET causal_route_hit = 1 WHERE id = ?`)
      .bind(sessionId)
      .run();
  }

  async touch(sessionId: string): Promise<void> {
    await this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(Date.now(), sessionId).run();
  }
}

// P1-AUDIT-2 (P1-27): the dead D1SubmissionStore / D1EvidenceStore classes
// are REMOVED — zero callers, drifted from the finalizer semantics/provider
// fields, and exactly how storage semantics diverge later. Submission +
// evidence persistence lives ONLY in D1SubmissionFinalizer below (and the
// admin/ingest read paths).
/**
 * FR-R5-031: Transaction-level submission finalizer.
 *
 * Performs a single env.DB.batch with three statements:
 *   1. Conditional UPDATE sessions SET submitted=1 WHERE id=? AND submitted=0
 *      (returns {claimed: true} if 1 row changed, false otherwise)
 *   2. INSERT submissions (with public_id)
 *   3. Per-evidence INSERT into submission_evidence via SELECT id FROM
 *      submissions WHERE public_id=? subselect (mirrors submit.ts proven SQL).
 */
export class D1SubmissionFinalizer implements SubmissionFinalizer {
  constructor(private db: D1Database) {}

  async finalizeSubmission({
    sessionClaim,
    submission,
    evidence,
  }: {
    sessionClaim: {
      sessionId: string;
      score: number;
      disposition: string;
    };
    submission: {
      publicId: string;
      sessionId: string;
      createdAt: number;
      turnstileOk: boolean;
      causalHits: number;
      strongHits: number;
      weakHits: number;
      riskScore: number;
      disposition: string;
      policy: string;
      reasons: string[];
      // FR-P0-16: which verification provider adjudicated (e.g. "turnstile",
      // "none" when no provider is configured). Disambiguates turnstile_ok.
      verificationProvider: string;
    };
    evidence: Array<{
      evidenceClass: string;
      source: string;
      weight: number;
      verified: boolean;
      metadata: Record<string, unknown>;
    }>;
  }): Promise<{ claimed: boolean }> {
    // Statement 1: conditional session claim
    const claimStmt = this.db
      .prepare(
        `UPDATE sessions SET submitted = 1, final_score = ?, final_disposition = ? WHERE id = ? AND submitted = 0`
      )
      .bind(sessionClaim.score, sessionClaim.disposition, sessionClaim.sessionId);

    // P1-AUDIT-2 (P1-26): the loser of the session claim must never die on
    // the UNIQUE(session_id) index — with a plain INSERT, the second batch
    // of a concurrent pair throws a constraint error instead of reaching
    // the claimed===false projection. OR IGNORE + the subselect-based
    // evidence inserts make the whole batch idempotent: the loser's row is
    // not written, its public_id matches nothing, and ZERO evidence rows
    // attach to the winner's submission.
    const insertStmt = this.db
      .prepare(
        `INSERT OR IGNORE INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, verification_provider, reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        submission.publicId,
        submission.sessionId,
        submission.createdAt,
        submission.turnstileOk ? 1 : 0,
        submission.causalHits,
        submission.strongHits,
        submission.weakHits,
        submission.riskScore,
        submission.disposition,
        submission.policy,
        submission.verificationProvider,
        JSON.stringify(submission.reasons)
      );

    // Statements 3: per-evidence inserts — the AUDIT-PRESCRIBED form
    // (INSERT ... SELECT ... WHERE public_id = ?): a raced loser's
    // public_id matches no row, the SELECT yields ZERO rows, and the
    // insert writes nothing (a VALUES((SELECT …)) subselect would instead
    // produce one row with a NULL submission_id and die on NOT NULL).
    // The (submission, class, source, weight:verified) fingerprint +
    // ON CONFLICT DO NOTHING makes an EXACT replay of the batch idempotent
    // too (migration 0013) — the same evidence lands exactly once however
    // often the finalize replays.
    const evidenceStmts = evidence.map((e) => {
      const fingerprint = `${e.weight}:${e.verified}`;
      return this.db
        .prepare(
          `INSERT INTO submission_evidence (submission_id, evidence_class, source, weight, verified, weight_verified, metadata_json)
           SELECT id, ?, ?, ?, ?, ?, ? FROM submissions WHERE public_id = ?
           ON CONFLICT (submission_id, evidence_class, source, weight_verified) DO NOTHING`
        )
        .bind(
          e.evidenceClass,
          e.source,
          e.weight,
          e.verified ? 1 : 0,
          fingerprint,
          JSON.stringify(e.metadata),
          submission.publicId
        );
    });

    const stmts = [claimStmt, insertStmt, ...evidenceStmts];
    const results = await this.db.batch(stmts);

    // Statement 0 result (claim) — D1 batch returns D1Result[]
    // result.meta.changes === 1 means the conditional UPDATE matched
    const claimResult = results[0] as D1Result;
    return { claimed: (claimResult.meta?.changes as number | undefined) === 1 };
  }
}
