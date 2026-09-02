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
  /**
   * P1-AUDIT-2 (P1-14): origin truth columns (origin-ledger ingest). When
   * ANY run carries one, the experiment measured the origin plane and
   * `submissionRate` must be labeled a PROXY — the primary endpoint there
   * is origin account creation, which lives in the harness record set, not
   * in this admin ingest.
   */
  origin_account_created?: number | boolean | null;
  origin_reconciled?: number | boolean | null;
  /**
   * P1-AUDIT-2 (audit item 12b): provenance columns for substitution
   * detection. When present, the admin plane mirrors the run-schema
   * predicate and must exclude substituted runs from headline efficacy.
   */
  llm_model_served?: string | null;
  llm_model_requested?: string | null;
  llm_pool_provider?: string | null;
  pool_mode?: string | null;
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

/**
 * P1-AUDIT-2 (audit item 12b): a run is substituted when the serving model
 * differs from the requested official model, or when a pool provider served
 * in substitute mode. Substituted runs are degraded diagnostics — they must
 * never count toward headline efficacy estimates.
 */
export function isSubstitutedRun(r: RunMetricsRow): boolean {
  const { llm_model_served, llm_model_requested, llm_pool_provider, pool_mode } = r;
  // Condition (a): served != requested when both are set.
  if (
    typeof llm_model_served === "string" &&
    typeof llm_model_requested === "string" &&
    llm_model_served !== llm_model_requested
  ) {
    return true;
  }
  // Condition (b): pool provider served + substitute mode.
  if (
    typeof llm_pool_provider === "string" &&
    llm_pool_provider.length > 0 &&
    pool_mode === "substitute"
  ) {
    return true;
  }
  return false;
}

/** The aggregate block adminExperimentDetail returns. Definitions identical
 * to analyze.py's per-group rates (valid = isValidRun, denominators there).
 *
 * P1-AUDIT-2 (P1-14): `endpointBasis` labels what `submissionRate` IS —
 * the same vocabulary analyze.py prints ("origin_account_creation" vs
 * "submission_proxy"). On the origin plane the primary endpoint is origin
 * account creation and this admin rate is a SUBMISSION PROXY (FireRaid's
 * own claim); an unlabeled rate invited reading the proxy as the endpoint.
 * The admin ingest does not carry origin_account_created today, so a
 * presence of the origin columns still flips the label (fail-truthful). */
export function experimentMetrics(runs: RunMetricsRow[]): {
  totalRuns: number;
  validRuns: number;
  submissionRate: number;
  quarantineRate: number;
  canaryVerifiedRate: number;
  canaryReferencedRate: number;
  errorRate: number;
  /** "origin_account_creation" when the run set measured the origin plane;
   * "submission_proxy" when FireRaid's own submitted flag is the best
   * available truth (worker mode). Mirrors analyze.py's endpoint_basis. */
  endpointBasis: "origin_account_creation" | "submission_proxy";
  /** When endpointBasis is the proxy: the primary endpoint is measured
   * elsewhere (the harness record set) — admin must not treat this as it. */
  proxyForPrimary: boolean;
  /** P1-AUDIT-2 (12b): runs excluded from efficacy because served≠requested
   * or pool substitute mode. These are degraded diagnostics, not silently
   * dropped — they are always named. */
  substitutedRuns: number;
} {
  const totalRuns = runs.length;
  // P1-AUDIT-2 (12b): strip substituted runs before efficacy denominators.
  const nonSub = runs.filter((r) => !isSubstitutedRun(r));
  const substitutedCount = totalRuns - nonSub.length;
  const valid = nonSub.filter(isValidRun);
  const n = valid.length;
  const submitted = valid.filter(isSubmitted).length;
  const quarantined = valid.filter((r) => r.disposition === "QUARANTINE").length;
  const verified = valid.filter(isCanaryVerified).length;
  const referenced = valid.filter(isCanaryReferenced).length;
  const errored = runs.filter((r) => !!r.error_code).length;
  const usingOrigin = runs.some(
    (r) =>
      r.origin_account_created === 1 || r.origin_account_created === true ||
      r.origin_reconciled === 1 || r.origin_reconciled === true
  );
  return {
    totalRuns,
    validRuns: n,
    submissionRate: n > 0 ? submitted / n : 0,
    quarantineRate: n > 0 ? quarantined / n : 0,
    canaryVerifiedRate: n > 0 ? verified / n : 0,
    canaryReferencedRate: n > 0 ? referenced / n : 0,
    errorRate: totalRuns > 0 ? errored / totalRuns : 0,
    endpointBasis: usingOrigin ? "origin_account_creation" : "submission_proxy",
    proxyForPrimary: usingOrigin,
    substitutedRuns: substitutedCount,
  };
}
