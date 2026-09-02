/**
 * P1-AUDIT-2 (audit item 12b): substituted-run exclusion.
 *
 * Runs where the serving model != the requested official model must NEVER
 * count toward primary efficacy estimates. This module verifies:
 *   1. isSubstitutedRun (harness-side, from run-schema)
 *   2. isSubstitutedRun (analytics-side, from run-metrics)
 *   3. experimentMetrics excludes substituted and reports a substituted count
 */
import { describe, it, expect } from "vitest";
import { isSubstitutedRun as isSubstitutedRunSchema } from "../../harness/core/run-schema.js";
import {
  isSubstitutedRun as isSubstitutedRunAnalytics,
  experimentMetrics,
} from "../../src/analytics/run-metrics.js";

describe("isSubstitutedRun (run-schema)", () => {
  it("true when modelServed differs from modelRequested", () => {
    expect(
      isSubstitutedRunSchema({
        llm_model_served: "served-model:7b",
        llm_model_requested: "requested-model:free",
      })
    ).toBe(true);
  });

  it("true when poolProvider set AND poolMode is substitute", () => {
    expect(
      isSubstitutedRunSchema({
        llm_pool_provider: "pool:provider-1",
        pool_mode: "substitute",
      })
    ).toBe(true);
  });

  it("false for a clean run (served === requested, no pool)", () => {
    expect(
      isSubstitutedRunSchema({
        llm_model_served: "gpt-4",
        llm_model_requested: "gpt-4",
      })
    ).toBe(false);
  });

  it("false when modelServed differs but no poolProvider and not substitute mode", () => {
    // Condition (a) still applies: served !== requested is substitution
    expect(
      isSubstitutedRunSchema({
        llm_model_served: "alias-model",
        llm_model_requested: "canonical-model",
        pool_mode: "same-model",
      })
    ).toBe(true);
  });

  it("false when poolProvider present but poolMode is same-model (no substitution)", () => {
    expect(
      isSubstitutedRunSchema({
        llm_pool_provider: "pool:provider-1",
        pool_mode: "same-model",
      })
    ).toBe(false);
  });

  it("false when all fields are absent", () => {
    expect(
      isSubstitutedRunSchema({})
    ).toBe(false);
  });

  it("false when modelServed === modelRequested (exact match)", () => {
    expect(
      isSubstitutedRunSchema({
        llm_model_served: "claude-3.5",
        llm_model_requested: "claude-3.5",
      })
    ).toBe(false);
  });

  it("true when poolProvider present, pool_mode=substitute, even if served===requested", () => {
    expect(
      isSubstitutedRunSchema({
        llm_model_served: "gpt-4",
        llm_model_requested: "gpt-4",
        llm_pool_provider: "pool:rotated-1",
        pool_mode: "substitute",
      })
    ).toBe(true);
  });
});

describe("isSubstitutedRun (analytics)", () => {
  it("true when modelServed != modelRequested", () => {
    expect(
      isSubstitutedRunAnalytics({
        llm_model_served: "served-backend/alias-9b",
        llm_model_requested: "requested/model:free",
      })
    ).toBe(true);
  });

  it("true when poolProvider set + poolMode substitute", () => {
    expect(
      isSubstitutedRunAnalytics({
        llm_pool_provider: "pool:provider-1",
        pool_mode: "substitute",
      })
    ).toBe(true);
  });

  it("false for a clean run", () => {
    expect(
      isSubstitutedRunAnalytics({
        llm_model_served: "gpt-4",
        llm_model_requested: "gpt-4",
      })
    ).toBe(false);
  });
});

describe("experimentMetrics excludes substituted (analytics)", () => {
  it("headline efficacy over non-substituted runs only, reports substituted count", () => {
    const runs = [
      // Clean run 1 — valid and submitted
      {
        server_reconciled: true,
        outcome: "submitted",
        submitted: true,
        disposition: "ACCEPT",
        canary_verified: true,
        canary_referenced: true,
      } as const,
      // Clean run 2 — valid but stopped
      {
        server_reconciled: true,
        outcome: "stopped",
        submitted: false,
        disposition: "REVIEW",
        canary_verified: false,
        canary_referenced: false,
      } as const,
      // Substituted run — should be excluded from efficacy
      {
        server_reconciled: true,
        outcome: "submitted",
        submitted: true,
        disposition: "ACCEPT",
        llm_model_served: "alias-model",
        llm_model_requested: "canonical-model",
        llm_pool_provider: undefined,
        pool_mode: "same-model",
      } as const,
    ];

    const m = experimentMetrics(runs);

    // Headline: 2 valid (the clean runs), NOT 3
    expect(m.validRuns).toBe(2);
    // Total attempts still counts all runs
    expect(m.totalRuns).toBe(3);
    // Substituted count is 1
    expect(m.substitutedRuns).toBe(1);
    // Submission rate: 1 of 2 valid were submitted = 0.5
    expect(m.submissionRate).toBe(0.5);
    // Canary verified: only run 1 has it, so 1/2 = 0.5
    expect(m.canaryVerifiedRate).toBe(0.5);
    // Error rate: 0 errors over 3 total = 0
    expect(m.errorRate).toBe(0);
  });

  it("all runs substituted yields zeroed rates", () => {
    const runs = [
      {
        server_reconciled: true,
        outcome: "submitted",
        submitted: true,
        llm_model_served: "alias",
        llm_model_requested: "canonical",
      } as const,
    ];

    const m = experimentMetrics(runs);
    expect(m.totalRuns).toBe(1);
    expect(m.validRuns).toBe(0);
    expect(m.substitutedRuns).toBe(1);
    expect(m.submissionRate).toBe(0);
  });

  it("pool substitute mode also triggers exclusion", () => {
    const runs = [
      {
        server_reconciled: true,
        outcome: "submitted",
        submitted: true,
        llm_pool_provider: "pool:rotated-1",
        pool_mode: "substitute",
      } as const,
      {
        server_reconciled: true,
        outcome: "stopped",
        submitted: false,
      } as const,
    ];

    const m = experimentMetrics(runs);
    // First run excluded (pool substitute), second is valid
    expect(m.validRuns).toBe(1);
    expect(m.substitutedRuns).toBe(1);
    expect(m.submissionRate).toBe(0); // the valid run was stopped, not submitted
  });
});
