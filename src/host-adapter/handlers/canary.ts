/**
 * GET canary-probe handler (extracted from middleware.ts).
 */
import { constantTimeTokenEqual } from "../../core/tokens.js";
import type { ProfileKeyRing } from "../../core/session.js";
import type { ResolvedFireRaidRoutes } from "../interface.js";
import type { MiddlewareDeps, MiddlewareResult, EvaluationControls } from "../middleware-types.js";
import { DeadlineSignal } from "../deadline.js";
import { reportOperationalError } from "../lifecycle/store-finalization.js";
import { resolveKeySecret, deriveAndVerifyIssuedProfile } from "../profile/resolve-session-profile.js";
import { ProfileHashMismatchError } from "../middleware-errors.js";

const DEFAULT_CANARY_PREFIX = "/c/";

export async function handleCanaryGet(
  req: Request,
  deps: MiddlewareDeps,
  url: URL,
  ring: ProfileKeyRing,
  routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined,
  deadline: DeadlineSignal
): Promise<MiddlewareResult> {
  const store = deps.canaryStore;
  // Parse with the EXACT prefix the artifacts emitted.
  const prefix = routes?.canaryPrefix ?? DEFAULT_CANARY_PREFIX;
  const token = url.pathname.slice(prefix.length);
  if (!token) return { kind: "deny", disposition: "MISSING_TOKEN" };
  if (!store) return { kind: "deny", disposition: "NO_ROUTE_STORE" };
  const session = await deadline.run(deps.session.resolveSession(req, deadline.signal));
  const sessionId = session?.id ?? null;
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };
  const deriveVersion = session?.profileVersion ?? deps.version;
  let secret: string;
  try {
    secret = resolveKeySecret(ring, session!.keyId);
  } catch {
    return { kind: "deny", disposition: "UNKNOWN_PROFILE_KEY" };
  }
  try {
    // FR-RR-12: canary reconstruction verifies against the signed issued
    // hash too — a drifted derivation must never persist a "verified" hit
    // for a treatment the session was not actually shown.
    const profile = await deriveAndVerifyIssuedProfile({
      secret,
      version: deriveVersion,
      sessionId,
      expectedHash: session?.profileHash,
      evaluation,
      labMode: evaluation?.labMode === true,
      // FR-RR-27: production sessions must carry the signed issued hash.
      requireIssuedHash: !evaluation,
    });
    if (!profile.decoyRoute) return { kind: "deny", disposition: "NO_ROUTE" };
    const expected = profile.decoyRoute.endpointToken;
    if (!constantTimeTokenEqual(token, expected)) {
      return { kind: "deny", disposition: "INVALID_TOKEN" };
    }
    const persisted = await deadline.run(store.record(sessionId, token, expected, deadline.signal));
    // FR-P0-03: a canary-store outage is a SERVER failure, not an applicant
    // rejection. Fail closed (never report attacker success) but classify it
    // as an operational error — the Worker plane already returns 500 here,
    // and a 403-style deny would misattribute an outage to the client.
    if (!persisted) {
      reportOperationalError(deps, "canaryStore.record", new Error("persist returned false"));
      return { kind: "error", operationalReason: "CANARY_PERSIST_FAILED" };
    }
    return { kind: "canary-verified", disposition: "CANARY_VERIFIED" };
  } catch (err) {
    // FR-RR-12: a signed-hash mismatch is named distinctly so operators can
    // tell a deployment-derivation straddle from a generic evaluation fault.
    if (err instanceof ProfileHashMismatchError) {
      reportOperationalError(deps, "handleCanaryGet.evaluate", err);
      return { kind: "error", operationalReason: "PROFILE_HASH_MISMATCH" };
    }
    // FR-P0-03: an evaluation/storage exception is FireRaid's own failure —
    // 5xx, not an applicant-facing denial.
    reportOperationalError(deps, "handleCanaryGet.evaluate", err);
    return { kind: "error", operationalReason: "CANARY_EVAL_ERROR" };
  }
}
