/**
 * Profile derivation + key resolution for the host middleware (extracted
 * from middleware.ts).
 *
 * One secret resolution rule, one derivation dispatch, one CSRF secret rule —
 * the ONLY places a profile or CSRF key is chosen on the host plane.
 */
import type { DefenseProfile } from "../../types/profile.js";
import {
  deriveProductionProfileByVersion,
  deriveEvaluationProfileByVersion,
} from "../../core/profile-versions.js";
import type { ProfileKeyRing } from "../../core/session.js";
import type { MiddlewareDeps, EvaluationControls } from "../middleware-types.js";
import { UnknownProfileKeyError } from "../middleware-errors.js";

/**
 * Resolve the effective profile key secret for a session — EXACT lookup,
 * fail-closed (audit P1): current id → current secret; a previous id →
 * that secret; anything else throws. There is NO silent fallback to the
 * current key for an explicit unknown id — deriving with the wrong key
 * would reconstruct a DIFFERENT profile (every downstream signal drifts).
 * No kid (fresh issuance) uses the current key.
 */
export function resolveKeySecret(ring: ProfileKeyRing, kid?: string): string {
  if (!kid || kid === ring.current.id) return ring.current.secret;
  const prev = ring.previous?.[kid];
  if (prev !== undefined) return prev;
  throw new UnknownProfileKeyError(kid);
}

/**
 * THE CSRF secret resolver — the ONLY place a CSRF key is chosen (audit
 * P0: GET minted with the ring's current secret while POST verified with
 * deps.csrfSecret ?? current, so the middleware could not consume its own
 * token). An explicit deps.csrfSecret wins for both directions; otherwise
 * the session's ISSUING key secret is used on both sides, so profile-key
 * rotation cannot invalidate an in-flight session's token.
 */
export function resolveCsrfSecret(
  deps: Pick<MiddlewareDeps, "csrfSecret">,
  ring: ProfileKeyRing,
  sessionKeyId?: string
): string {
  if (deps.csrfSecret !== undefined) return deps.csrfSecret;
  return resolveKeySecret(ring, sessionKeyId);
}

/**
 * Derivation — the ONLY place a profile is derived on the host plane.
 * FR-P0-04: BOTH planes dispatch by the requested VERSION to the frozen
 * implementation for it. A session envelope carrying pv=N must derive the
 * SAME treatment N named when it was issued — an unsupported N fails
 * closed rather than running current code under an old number.
 */
export function deriveForRequest(
  key: { secret: string; version: number; sessionId: string },
  evaluation: EvaluationControls | undefined,
  labMode: boolean
): Promise<DefenseProfile> {
  if (evaluation) {
    return deriveEvaluationProfileByVersion(
      {
        secret: key.secret,
        version: key.version,
        sessionId: key.sessionId,
        mode: labMode ? "lab" : "production",
        holdoutMode: evaluation.holdoutMode === true,
        turnstileRequired: evaluation.turnstileRequired === true,
      },
      evaluation.recipe
    );
  }
  // PRODUCTION: no recipe, no holdout, no mode override — ever.
  return deriveProductionProfileByVersion(key);
}
