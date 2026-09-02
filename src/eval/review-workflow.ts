/**
 * Review-workflow (evaluation plane) — reviewer calibration analysis.
 *
 * Boundary: src/core/review.ts = risk-annotation record (product);
 *   src/eval/review-workflow.ts = reviewer decision + calibration (evaluation).
 *
 * This module owns the reviewer-workflow primitives: the finalization logic
 * that turns a pending review-queue entry into a decided state, and the
 * calibration matrix that compares the reviewer's decision against
 * FireRaid's risk assessment. It does NOT re-export anything from
 * src/core/review.ts — consumers import from each module independently.
 */

import type { ReviewQueueEntry } from "../core/review.js";

export type ReviewerDecision = "approved" | "rejected";
export type ReviewStatus = "pending" | "reviewed";

export interface CalibrationRecord {
  sessionId: string;
  publicId: string;
  riskScore: number;
  riskTier: string;
  fireraidDisposition: string;
  reviewerDecision: ReviewerDecision;
  agreed: boolean;
  reviewedAt: number;
  reviewerId?: string;
  note?: string;
}

/**
 * Finalize a review-queue entry with the reviewer's decision.
 * Returns the updated entry and the calibration record for persistence.
 */
export function finalizeReview(
  entry: ReviewQueueEntry,
  reviewerDecision: ReviewerDecision,
  opts?: { reviewerId?: string; note?: string }
): { entry: ReviewQueueEntry; calibration: CalibrationRecord } {
  const reviewedAt = Date.now();
  const next: ReviewQueueEntry = {
    ...entry,
    status: "reviewed",
    reviewerDecision,
    reviewerNote: opts?.note,
    reviewedAt,
    reviewedBy: opts?.reviewerId,
  };
  const agreed =
    (entry.disposition === "ACCEPT" && reviewerDecision === "approved") ||
    ((entry.disposition === "REVIEW" || entry.disposition === "QUARANTINE") && reviewerDecision === "rejected");
  const calibration: CalibrationRecord = {
    sessionId: entry.sessionId,
    publicId: entry.publicId,
    riskScore: entry.riskScore,
    riskTier: entry.riskTier,
    fireraidDisposition: entry.disposition,
    reviewerDecision,
    agreed,
    reviewedAt,
    reviewerId: opts?.reviewerId,
    note: opts?.note,
  };
  return { entry: next, calibration };
}
