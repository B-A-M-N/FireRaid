/**
 * Storage interfaces (FR-R3-085).
 * D1 becomes one implementation. Other backends can implement these.
 */
export interface SessionStore {
  create(session: {
    id: string;
    createdAt: number;
    profileVersion: number;
    profileId: string;
    profileHash: string;
    /** FR-R4-077/FR-P0-18: REQUIRED — rotation-safe reconstruction. */
    profileKeyId: string;
  }): Promise<void>;

  load(sessionId: string): Promise<{
    id: string;
    createdAt: number;
    profileVersion: number;
    profileKeyId: string | null;
    /** Numeric submitted (0 = unsubmitted, 1 = submitted). Compatible with SessionPayload. */
    submitted: number | undefined;
    finalScore: number | null;
    finalDisposition: string | null;
  } | null>;

  markSubmitted(
    sessionId: string,
    score: number,
    disposition: string
  ): Promise<void>;

  touch(sessionId: string): Promise<void>;
}

export interface SubmissionStore {
  create(record: {
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
  }): Promise<number>;

  getBySession(sessionId: string): Promise<{
    id: number;
    disposition: string;
    score: number;
    policy: string;
    reasons: string[];
  } | null>;
}

export interface EvidenceStore {
  create(record: {
    submissionId: number;
    evidenceClass: string;
    source: string;
    weight: number;
    verified: boolean;
    metadata: Record<string, unknown>;
  }): Promise<void>;

  getBySubmission(submissionId: number): Promise<
    Array<{
      evidenceClass: string;
      source: string;
      weight: number;
      verified: boolean;
      metadata: Record<string, unknown>;
    }>
  >;
}

/**
 * FR-R5-031: Transaction-level submission finalizer.
 * Single env.DB.batch call that:
 *   1. Conditional UPDATE sessions SET submitted=1 WHERE id=? AND submitted=0
 *   2. INSERT submissions with public_id
 *   3. Per-evidence INSERT into submission_evidence via SELECT id FROM submissions
 *      WHERE public_id=? subselect (mirrors submit.ts proven SQL).
 */
export interface SubmissionFinalizer {
  finalizeSubmission(params: {
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
      /** FR-P0-16: provider name (e.g. "turnstile"), or "none" when unset. */
      verificationProvider: string;
    };
    evidence: Array<{
      evidenceClass: string;
      source: string;
      weight: number;
      verified: boolean;
      metadata: Record<string, unknown>;
    }>;
  }): Promise<{ claimed: boolean }>;
}

export interface EvidenceBatchStore {
  create(record: {
    sessionId: string;
    createdAt: number;
    firstSeq: number;
    lastSeq: number;
    eventCount: number;
    payload: string;
  }): Promise<void>;

  getBySession(sessionId: string): Promise<
    Array<{
      payload: string;
    }>
  >;
}
