/**
 * FR-RR-15 — typed error for scoring-plane failures (unsupported version,
 * unknown policy). Infrastructure, not an applicant denial: callers map it
 * to their operational/UNKNOWN_SCORING_POLICY fail-closed paths.
 */
export class ScoringPolicyShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoringPolicyShapeError";
  }
}
