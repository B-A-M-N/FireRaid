/**
 * POST submit handler (extracted from middleware.ts): body parsing, form
 * validation, CSRF verification — then delegation to the submission
 * coordinator for evaluation + the irreversible forward.
 */
import { validateSignupForm, type SubmitInbound } from "../../security/request-validation.js";
import { readJsonBody, readBoundedBody } from "../../security/body-limits.js";
import { MAX_HOST_JSON_BYTES } from "../../types/telemetry.js";
import type { ProfileKeyRing } from "../../core/session.js";
import type { ResolvedFireRaidRoutes } from "../interface.js";
import type { MiddlewareDeps, MiddlewareResult, EvaluationControls } from "../middleware-types.js";
import { DeadlineSignal } from "../deadline.js";
import { resolveCsrfSecret } from "../profile/resolve-session-profile.js";
import { verifyCsrf } from "./csrf.js";
import { coordinateSubmission, type SubmissionContext } from "../submission/coordinator.js";

export async function handleSubmitPost(
  req: Request,
  deps: MiddlewareDeps,
  labMode: boolean,
  ring: ProfileKeyRing,
  _routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined,
  deadline: DeadlineSignal
): Promise<MiddlewareResult> {
  const session = await deadline.run(deps.session.resolveSession(req, deadline.signal));
  const sessionId = session?.id ?? null;
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };
  const deriveVersion = session?.profileVersion ?? deps.version;

  // P1-AUDIT-2 Phase F: browser form posts
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  let body: SubmitInbound;
  if (contentType === "application/x-www-form-urlencoded") {
    // P1-8 / FR-P1-02: bounded STREAMING text reader for form posts — counts
    // bytes as they arrive and cancels mid-body on oversize (the old
    // Content-Length-then-req.text() variant buffered the whole form first).
    // FR-RR-09: the body-level failure reason is preserved with its HTTP
    // semantics (OVERSIZE → 413, MISSING/BAD → 400) — these are transport
    // facts, not admission denials; the runtime projects httpStatus when
    // present instead of the blanket 403.
    const read = await readBoundedBody(req, MAX_HOST_JSON_BYTES);
    if (!read.ok) {
      return {
        kind: "deny",
        disposition: read.reason === "MISSING" ? "MISSING_BODY" : "BAD_FORM",
        ...(read.reason === "OVERSIZE" ? { httpStatus: 413 as const } : { httpStatus: 400 as const }),
      };
    }
    const entries: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(read.data))) entries[k] = v;
    const { csrf, ...form } = entries;
    body = { csrf, form };
  } else {
    // P1-8 / FR-P1-02: bounded STREAMING JSON reader — counts bytes as they
    // arrive and cancels mid-body on oversize. FR-RR-09: 413/400 preserved.
    const read = await readJsonBody(req, MAX_HOST_JSON_BYTES);
    if (!read.ok) {
      return {
        kind: "deny",
        disposition: read.reason === "MISSING" ? "MISSING_BODY" : "BAD_JSON",
        ...(read.reason === "OVERSIZE" ? { httpStatus: 413 as const } : { httpStatus: 400 as const }),
      };
    }
    body = read.data as SubmitInbound;
  }
  const formCheck = validateSignupForm(body.form ?? {});
  if (!formCheck.ok) {
    await deadline.run(deps.enforcement.deny(sessionId, "INVALID_FORM", undefined, deadline.signal));
    return { kind: "deny", disposition: "INVALID_FORM" };
  }
  const form = formCheck.form;

  // THE resolver — same source GET minted from (audit P0 roundtrip).
  const csrfSecret = resolveCsrfSecret(deps, ring, session!.keyId);
  if (!body.csrf || !(await verifyCsrf(csrfSecret, sessionId, body.csrf))) {
    return { kind: "deny", disposition: "CSRF_FAILED" };
  }

  const ctx: SubmissionContext = {
    deps,
    deadline,
    sessionId,
    keyId: session!.keyId,
    deriveVersion,
    // FR-RR-12: the signed issued-profile hash, when the envelope carries
    // one — the coordinator's derivation verifies against it (fail closed).
    profileHash: session?.profileHash,
    body,
    form,
    requestUrl: req.url,
    cookieHeader: req.headers.get("cookie"),
    remoteIp: req.headers.get("cf-connecting-ip") ?? undefined,
    userAgent: req.headers.get("user-agent") ?? undefined,
    trustedIngressCloudflare: resolveIngress(req, deps),
    evaluation,
    labMode,
  };
  return coordinateSubmission(ctx, ring);
}

/**
 * Rereview item 24: CF-Connecting-IP is trusted ONLY when the deployment
 * declares a Cloudflare-only ingress. Default ("direct") never reads it —
 * a forged header must not inject an IP into verification.
 */
function resolveIngress(req: Request, deps: MiddlewareDeps): boolean {
  const routeBased = deps.routes?.trustedIngress === "cloudflare";
  // Legacy dispatch (routes omitted) never trusts the ingress header.
  return routeBased && req.headers.get("cf-connecting-ip") !== null;
}
