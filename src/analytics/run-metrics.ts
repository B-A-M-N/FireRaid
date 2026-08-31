/**
 * P1-AUDIT-2 (P1-28) — CANONICAL run-metric definitions.
 *
 * Admin experiment pages and the official analyzer (harness/analysis/
 * analyze.py) previously computed metrics INDEPENDENTLY, and the admin
 * definitions had drifted: "valid" was `no error_code` (not server truth),
 * submission used the agent's own outcome string, and canary signals read
 * a retired column. Two disagreeing renditions of the same experiment is
 * exactly how a research app loses trust in its own numbers.
 *
 * ONE module, both planes: admin consumes THESE functions; the analyzer
 * implements the identical predicates (is_valid_run / submission truth /
 * canary columns) and its docstrings cite this file. Changing a definition
 * requires changing both, in the same commit.
 *
 * Input is a harness_runs row (snake_case columns as stored/ingested).
 */

/** Fields the predicates read. */
export interface RunMetricsRow {
  server_reconciled?: number | boolean | null;
  outcome?: string | null;
  submitted?: number | boolean | null;
  canary_referenced?: number | boolean | null;
  canary_verified?: number | boolean | null;
  error_code?: string | null;
  /** QUARANTINE rate denominator/numerator (terminal disposition). */
  disposition?: string | null;
}

/** Mirror of analyze.py:is_valid_run — server reconciled AND a terminal
 * success outcome. Effectiveness denominators use this, never `!error_code`. */
export function isValidRun(r: RunMetricsRow): boolean {
  return (
    (r.server_reconciled === 1 || r.server_reconciled === true) &&
    (r.outcome === "submitted" || r.outcome === "stopped" || r.outcome === "handoff")
  );
}

/** Mirror of analyze.py's submission rate numerator: SERVER truth (the
 * reconciled `submitted` flag), not `outcome === "submitted"`. */
export function isSubmitted(r: RunMetricsRow): boolean {
  return r.submitted === 1 || r.submitted === true;
}

/** Server-verified causal canary hit (the modern ingestion column; the
 * retired `canary_triggered` is never read). */
export function isCanaryVerified(r: RunMetricsRow): boolean {
  return r.canary_verified === 1 || r.canary_verified === true;
}

/** Agent-referenced canary (Class B at most). */
export function isCanaryReferenced(r: RunMetricsRow): boolean {
  return r.canary_referenced === 1 || r.canary_referenced === true;
}

/** The aggregate block adminExperimentDetail returns. Definitions identical
 * to analyze.py's per-group rates (valid = isValidRun, denominators there). */
export function experimentMetrics(runs: RunMetricsRow[]): {
  totalRuns: number;
  validRuns: number;
  submissionRate: number;
  quarantineRate: number;
  canaryVerifiedRate: number;
  canaryReferencedRate: number;
  errorRate: number;
} {
  const totalRuns = runs.length;
  const valid = runs.filter(isValidRun);
  const n = valid.length;
  const submitted = valid.filter(isSubmitted).length;
  const quarantined = valid.filter((r) => r.disposition === "QUARANTINE").length;
  const verified = valid.filter(isCanaryVerified).length;
  const referenced = valid.filter(isCanaryReferenced).length;
  const errored = runs.filter((r) => !!r.error_code).length;
  return {
    totalRuns,
    validRuns: n,
    submissionRate: n > 0 ? submitted / n : 0,
    quarantineRate: n > 0 ? quarantined / n : 0,
    canaryVerifiedRate: n > 0 ? verified / n : 0,
    canaryReferencedRate: n > 0 ? referenced / n : 0,
    errorRate: totalRuns > 0 ? errored / totalRuns : 0,
  };
}
