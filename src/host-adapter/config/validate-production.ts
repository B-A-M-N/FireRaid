/**
 * Production factory validation (extracted from middleware.ts): the startup
 * capability contract every createFireRaidMiddleware wiring must satisfy.
 */
import { validateKeyRing } from "../../core/session.js";
import { validateRiskTierConfig, DEFAULT_RISK_TIERS } from "../../core/risk.js";
import { validateUpstreamUrl } from "../forward-security.js";
import { resolveRoutes } from "./routes.js";
import {
  MiddlewareConfigError,
} from "../middleware-errors.js";
import type { EvaluationControls, MiddlewareDeps } from "../middleware-types.js";
import type {
  HostTelemetryAdapter,
  HostCanaryStore,
  HostSubmissionStore,
} from "../interface.js";

/** Structural capability checks — every wired adapter must be complete. */
function requireMethod(obj: unknown, name: string, label: string): void {
  const o = obj as Record<string, unknown> | undefined;
  if (!o || typeof o[name] !== "function") {
    throw new MiddlewareConfigError(`MiddlewareDeps.${label} must implement ${name}()`);
  }
}

/**
 * Validate middleware dependencies at wiring time (PRODUCTION factory).
 * Returns deps unchanged on success (allows pass-through wiring).
 * Throws MiddlewareConfigError on failure.
 *
 * Capability contract (audit P0): every strategy in the production pool
 * must be executable before the factory accepts a configuration —
 *   semantic route (P02/P04) → canaryStore REQUIRED (route evidence)
 *   interaction → telemetry adapter REQUIRED + functional
 *   semantic nonce field (P03/P04) → render adapter + form injection
 *   verification → NOT the disabled-test no-op
 * Refuses smuggled lab/recipe configuration outright.
 *
 * `options.allowVolatile` is the EVALUATION constructor's opt-in only; the
 * public production entry point never passes it.
 */
