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
  SubmissionStore,
  EvidenceStore,
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
    profileKeyId?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .bind(session.id, session.createdAt, Date.now(), session.profileVersion, session.profileKeyId ?? null, session.profileId, session.profileHash)
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
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, created_at, profile_version, profile_key_id, submitted, final_score, final_disposition FROM sessions WHERE id = ?`
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
    };
  }

  async markSubmitted(sessionId: string, score: number, disposition: string): Promise<void> {
    await this.db
      .prepare(`UPDATE sessions SET submitted = 1, final_score = ?, final_disposition = ? WHERE id = ?`)
      .bind(score, disposition, sessionId)
      .run();
  }

  async touch(sessionId: string): Promise<void> {
    await this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(Date.now(), sessionId).run();
  }
}

export class D1SubmissionStore implements SubmissionStore {
  constructor(private db: D1Database) {}

  async create(record: {
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
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.sessionId,
        record.createdAt,
        record.turnstileOk ? 1 : 0,
        record.causalHits,
        record.strongHits,
        record.weakHits,
        record.riskScore,
        record.disposition,
        record.policy,
        JSON.stringify(record.reasons)
      )
      .run();
    return result.meta.last_row_id as number;
  }

  async getBySession(sessionId: string): Promise<{
    id: number;
    disposition: string;
    score: number;
    policy: string;
    reasons: string[];
  } | null> {
    const row = await this.db
      .prepare(`SELECT id, disposition, risk_score, policy, reasons_json FROM submissions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(sessionId)
      .first<{
        id: number;
        disposition: string;
        risk_score: number;
        policy: string;
        reasons_json: string;
      }>();
    if (!row) return null;
    return {
      id: row.id,
      disposition: row.disposition,
      score: row.risk_score,
      policy: row.policy,
      reasons: JSON.parse(row.reasons_json || "[]"),
    };
  }
}

export class D1EvidenceStore implements EvidenceStore {
  constructor(private db: D1Database) {}

  async create(record: {
    submissionId: number;
    evidenceClass: string;
    source: string;
    weight: number;
    verified: boolean;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO submission_evidence (submission_id, evidence_class, source, weight, verified, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(record.submissionId, record.evidenceClass, record.source, record.weight, record.verified ? 1 : 0, JSON.stringify(record.metadata))
      .run();
  }

  async getBySubmission(submissionId: number): Promise<
    Array<{
      evidenceClass: string;
      source: string;
      weight: number;
      verified: boolean;
      metadata: Record<string, unknown>;
    }>
  > {
    const rows = await this.db
      .prepare(
        `SELECT evidence_class, source, weight, verified, metadata_json FROM submission_evidence WHERE submission_id = ? ORDER BY id`
      )
      .bind(submissionId)
      .all<{
        evidence_class: string;
        source: string;
        weight: number;
        verified: number;
        metadata_json: string;
      }>();
    return rows.results.map((r) => ({
      evidenceClass: r.evidence_class,
      source: r.source,
      weight: r.weight,
      verified: r.verified === 1,
      metadata: JSON.parse(r.metadata_json || "{}"),
    }));
  }
}

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

    // Statement 2: insert submission with public_id
    const insertStmt = this.db
      .prepare(
        `INSERT INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        JSON.stringify(submission.reasons)
      );

    // Statements 3: per-evidence inserts
    const evidenceStmts = evidence.map((e) =>
      this.db.prepare(
        `INSERT INTO submission_evidence (submission_id, evidence_class, source, weight, verified, metadata_json)
         VALUES ((SELECT id FROM submissions WHERE public_id = ? LIMIT 1), ?, ?, ?, ?, ?)`
      ).bind(
        submission.publicId,
        e.evidenceClass,
        e.source,
        e.weight,
        e.verified ? 1 : 0,
        JSON.stringify(e.metadata)
      )
    );

    const stmts = [claimStmt, insertStmt, ...evidenceStmts];
    const results = await this.db.batch(stmts);

    // Statement 0 result (claim) — D1 batch returns D1Result[]
    // result.meta.changes === 1 means the conditional UPDATE matched
    const claimResult = results[0] as D1Result;
    return { claimed: (claimResult.meta?.changes as number | undefined) === 1 };
  }
}
