/**
 * Review-queue (product plane) — risk-annotation record.
 *
 * Boundary: src/core/review.ts = risk-annotation record (product);
 *   src/eval/review-workflow.ts = reviewer decision + calibration (evaluation).
 *
 * This module owns the risk-annotation contract: createReviewQueueEntry
 * produces the record that the submit route persists, and the shared types
 * used by D1ReviewStore. The reviewer-workflow primitives (finalizeReview,
 * ReviewerDecision, calibration logic) live in src/eval/review-workflow.ts.
 */

import type { DecisionRecord } from "../types/event.js";
import type { RiskProjection } from "./risk.js";

// ── Shared types (consumed by review-store and eval module) ──────────────

export type ReviewStatus = "pending" | "reviewed";

export interface ReviewQueueEntry {
  sessionId: string;
  publicId: string;
  createdAt: number;
  riskScore: number;
  riskTier: string;
  disposition: string;
  policy: string;
  reasons: string[];
  status: ReviewStatus;
  reviewerDecision?: string; // "approved" | "rejected" — typed by eval module
  reviewerNote?: string;
  reviewedAt?: number;
  reviewedBy?: string;
}

// ── Entry factory ────────────────────────────────────────────────────────

export function createReviewQueueEntry(
  sessionId: string,
  publicId: string,
  decision: DecisionRecord,
  risk: RiskProjection
): ReviewQueueEntry {
  return {
    sessionId,
    publicId,
    createdAt: Date.now(),
    riskScore: risk.score,
    riskTier: risk.tier,
    disposition: decision.disposition,
    policy: decision.policy,
    reasons: decision.reasons,
    status: "pending",
  };
}
