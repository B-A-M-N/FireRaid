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
 * Closure 6: no public volatile opt-out. The durability check is EXACT
 * (`durability === "durable"`): undefined, "whatever", or any other label
 * fails — a store must ASSERT durability, not merely fail to deny it.
 * Volatile wiring is the EVALUATION factory's internal, validated path
 * (validateEvaluationDeps calls validateProductionDeps with
 * `internalEvaluation: true`); it is not reachable from this public
 * signature.
 */
export function createFireRaidMiddleware(deps: MiddlewareDeps): MiddlewareDeps {
  return validateProductionDeps(deps, { internalEvaluation: false });
}

/**
 * The full validator. `internalEvaluation` is NOT a public option — only
 * src/eval/evaluation-middleware.ts may pass true (it is the sanctioned
 * home of in-memory experiment wiring), and it STILL gets the exact
 * "durable"|undefined-else shape check per store.
 */
export function validateProductionDeps(
  deps: MiddlewareDeps,
  internalOptions: { internalEvaluation: boolean }
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

  // FR-RR-19: the deadline budgets are FAIL-CLOSED machinery — a miswired
  // value must fail at wiring time, never surface as live behavior:
  //   0 or negative → every adapter call "exceeds" instantly (all requests
  //     denied as infrastructure errors), or the durability write never gets
  //     a window at all (the one-forward claim then hangs unrecorded);
  //   non-finite (NaN/Infinity) or a wrong type → setTimeout treats them as
  //     1ms/0ms, silently degenerating to the same instant-expiry;
  //   unbounded (minutes+) → the fail-closed deadline stops bounding
  //     anything; a hung adapter holds sockets and claim slots for its full
  //     length.
  // Both budgets share one validation: a positive, finite, bounded number
  // of milliseconds (ceiling 10 minutes — far above any sane adapter call
  // or durability write, far below "unbounded").
  for (const [field, value, def] of [
    ["adapterTimeoutMs", deps.adapterTimeoutMs, "DEFAULT_ADAPTER_CALL_TIMEOUT_MS (10s)"],
    ["durabilityTimeoutMs", deps.durabilityTimeoutMs, "DEFAULT_DURABILITY_TIMEOUT_MS (5s)"],
  ] as const) {
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 10 * 60_000
    ) {
      throw new MiddlewareConfigError(
        `MiddlewareDeps.${field} must be a finite number of milliseconds in (0, 600000] ` +
          `when provided (got ${JSON.stringify(value)}); omit the field for the ` +
          `default ${def}. 0/negative makes every deadline fire instantly ` +
          `(fail-closed denial of everything); an unbounded budget stops ` +
          `bounding.`
      );
    }
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
        "durable store) and every terminal REVIEW/QUARANTINE decision must " +
        "finalize durably (finalizeDecision → stored|replay|conflict); see " +
        "HostSubmissionStore + FinalizeDecisionResult in host-adapter/interface.ts"
    );
  }
  requireMethod(deps.submissionStore, "claim", "submissionStore");
  requireMethod(deps.submissionStore, "complete", "submissionStore");
  // FR-RR-43: the coordinator calls finalizeDecision on EVERY terminal
  // REVIEW/QUARANTINE — the state machine's decision path. A hand-written
  // JS adapter that lacks it would pass startup and fail on the FIRST
  // denied applicant, so it must be required at startup like claim/complete.
  requireMethod(deps.submissionStore, "finalizeDecision", "submissionStore");
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
  // IMPOSSIBLE in the production constructor. FR-RR-56 (contract, chosen):
  // the evaluation plane (internalEvaluation) MAY wire the explicit no-op —
  // experiments verify the causal machinery, not Turnstile — and the
  // validator enforces exactly that split. There is no public path to
  // internalEvaluation: createFireRaidMiddleware always passes false.
  if (deps.verification.verificationMode === "disabled-test" && !internalOptions.internalEvaluation) {
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

  // FR-RR-27: profile integrity is a MANDATORY production capability. The
  // session adapter must carry `profileIntegrity: "issued-hash"` and honor
  // it — sign the issued profile hash into the session envelope (fr2.ph)
  // and return it from resolveSession() — so the middleware can drift-check
  // the treatment it ENFORCES against the treatment that was ISSUED. A
  // generic host adapter that silently ignores the issuance object (or
  // returns a hashless context) reopens the FR-RR-12 hole at the boundary
  // the reference adapter closed: every decision would rest on an
  // unverifiable treatment. FR-RR-56 (contract, chosen): the EVALUATION
  // plane (internalEvaluation) may still use hashless carriers for
  // experiments; the refusal is production-only, same gate as the
  // disabled-test verifier above.
  if (deps.session.profileIntegrity !== "issued-hash" && !internalOptions.internalEvaluation) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.session must declare profileIntegrity: \"issued-hash\" in " +
        "production — the adapter MUST sign the issued profile hash into the " +
        "session envelope (fr2 with the ph claim) and surface it through " +
        "resolveSession(), so every derivation is drift-checked against the " +
        "treatment that was issued (FR-RR-12). Hashless session carriers are " +
        "the evaluation plane's domain."
    );
  }

  // (c) FR-RR-16: the production posture is EXPLICIT. An omitted
  // enforcementMode previously defaulted to advisory (never blocking)
  // while the advisory warning only fired on the literal "advisory" —
  // so `enforcementMode: undefined` meant "silently evaluate-and-forward
  // everything". A security product must not have an implicit no-defense
  // posture: production wiring names its posture, and the weak one is
  // loudly warned.
  if (deps.enforcementMode === undefined) {
    throw new MiddlewareConfigError(
      "MiddlewareDeps.enforcementMode is REQUIRED in production — name the " +
        "posture explicitly: \"advisory\" (never blocks, annotates only), " +
        "\"review\" (auto-approves ACCEPT, flags the rest), or \"enforcement\" " +
        "(quarantine rejects). An omitted mode silently meant advisory."
    );
  }
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
    // Closure 6: EXACT durability match. `undefined` (a hand-rolled adapter
    // that never set the field), a typo label, or "volatile" all fail the
    // production contract — durability must be ASSERTED, not merely not-
    // denied. The evaluation path (internalEvaluation) tolerates the
    // explicit "volatile" label only; it still cannot sneak an undefined
    // shape past a wired production profile — evaluation synthesizes the
    // reference stores, which always declare the field.
    if (!store) continue;
    if (store.durability !== "durable") {
      if (!(internalOptions.internalEvaluation && store.durability === "volatile")) {
        throw new MiddlewareConfigError(
          `createFireRaidMiddleware (production) rejects a NON-DURABLE ${label} ` +
            `(durability:${JSON.stringify((store as { durability?: unknown }).durability)} — must be ` +
            `exactly "durable"). Production review evidence and the one-submission ` +
            `claim must survive restarts; wire a durable adapter (D1/R2/Postgres/…; ` +
            `INTEGRATION.md). Explicit "volatile" stores are the EVALUATION ` +
            `constructor's domain.`
        );
      }
    }
  }

  // FR-RR-42: terminal decision records and their host-side deny projection
  // are one durability contract. A conforming PRODUCTION store cannot omit
  // either half, or automatic replay repair becomes optional. Evaluation
  // wiring may use its intentionally smaller volatile fixture contract. Keep
  // this check after the established semantic gates so existing diagnostics
  // (verification, posture, and durability) remain specific.
  if (!internalOptions.internalEvaluation) {
    requireMethod(deps.submissionStore, "denyProjectionState", "submissionStore");
    requireMethod(deps.submissionStore, "markDenyProjectionComplete", "submissionStore");
    // FR-RR-41: an uncertain upstream result is intentionally absorbing until
    // an authenticated operator performs an explicit reconciliation.
    requireMethod(deps.submissionStore, "reconcileUncertain", "submissionStore");
  }

  return deps;
}
