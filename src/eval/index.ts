/**
 * Evaluation barrel — the intentional evaluation entry point (P0-1).
 *
 * The ONLY eval-plane file the product ships (see
 * scripts/check-product-boundary.mjs: evaluation-middleware is the single
 * eval entry, and it must stay free of harness/Cloudflare/AI imports).
 * A deployment that never imports this module cannot reach a lab condition —
 * production surfaces expose no evaluation controls.
 *
 * Review workflow / calibration (src/eval/review-workflow.ts) is deliberately
 * NOT exported here: it is evaluation-plane machinery outside the shipped
 * product surface (it is excluded from the product closure).
 */
export {
  admitEvaluation,
  createEvaluationMiddleware,
} from "./evaluation-middleware.js";
export type { EvaluationMiddlewareDeps } from "./evaluation-middleware.js";
