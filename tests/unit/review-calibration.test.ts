/**
 * Review-queue + calibration record tests.
 *
 * NOTE: finalizeReview moved to src/eval/review-workflow.ts (evaluation plane).
 *   src/core/review.ts = risk-annotation record (product);
 *   src/eval/review-workflow.ts = reviewer decision + calibration (evaluation).
 */
import { describe, it, expect } from "vitest";
import * as coreReview from "../../src/core/review.js";
import { createReviewQueueEntry } from "../../src/core/review.js";
import { finalizeReview } from "../../src/eval/review-workflow.js";
import { projectRisk } from "../../src/core/risk.js";
import type { DecisionRecord } from "../../src/types/event.js";

function decision(score: number, disposition: "ACCEPT" | "REVIEW" | "QUARANTINE"): DecisionRecord {
  return {
    policy: "default-v1",
    signals: [],
    score,
    disposition,
    reasons: ["test"],
    createdAt: Date.now(),
  };
}

describe("review queue entry", () => {
  it("records core decision and risk tier", () => {
    const d = decision(120, "REVIEW");
    const risk = projectRisk(d.score, d.signals);
    const entry = createReviewQueueEntry("sid-1", "pub-1", d, risk);
    expect(entry.sessionId).toBe("sid-1");
    expect(entry.publicId).toBe("pub-1");
    expect(entry.riskScore).toBe(120);
    expect(entry.riskTier).toBe("HIGH");
    expect(entry.status).toBe("pending");
  });
});

describe("finalize review", () => {
  it("agrees when reviewer matches FireRaid ACCEPT with approved", () => {
    const d = decision(10, "ACCEPT");
    const entry = createReviewQueueEntry("sid", "pub", d, projectRisk(d.score, d.signals));
    const { calibration } = finalizeReview(entry, "approved");
    expect(calibration.agreed).toBe(true);
    expect(calibration.reviewerDecision).toBe("approved");
  });

  it("agrees when reviewer rejects a QUARANTINE", () => {
    const d = decision(250, "QUARANTINE");
    const entry = createReviewQueueEntry("sid", "pub", d, projectRisk(d.score, d.signals));
    const { calibration } = finalizeReview(entry, "rejected");
    expect(calibration.agreed).toBe(true);
  });

  it("disagrees when reviewer approves a QUARANTINE", () => {
    const d = decision(250, "QUARANTINE");
    const entry = createReviewQueueEntry("sid", "pub", d, projectRisk(d.score, d.signals));
    const { calibration } = finalizeReview(entry, "approved");
    expect(calibration.agreed).toBe(false);
  });

  it("updates entry to reviewed status with reviewer metadata", () => {
    const d = decision(250, "QUARANTINE");
    const entry = createReviewQueueEntry("sid", "pub", d, projectRisk(d.score, d.signals));
    const { entry: updated } = finalizeReview(entry, "rejected", { reviewerId: "admin-1", note: "looks bot" });
    expect(updated.status).toBe("reviewed");
    expect(updated.reviewerDecision).toBe("rejected");
    expect(updated.reviewedBy).toBe("admin-1");
    expect(updated.reviewerNote).toBe("looks bot");
  });
});

describe("product/eval separation", () => {
  it("createReviewQueueEntry import from core/review.js succeeds", () => {
    // The core module still exports createReviewQueueEntry (product plane).
    expect(typeof createReviewQueueEntry).toBe("function");
  });

  it("finalizeReview NOT re-exported from core/review.js", () => {
    // Verify the core module's static exports do not include finalizeReview.
    expect((coreReview as Record<string, unknown>).finalizeReview).toBeUndefined();
  });
});
