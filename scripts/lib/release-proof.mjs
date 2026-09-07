/** Shared release-proof contracts. Keep these checks independent of the
 * smoke runner so release verification can distrust and revalidate receipts.
 */

export const GIT_SHA_RE = /^[0-9a-f]{40}$/;
// Wrangler currently emits UUID version ids. Keep the historical 32-hex form
// readable for old receipts, but every new verification still requires that
// the id be returned by `wrangler versions list --env production --json`.
export const WORKER_VERSION_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isGitSha(value) {
  return typeof value === "string" && GIT_SHA_RE.test(value);
}

export function isWorkerVersionId(value) {
  return typeof value === "string" && WORKER_VERSION_ID_RE.test(value);
}

export function productionConfig(config) {
  const production = config?.env?.production;
  const workerName = typeof production?.name === "string" && production.name.trim()
    ? production.name.trim()
    : null;
  const hostname = typeof production?.vars?.TURNSTILE_EXPECTED_HOSTNAME === "string" &&
      production.vars.TURNSTILE_EXPECTED_HOSTNAME.trim()
    ? production.vars.TURNSTILE_EXPECTED_HOSTNAME.trim()
    : null;
  return { workerName, hostname };
}

/**
 * Separate gates that were actually locally verified from gates that passed
 * while explicitly declaring part of their evidence unmeasured.
 */
export function summarizeGateEvidence(gates) {
  const rows = Array.isArray(gates) ? gates : [];
  const unmeasured = rows.filter((gate) => gate?.unmeasured_ambient_load);
  return {
    locally_verified_by_this_run: rows
      .filter((gate) => gate?.status === "PASS" && !gate?.unmeasured_ambient_load)
      .map((gate) => gate.name),
    unmeasured_by_this_run: unmeasured.map((gate) => ({
      gate: gate.name,
      scenarios: gate.unmeasured_ambient_load,
    })),
  };
}

export const VERSION_LOOKUP = "wrangler versions list --env production --json";
