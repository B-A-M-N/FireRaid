/**
 * Admin route barrel — FR-RR-01 plane split.
 *
 * The former monolithic admin.ts mixed product-plane reads (sessions,
 * review queue, cleanup) with evaluation-plane analytics (experiments,
 * harness-run export, lab-aware session detail). That mixture is what let
 * the production Worker's artifact reach lab-only tables while /readyz
 * certified a product-only schema contract.
 *
 * Consumers must import the PLANE they serve:
 *   - src/worker-production.ts → ./admin/auth.js + ./admin/product.js only.
 *   - src/index.ts (lab)       → the full barrel (this file).
 *
 * Import direction: evaluation → product is legal; product → evaluation is
 * a boundary violation (enforced by scripts/check-production-graph.mjs for
 * the production entrypoint and scripts/check-product-boundary.mjs).
 */
export {
  adminLogin,
  adminLogout,
  MAX_LOGIN_TRACKED_IPS,
  LOGIN_SWEEP_INTERVAL_MS,
  pruneLoginAttempts,
  loginAttemptTrackerSizeForTest,
} from "./auth.js";
export {
  adminSummary,
  adminSessions,
  adminSessionDetail,
  adminExportSessions,
  adminCleanup,
  adminReviewQueue,
  buildSessionDetail,
  escapeCsv,
} from "./product.js";
export {
  adminExperiments,
  adminExperimentDetail,
  adminExportRuns,
  adminLabSessionDetail,
} from "./evaluation.js";
