/**
 * Host-neutral admission middleware (P1-24 + P1-25) — thin request
 * orchestrator.
 *
 * This is the reference adapter that sits in front of an ORDINARY upstream
 * signup app the host owns. The upstream knows NOTHING about FireRaid — it
 * just has a signup endpoint and an account ledger. FireRaid's job here is
 * to inject artifacts on GET, evaluate on POST, strip its own fields, and
 * forward to the upstream only when admission allows.
 *
 * The PRIMARY experimental truth becomes: did the origin ledger contain the
 * synthetic account? That is decided entirely by the upstream's own ledger —
 * not by any FireRaid-side claim. This is what lets the ledger experiment
 * establish whether FireRaid actually works, rather than measuring itself.
 *
 * PRODUCT/EVALUATION SPLIT (audit: lab/recipe override leakage):
 *   - admit() + createFireRaidMiddleware() are the PRODUCTION surface. They
 *     accept NO labMode and NO recipe: every profile is the production
 *     random composition. A production deployment cannot configure its way
 *     into a weak lab condition.
 *   - admitEvaluation() + createEvaluationMiddleware() (src/eval) are the
 *     EVALUATION surface: ablation recipes, lab mode, holdout. Evaluation
 *     may call the same lower-level machinery; production never sees the
 *     override knobs.
 *
 * Fail-closed: any adapter/verification error → deny (never forward).
 *
 * DECOMPOSITION: the responsibilities that used to live in this file now
 * live in focused modules — config/validate-production.ts (startup factory
 * validation), config/routes.ts (THE canonical route table),
 * handlers/* (route handlers), submission/coordinator.ts (the one-forward
 * invariant), profile/resolve-session-profile.ts (key/CSRF/derivation
 * rules), lifecycle/store-finalization.ts (sweeps/finalization/operational
 * errors), handlers/csrf.ts (token mint/verify). This module keeps only
 * request dispatch, the deps/result types (re-exported from
 * middleware-types.ts), and the public API surface.
 */
import type { ProfileKeyRing } from "../core/session.js";
import { resolveRoutes } from "./config/routes.js";
import { DeadlineSignal, DEFAULT_ADAPTER_CALL_TIMEOUT_MS } from "./deadline.js";
import type {
  MiddlewareDeps,
  MiddlewareResult,
  EvaluationControls,
} from "./middleware-types.js";
import { sweepStores } from "./lifecycle/store-finalization.js";
import { handleCanaryGet } from "./handlers/canary.js";
import { handleInjectGet } from "./handlers/signup-get.js";
import { handleIngestPost } from "./handlers/telemetry-post.js";
import { handleSubmitPost } from "./handlers/submit.js";

const DEFAULT_CANARY_PREFIX = "/c/";
const DEFAULT_TELEMETRY_PATH = "/api/events";

export {
  makeCsrf,
  verifyCsrf,
} from "./handlers/csrf.js";
export { hashProfile } from "../core/profile.js";
export {
  createFireRaidMiddleware,
  validateProductionDeps,
} from "./config/validate-production.js";
export {
  MiddlewareConfigError,
  UnknownProfileKeyError,
} from "./middleware-errors.js";
export { resolveRoutes } from "./config/routes.js";
export type {
  MiddlewareDeps,
  MiddlewareResult,
  EvaluationControls,
} from "./middleware-types.js";

/**
 * Handle one request through the admission middleware.
 * @param req          the inbound Request (from the host's fetch handler)
 * @param deps         wired host adapters + core config
 * @param htmlLoader   async loader for the upstream signup HTML (host-owned)
 */
export async function admit(
  req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>
): Promise<MiddlewareResult> {
  return __admitWithEvaluation(req, deps, htmlLoader, undefined);
}

/**
 * The shared admission body. `evaluation` is set ONLY by admitEvaluation —
 * production admit() passes undefined, and derivation then goes through the
 * production version dispatch with no override surface at all.
 */
