/**
 * EVALUATION middleware surface (audit: product/lab boundary).
 *
 * This is the ONLY place labMode / ablation recipes / holdout / Turnstile
 * treatments are legal on the host plane. It binds the production admission
 * body (__admitWithEvaluation) with an EvaluationControls object —
 * evaluation → production primitives, never production → evaluation
 * override.
 *
 * The Worker fixture and the experiment harness import from here. A
 * deployment that never imports this module cannot reach a lab condition.
 */
import {
  __admitWithEvaluation,
  createFireRaidMiddleware,
  type MiddlewareDeps,
  type MiddlewareResult,
  type EvaluationControls,
} from "../host-adapter/middleware.js";
import type { ProfileKeyRing } from "../core/session.js";
import type { ResolvedFireRaidRoutes } from "../host-adapter/interface.js";

export type { EvaluationControls, ResolvedFireRaidRoutes };

/** Evaluation middleware deps — production deps + the override surface.
 * Rereview item 18: the evaluation plane relaxes profileKeys back to
 * optional — the single `secret` convenience is legal HERE and nowhere
 * else (the factory synthesizes the one-key ring from it). */
export interface EvaluationMiddlewareDeps
  extends Omit<MiddlewareDeps, "profileKeys" | "secret">, EvaluationControls {
  profileKeys?: ProfileKeyRing;
  secret?: string;
}

/**
 * Evaluation admission: identical contract to admit(), plus the bound
 * experimental condition (labMode / recipe / holdout / turnstile).
 */
export async function admitEvaluation(
  req: Request,
  deps: EvaluationMiddlewareDeps,
  htmlLoader: () => Promise<string>
): Promise<MiddlewareResult> {
  const evaluation: EvaluationControls = {
    labMode: deps.labMode === true,
    recipe: deps.recipe,
    holdoutMode: deps.holdoutMode === true,
    turnstileRequired: deps.turnstileRequired === true,
  };
  return __admitWithEvaluation(req, ensureEvaluationRing(deps), htmlLoader, evaluation);
}

/**
 * Rereview item 18: the single `secret` is EVALUATION convenience. When
 * profileKeys is absent, synthesize the one-key ring from it — the
 * production factory refuses a secret-without-ring shape, so evaluation is
 * the only plane that can still be configured this way. Mutates the deps
 * object once; idempotent.
 */
function ensureEvaluationRing(deps: EvaluationMiddlewareDeps): MiddlewareDeps {
  if (!deps.profileKeys) {
    if (!deps.secret || new TextEncoder().encode(deps.secret).length < 32) {
      throw new Error(
        "EvaluationMiddlewareDeps: profileKeys absent and secret missing/short — provide profileKeys {current, previous?} or a >=32-byte secret"
      );
    }
    deps.profileKeys = { current: { id: "default", secret: deps.secret } };
  }
  return deps as MiddlewareDeps;
}

/**
 * The EVALUATION factory. Structural validation is identical to production
 * (routes mandatory, canary store mandatory, ring + risk-tier validation);
 * the evaluation override surface (labMode/recipe/holdout) is then accepted
 * — the production factory's smuggle-refusal applies only to itself.
 */
export function createEvaluationMiddleware(
  deps: EvaluationMiddlewareDeps
): EvaluationMiddlewareDeps {
  // Run the structural checks by constructing the production-validated
  // shape, then restore the evaluation fields the validator stripped its
  // attention from. The validator only REJECTS lab/recipe on the production
  // entry, so validate the raw deps structurally here instead.
  return validateEvaluationDeps(deps);
}

/** Structural validation shared with production, minus the override refusal. */
function validateEvaluationDeps(deps: EvaluationMiddlewareDeps): EvaluationMiddlewareDeps {
  // Ring synthesis (item 18) — same contract as the admission path.
  ensureEvaluationRing(deps);
  // The production validator performs all structural checks but also
  // refuses lab/recipe. To reuse it without duplicating logic, invoke it on
  // a stripped copy and then re-attach the evaluation fields to the
  // ORIGINAL deps object (validated in place by reference identity).
  const {
    labMode: _labMode,
    recipe: _recipe,
    holdoutMode: _holdoutMode,
    turnstileRequired: _turnstileRequired,
    ...structural
  } = deps;
  createFireRaidMiddleware(structural as MiddlewareDeps);
  return deps;
}
