/**
 * GET handler: artifact injection on the application page (extracted from
 * middleware.ts).
 */
import type { ProfileKeyRing } from "../../core/session.js";
import type { ResolvedFireRaidRoutes, RenderInjectOptions } from "../interface.js";
import type { MiddlewareDeps, MiddlewareResult, EvaluationControls } from "../middleware-types.js";
import { DeadlineSignal } from "../deadline.js";
import { resolveKeySecret, resolveCsrfSecret, deriveForRequest } from "../profile/resolve-session-profile.js";
import { hashProfileByVersion } from "../../core/profile-versions.js";
import { makeCsrf } from "./csrf.js";

export async function handleInjectGet(
  _req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>,
  labMode: boolean,
  ring: ProfileKeyRing,
  routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined,
  deadline: DeadlineSignal
): Promise<MiddlewareResult> {
  try {
    const sessionId = await deadline.run(deps.session.createSession());
    const secret = resolveKeySecret(ring);
    const profile = await deriveForRequest(
      { secret, version: deps.version, sessionId },
      evaluation,
      labMode
    );
    // GET mints BEFORE any session exists — the fresh session uses the
    // current key. resolveCsrfSecret with no sessionKeyId covers exactly
    // that, and POST verifies with the SAME resolver.
    const csrfToken = await makeCsrf(resolveCsrfSecret(deps, ring), sessionId);
    // FR-RR (P2 sunset rule) + FR-RR-17: hash the issued profile (frozen
    // versioned semantics) and hand the adapter the COMPLETE issuance —
    // the version, key id, and hash FireRaid just derived. The adapter
    // signs what it is told; there is no second configuration source that
    // can disagree with the treatment actually rendered.
    const issuedHash = await hashProfileByVersion(profile, deps.version);
    const html = await htmlLoader();
    const renderOpts: RenderInjectOptions = {
      canaryPrefix: routes?.canaryPrefix,
      clientScriptSrc: deps.clientScriptSrc,
    };
    const page = deps.render.inject(html, profile, csrfToken, labMode, renderOpts);
    return {
      kind: "get",
      html: page,
      setCookie: await deadline.run(
        deps.session.sessionCookie(sessionId, {
          profileVersion: deps.version,
          profileKeyId: ring.current.id,
          profileHash: issuedHash,
        })
      ),
    };
  } catch (err) {
    // Fail-closed, but never silent: an inject path failure is a host
    // integration bug (bad fixture, render contract violation) and must be
    // diagnosable from logs.
    console.error("FireRaid middleware: GET inject failed:", err instanceof Error ? err.message : err);
    return { kind: "error", operationalReason: "GET_INJECT_FAILED" };
  }
}