export async function __admitWithEvaluation(
  req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>,
  evaluation: EvaluationControls | undefined
): Promise<MiddlewareResult> {
  const labMode = evaluation?.labMode === true;
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Resolve the profile key ring — authoritative when wired; the deprecated
  // single secret synthesizes a one-key ring (evaluation plane only; the
  // production factory has already rejected a secret-without-ring config).
  const ring: ProfileKeyRing = deps.profileKeys ?? { current: { id: "default", secret: deps.secret ?? "" } };
  const routes = resolveRoutes(deps);

  // Opportunistic TTL sweep — the lifecycle contract keeps a long-lived
  // origin from accumulating per-session evidence forever.
  sweepStores(deps);

  // FR-P1-11: a per-request deadline the middleware OWNS — every adapter
  // await is raced against it (an adapter that ignores the signal cannot hang
  // the request) and the signal is passed into each adapter so a cooperative
  // host cancels its own I/O. Default 10s interior to the request.
  // Closure 4: the timer is DISCARDED on every exit path — a long-lived host
  // (the node runtime) previously leaked one live 10s timer per request for
  // the full budget even when the request finished in milliseconds.
  const deadline = new DeadlineSignal(deps.adapterTimeoutMs ?? DEFAULT_ADAPTER_CALL_TIMEOUT_MS);
  try {
    return await dispatchRequest(req, deps, htmlLoader, evaluation, {
      labMode,
      url,
      pathname,
      ring,
      routes,
      deadline,
    });
  } finally {
    deadline.clear();
  }
}

/** Everything dispatch needs, resolved once in __admitWithEvaluation. */
interface DispatchArgs {
  labMode: boolean;
  url: URL;
  pathname: string;
  ring: ProfileKeyRing;
  routes: ReturnType<typeof resolveRoutes>;
  deadline: DeadlineSignal;
}

async function dispatchRequest(
  req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>,
  evaluation: EvaluationControls | undefined,
  args: DispatchArgs
): Promise<MiddlewareResult> {
  const { labMode, url, pathname, ring, routes, deadline } = args;

  // ── Route-table dispatch (when `routes` is provided) ─────────────────────
  if (routes) {
    // GET path dispatch
    if (req.method === "GET") {
      // Canary probe — parsed with THE SAME resolved prefix the artifacts
      // emit (audit P0: three subsystems previously disagreed here).
      if (pathname.startsWith(routes.canaryPrefix)) {
        return handleCanaryGet(req, deps, url, ring, routes, evaluation, deadline);
      }
      // Application page injection
      if (pathname === routes.applicationPage) {
        return handleInjectGet(req, deps, htmlLoader, labMode, ring, routes, evaluation, deadline);
      }
      // Everything else → not-handled
      return { kind: "not-handled" };
    }

    // POST path dispatch
    if (req.method === "POST") {
      // Telemetry ingest
      if (routes.telemetry !== "" && pathname === routes.telemetry) {
        return handleIngestPost(req, deps, deadline);
      }
      // Application submit
      if (pathname === routes.applicationSubmit) {
        return handleSubmitPost(req, deps, labMode, ring, routes, evaluation, deadline);
      }
      // Everything else → not-handled
      return { kind: "not-handled" };
    }

    return { kind: "deny", disposition: "METHOD_NOT_ALLOWED" };
  }

  // ── Legacy dispatch (routes OMITTED — back-compat) ────────────────────────
  if (req.method === "GET") {
    // Canary probes are ROUTE-AWARE (P1-AUDIT-2 Phase D): resolve session,
    // reconstruct the profile, verify constant-time, persist FAIL-CLOSED.
    if (pathname.startsWith(DEFAULT_CANARY_PREFIX)) {
      return handleCanaryGet(req, deps, url, ring, null, evaluation, deadline);
    }

    return handleInjectGet(req, deps, htmlLoader, labMode, ring, null, evaluation, deadline);
  }

  if (req.method === "POST") {
    // P1-AUDIT-2 (P1-14): the REAL client (public/signup.js) persists its
    // queue via POST /api/events ({events: [...]} → {received, acceptedThrough})
    // before submitting, exactly as on the Worker plane.
    const ingestPath = deps.telemetryIngestPath === "" ? "" : (deps.telemetryIngestPath ?? DEFAULT_TELEMETRY_PATH);
    if (ingestPath !== "" && pathname === ingestPath) {
      return handleIngestPost(req, deps, deadline);
    }

    // Legacy: all POST goes to the submit branch.
    return handleSubmitPost(req, deps, labMode, ring, null, evaluation, deadline);
  }

  return { kind: "deny", disposition: "METHOD_NOT_ALLOWED" };
}