export function createFireRaidMiddleware(
  deps: MiddlewareDeps,
  options?: { allowVolatile?: boolean }
): MiddlewareDeps {
  // AUDIT (P0 product/lab boundary): the production factory accepts NO
  // evaluation overrides. A smuggled labMode/recipe/handle would let a
  // deployment configure itself into a weak lab condition.
  const smuggled = deps as MiddlewareDeps & EvaluationControls & { canaryPathPrefix?: string };
  if (smuggled.labMode !== undefined || smuggled.recipe !== undefined || smuggled.canaryPathPrefix !== undefined) {
    throw new MiddlewareConfigError(
      "createFireRaidMiddleware (production) does not accept labMode/recipe/canaryPathPrefix — use createEvaluationMiddleware for experimental conditions"
    );
  }

  // (d) key material: profileKeys is THE production contract (rereview item
  // 18). A deps carrying only the deprecated secret is an evaluation-shape —
  // it must go through createEvaluationMiddleware, which synthesizes the
  // one-key ring. Refusing here keeps the production contract single-form.
  if (!deps.profileKeys) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.profileKeys is REQUIRED in production — " +
        "provide { current, previous? }; the single `secret` field is " +
        "evaluation-plane convenience only"
    );
  }
  if (new TextEncoder().encode(deps.profileKeys.current.secret).length < 32) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.profileKeys.current.secret must be at least 32 bytes"
    );
  }

  // (e) version must be a positive integer
  if (!Number.isInteger(deps.version) || deps.version <= 0) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.version must be a positive integer"
    );
  }

  // (a) routes: MANDATORY in production — ONE canonical table drives
  // dispatch, artifact URLs, canary parsing, and the client config.
  const routes = resolveRoutes(deps);
  if (!routes) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.routes is required — production dispatch, artifact generation, and client config all resolve from the ONE canonical route table"
    );
  }
  if (routes.applicationPage.length === 0 || routes.applicationSubmit.length === 0) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.routes.applicationPage/applicationSubmit must be non-empty strings"
    );
  }

  // AUDIT (P0 route capability + rereview item 3): the production strategy
  // pool includes P02/P04, whose causal channel is the canary route. Route
  // evidence is a MANDATORY production capability — deploying without it
  // would announce a causal defense the origin cannot observe. Never
  // silently drop the strategies: configuration failure must not become
  // random weakening.
  if (!deps.canaryStore) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.canaryStore is REQUIRED in production — the production strategy pool (P02/P04) needs verified route-evidence storage"
    );
  }
  requireMethod(deps.canaryStore, "record", "canaryStore");
  requireMethod(deps.canaryStore, "readVerified", "canaryStore");

  // FR-P0-02: the one-submission-per-session authority is a MANDATORY
  // production capability — the upstream forward is irreversible, so the
  // middleware must own a durable claim/replay/complete record around it.
  // "Let the host dedupe" was the exact gap that let one session create
  // multiple upstream accounts after a lost response.
  if (!deps.submissionStore) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.submissionStore is REQUIRED in production — one session " +
        "must cause one irreversible forward (claim/replay/complete over a " +
        "durable store); see HostSubmissionStore in host-adapter/interface.ts"
    );
  }
  requireMethod(deps.submissionStore, "claim", "submissionStore");
  requireMethod(deps.submissionStore, "complete", "submissionStore");

  // Rereview item 3: per-strategy capability enumeration over the ENTIRE
  // production pool. The random composition can draw every entry of
  // PRODUCTION_AGENT_STRATEGIES = [P02, P03, P04] plus the interaction
  // family on ANY session, so each causal channel must be wired BEFORE a
  // session can be issued a trap the origin cannot observe.
  const capabilities: Array<{ strategy: string; requirement: string; ok: boolean }> = [
    // P02 — exact-route request: verified route-evidence storage.
    {
      strategy: "P02",
      requirement: "canaryStore (verified route-evidence storage)",
      ok: !!deps.canaryStore,
    },
    // P03 — exact-nonce field fill: server-side HTML injection of the decoy
    // field + submit observation of the echoed nonce.
    {
      strategy: "P03",
      requirement: "render.inject (decoy-field rendering) + submit observation",
      ok: typeof deps.render?.inject === "function",
    },
    // P04 — route + field combined: both channels above.
    {
      strategy: "P04",
      requirement: "canaryStore + render.inject",
      ok: !!deps.canaryStore && typeof deps.render?.inject === "function",
    },
    // interaction — behavioral telemetry: validated ingest + stream collect.
    {
      strategy: "interaction",
      requirement: "telemetry.accept/collect (validated event-stream storage)",
      ok:
        typeof deps.telemetry?.accept === "function" &&
        typeof deps.telemetry?.collect === "function" &&
        deps.telemetryIngestPath !== "",
    },
    // Client instrumentation — the browser half of the interaction channel.
    // When the host serves the client script itself it must also advertise
    // the ingest route, or interaction telemetry can never be drained.
    {
      strategy: "client-instrumentation",
      requirement: "resolved telemetry ingest route (routes.telemetry)",
      ok: resolveRoutes(deps)?.telemetry !== "",
    },
  ];
  const missing = capabilities.filter((c) => !c.ok);
  if (missing.length > 0) {
    throw new MiddlewareConfigError(
      "Production capability graph incomplete — the composition can draw " +
        missing.map((c) => `${c.strategy} (needs ${c.requirement})`).join("; ") +
        ". Narrowing the strategy pool is NOT a valid response; wire the " +
        "missing capabilities."
    );
  }

  // AUDIT (P1 startup validation): malformed risk tiers must fail at
  // wiring time, never during a live submission.
  const tierErr = validateRiskTierConfig(deps.riskTiers ?? DEFAULT_RISK_TIERS);
  if (tierErr) {
    throw new MiddlewareConfigError("Invalid riskTiers: " + tierErr);
  }

  // AUDIT (P1 key ring): validate the complete ring at startup — id
  // format, minimum secret length, duplicate ids. (profileKeys presence and
  // current-key length were checked above; this validates the WHOLE ring.)
  const ringErr = validateKeyRing(deps.profileKeys);
  if (ringErr) {
    throw new MiddlewareConfigError("Invalid profileKeys: " + ringErr);
  }

  // CSRF secret, when explicit, must meet the same minimum-length bar.
  if (deps.csrfSecret !== undefined && new TextEncoder().encode(deps.csrfSecret).length < 32) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.csrfSecret must be at least 32 bytes"
    );
  }

  // FR-P1-10: the upstream forward target is validated AT CONFIG TIME — an
  // invalid URL fails wiring, never a live submission (where it would POST
  // the applicant's personal data to the wrong host). The validated,
  // normalized URL replaces the original so forwarding never uses the raw
  // unnormalized string.
  const urlCheck = validateUpstreamUrl(deps.upstreamRegisterUrl);
  if (!urlCheck.ok) {
    throw new MiddlewareConfigError(`Invalid upstreamRegisterUrl: ${urlCheck.error}`);
  }
  deps.upstreamRegisterUrl = urlCheck.url;
  // The forward-cookie allowlist, when provided, must be names (strings).
  if (deps.cookieForwardAllowlist !== undefined) {
    if (!Array.isArray(deps.cookieForwardAllowlist)) {
      throw new MiddlewareConfigError("cookieForwardAllowlist must be an array of cookie names");
    }
    for (const name of deps.cookieForwardAllowlist) {
      if (typeof name !== "string" || name.length === 0) {
        throw new MiddlewareConfigError("cookieForwardAllowlist entries must be non-empty cookie names");
      }
    }
  }

  // AUDIT (P1 verification capability): the disabled-test no-op is
  // IMPOSSIBLE in the production constructor.
  if (deps.verification.verificationMode === "disabled-test") {
    throw new MiddlewareConfigError(
      "verification.verificationMode 'disabled-test' is not allowed in production — wire a host-owned or provider verifier"
    );
  }

  // Structural capability checks: every wired adapter must be complete.
  for (const [label, obj, methods] of [
    ["session", deps.session, ["createSession", "sessionCookie", "resolveSession"]],
    ["render", deps.render, ["inject"]],
    ["verification", deps.verification, ["verify"]],
    ["telemetry", deps.telemetry, ["accept", "collect"]],
    ["enforcement", deps.enforcement, ["allow", "deny"]],
  ] as const) {
    for (const m of methods) {
      requireMethod(obj, m, label);
    }
  }

  // (c) advisory mode warning
  if (deps.enforcementMode === "advisory") {
    console.warn(
      "FireRaid middleware: enforcementMode is 'advisory' — submissions are never blocked."
    );
  }

  // FR-P1-03: durability is a FORMAL capability, and the production
  // constructor FAILS, not warns, on volatile stores. Evidence that
  // disappears on a restart cannot anchor production review decisions, and
  // a volatile submission store would lose its FR-P0-02 claim on restart and
  // re-run an irreversible forward. Local development/integration uses the
  // reference (volatile) stores through the EVALUATION constructor, which
  // still permits them — a production wiring that knowingly accepts an
  // in-memory evidence store is a configuration error, not a policy choice.
  const evidenceStores: Array<[string, HostTelemetryAdapter | HostCanaryStore | HostSubmissionStore | undefined]> = [
    ["telemetry", deps.telemetry],
    ["canaryStore", deps.canaryStore],
    ["submissionStore", deps.submissionStore],
  ];
  for (const [label, store] of evidenceStores) {
    if (store && store.durability === "volatile") {
      // FR-P1-03: the PRODUCTION constructor rejects volatile evidence
      // stores by default. The EVALUATION constructor opts in via
      // `{ allowVolatile: true }` — it is the sanctioned home of in-memory
      // integration/experiment wiring.
      if (!options?.allowVolatile) {
        throw new MiddlewareConfigError(
          `createFireRaidMiddleware (production) rejects a VOLATILE ${label} ` +
            `(durability:"${store.durability}", in-memory, lost on restart). ` +
            `Production review evidence and the one-submission claim must survive ` +
            `restarts; wire a durable adapter (D1/R2/Postgres/…; INTEGRATION.md). ` +
            `Volatile reference stores are the EVALUATION constructor's domain.`
        );
      }
    }
  }

  return deps;
}
