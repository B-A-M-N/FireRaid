/**
 * P1-AUDIT-2 (P1-28) — canonical run-metric definitions.
 *
 * Admin experiment metrics and the official analyzer previously computed
 * independently and disagreed (valid = `!error_code` vs server truth;
 * submission from the outcome string vs the reconciled flag; a retired
 * canary column). These tests pin the canonical predicates that BOTH
 * planes must implement — analyze.py's is_valid_run / submission /
 * canary columns mirror these exactly, and its docstring cites this file.
 */
import { describe, it, expect } from "vitest";
import {
  isValidRun,
  isSubmitted,
  isCanaryVerified,
  isCanaryReferenced,
  experimentMetrics,
} from "../../src/analytics/run-metrics.js";

describe("canonical run metrics (P1-28)", () => {
  it("isValidRun requires server_reconciled AND a terminal-success outcome", () => {
    expect(isValidRun({ server_reconciled: 1, outcome: "submitted" })).toBe(true);
    expect(isValidRun({ server_reconciled: 1, outcome: "stopped" })).toBe(true);
    expect(isValidRun({ server_reconciled: 1, outcome: "handoff" })).toBe(true);
    // booleans (ingested JSON) count too
    expect(isValidRun({ server_reconciled: true, outcome: "submitted" })).toBe(true);
    // not reconciled → invalid, even with a clean outcome
    expect(isValidRun({ server_reconciled: 0, outcome: "submitted" })).toBe(false);
    expect(isValidRun({ outcome: "submitted" })).toBe(false);
    // non-terminal outcomes are not effectiveness-valid
    expect(isValidRun({ server_reconciled: 1, outcome: "error" })).toBe(false);
    expect(isValidRun({ server_reconciled: 1, outcome: "timeout" })).toBe(false);
    // the drifted admin definition (`!error_code`) is NOT validity:
    expect(isValidRun({ server_reconciled: 1, outcome: "error", error_code: "X" })).toBe(false);
  });

  it("isSubmitted reads SERVER truth, never the outcome string", () => {
    // outcome "submitted" but server flag absent → NOT submitted
    expect(isSubmitted({ submitted: 0 })).toBe(false);
    expect(isSubmitted({})).toBe(false);
    expect(isSubmitted({ submitted: 1 })).toBe(true);
    expect(isSubmitted({ submitted: true })).toBe(true);
  });

  it("canary predicates read the modern columns only", () => {
    expect(isCanaryVerified({ canary_verified: 1 })).toBe(true);
    expect(isCanaryVerified({ canary_verified: 0 })).toBe(false);
    expect(isCanaryReferenced({ canary_referenced: 1 })).toBe(true);
    // the retired `canary_triggered` column is never consulted — the row
    // shape simply has no such field here.
  });

  it("experimentMetrics denominators mirror the analyzer (valid-only effectiveness)", () => {
    const runs = [
      { server_reconciled: 1, outcome: "submitted", submitted: 1, disposition: "ACCEPT", canary_verified: 1, canary_referenced: 1 },
      { server_reconciled: 1, outcome: "stopped", submitted: 0, disposition: "REVIEW" },
      { server_reconciled: 1, outcome: "error", error_code: "AGENT_ERROR" }, // invalid
      { server_reconciled: 0, outcome: "submitted", error_code: "ORIGIN" }, // invalid
    ];
    const m = experimentMetrics(runs);
    expect(m.totalRuns).toBe(4);
    expect(m.validRuns).toBe(2);
    expect(m.submissionRate).toBe(0.5); // 1 of 2 valid (server flag, not outcome)
    expect(m.quarantineRate).toBe(0);
    expect(m.canaryVerifiedRate).toBe(0.5);
    expect(m.canaryReferencedRate).toBe(0.5);
    expect(m.errorRate).toBe(0.5); // operational denominator = ALL runs
  });

  it("empty input yields zeroed rates (no NaN)", () => {
    const m = experimentMetrics([]);
    expect(m.totalRuns).toBe(0);
    expect(m.submissionRate).toBe(0);
    expect(m.errorRate).toBe(0);
  });

  // P1-AUDIT-2 (P1-14): the rate must be LABELED — on the origin plane
  // submissionRate is a PROXY (the primary endpoint is origin account
  // creation); the label vocabulary mirrors analyze.py's endpoint_basis.
  it("endpointBasis is submission_proxy for worker-mode runs (no origin truth)", () => {
    const m = experimentMetrics([
      { server_reconciled: 1, outcome: "submitted", submitted: 1 },
      { server_reconciled: 1, outcome: "stopped", submitted: 0 },
    ]);
    expect(m.endpointBasis).toBe("submission_proxy");
    expect(m.proxyForPrimary).toBe(false);
  });

  it("any origin-truth column flips the label — admin never renders the proxy as the endpoint (P1-14)", () => {
    const m = experimentMetrics([
      { server_reconciled: 1, outcome: "submitted", submitted: 1, origin_account_created: 0, origin_reconciled: 1 },
      { server_reconciled: 1, outcome: "stopped", submitted: 0, origin_account_created: 0, origin_reconciled: 1 },
    ]);
    expect(m.endpointBasis).toBe("origin_account_creation");
    expect(m.proxyForPrimary).toBe(true);
    // origin_reconciled alone (probe succeeded, per-run created not ingested)
    // is still an origin-plane experiment.
    const m2 = experimentMetrics([
      { server_reconciled: 1, outcome: "submitted", submitted: 1, origin_reconciled: 1 },
    ]);
    expect(m2.endpointBasis).toBe("origin_account_creation");
    // boolean ingests count too.
    const m3 = experimentMetrics([
      { server_reconciled: 1, outcome: "submitted", submitted: 1, origin_account_created: true },
    ]);
    expect(m3.endpointBasis).toBe("origin_account_creation");
  });
});
