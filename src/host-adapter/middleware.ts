/**
 * Host-neutral admission middleware (P1-24 + P1-25).
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
 *     random composition (deriveProductionProfile). A production deployment
 *     cannot configure its way into a weak lab condition.
 *   - admitEvaluation() + createEvaluationMiddleware() (src/eval) are the
 *     EVALUATION surface: ablation recipes, lab mode, holdout. Evaluation
 *     may call the same lower-level machinery; production never sees the
 *     override knobs.
 *
 * Fail-closed: any adapter/verification error → deny (never forward).
 */
import {
  deriveProductionProfile,
  deriveEvaluationProfile,
  hashProfile,
  type DefenseRecipe,
} from "../core/profile.js";
import { correlate, deriveCanaryReference, type ObservationSet } from "../core/correlation.js";
import { SESSION_RESPONSE_FIELD } from "../core/artifacts.js";
import { decide } from "../core/decision.js";
import { projectRisk, getRiskTier, DEFAULT_RISK_TIERS, resolveRuntimeDisposition, validateRiskTierConfig, type RiskTierConfig } from "../core/risk.js";
import { aggregateTelemetry, type CaptureConfig } from "../telemetry/aggregate.js";
import { validateSignupForm, type SubmitInbound } from "../security/request-validation.js";
import { resolveScoringPolicy } from "./reference-adapters.js";
import type {
  VerificationInput,
  MiddlewareRouteConfig,
  MiddlewareClientConfig,
  ResolvedFireRaidRoutes,
  RenderInjectOptions,
} from "./interface.js";
import { constantTimeTokenEqual } from "../core/tokens.js";
import { validateKeyRing } from "../core/session.js";
import type { DefenseProfile } from "../types/profile.js";
import type {
  HostSessionAdapter,
  HostRenderAdapter,
  HostVerificationAdapter,
  HostTelemetryAdapter,
  HostEnforcementAdapter,
  HostCanaryStore,
} from "./interface.js";
import type { ProfileKeyRing } from "../core/session.js";

const DEFAULT_CANARY_PREFIX = "/c/";
const DEFAULT_TELEMETRY_PATH = "/api/events";
const DEFAULT_FORM_SELECTOR = "#signup-form";

export interface MiddlewareDeps {
  /**
   * THE authoritative key material on the production contract (rereview
   * item 18): profile derivation, CSRF derivation, and session-envelope
   * verification all key off this ring, keyed to the session's kid.
   * MANDATORY for createFireRaidMiddleware.
   */
  profileKeys: ProfileKeyRing;
  /**
   * @deprecated Evaluation-plane convenience only. createFireRaidMiddleware
   * REJECTS a deps that names secret without profileKeys; the evaluation
   * factory synthesizes a one-key ring from it when profileKeys is absent.
   */
  secret?: string;
  version: number;
  /** Upstream registration endpoint (e.g. http://localhost:5051/api/register). */
  upstreamRegisterUrl: string;
  session: HostSessionAdapter;
  render: HostRenderAdapter;
  verification: HostVerificationAdapter;
  telemetry: HostTelemetryAdapter;
  enforcement: HostEnforcementAdapter;
  /**
   * Verified canary-hit storage (P1-AUDIT-2 Phase D, audit item 6).
   * MANDATORY for the production factory: the production composition draws
   * P02/P04, whose causal channel is the canary route — issuing those
   * strategies without route-evidence storage would deploy a defense that
   * is physically incapable of observing one of its causal channels.
   */
  canaryStore: HostCanaryStore;
  /**
   * P1-AUDIT-2 (P1-14): path the middleware treats as the telemetry-drain
   * carrier (the real client POSTs {events: [...]} there). Default
   * "/api/events" — the Worker contract. Set to "" to disable ingest
   * handling entirely.
   */
  telemetryIngestPath?: string;
  /**
   * Runtime enforcement posture for this host.
   *   advisory    - never block; only annotate (default)
   *   review      - quarantine/review block auto-approval; human override ok
   *   enforcement - quarantine auto-rejects
   */
  enforcementMode?: "advisory" | "review" | "enforcement";
  /**
   * Optional risk-tier configuration. Defaults to DEFAULT_RISK_TIERS.
   * VALIDATED AT STARTUP by createFireRaidMiddleware — malformed bands can
   * never be discovered during a live submission.
   */
  riskTiers?: RiskTierConfig[];
  /**
   * Separate secret for CSRF token minting/verification. When present,
   * makeCsrf/verifyCsrf use this for BOTH mint and verify (one resolver);
   * when absent, the session's ISSUING profile key secret is used, so key
   * rotation cannot invalidate in-flight CSRF tokens. Must be >= 32 bytes.
   */
  csrfSecret?: string;
  /**
   * Explicit route configuration. THE canonical route table: resolved once
   * (resolveRoutes) and consumed by dispatch, artifact generation, canary
   * parsing, and the client config artifact. When omitted, legacy dispatch
   * is preserved (every GET injects, POST paths checked ad-hoc).
   */
  routes?: MiddlewareRouteConfig;
  /**
   * URL the host serves the FireRaid browser client at. When set, the
   * renderer emits the <script src> tag loading it. Serving the file is
   * the HOST's job (see src/runtime/node.ts clientScriptSource).
   */
  clientScriptSrc?: string;
}

/**
 * Evaluation-plane controls — the override surface production deliberately
 * lacks. Lives ONLY on EvaluationMiddlewareDeps (src/eval); admit() ignores
 * it entirely and createFireRaidMiddleware REFUSES it if smuggled in.
 */
export interface EvaluationControls {
  /** Lab mode emits visible markers; production stays inert. */
  labMode?: boolean;
  /** Bound ablation recipe (the assigned experimental condition). */
  recipe?: DefenseRecipe;
  /** FR-R5-034 holdout partition sampling. */
  holdoutMode?: boolean;
  /** FR-P0-17 verification condition (treatment identity). */
  turnstileRequired?: boolean;
}

export interface MiddlewareResult {
  /** "get" | "admit" | "deny" | "canary-verified" | "ingest" | "error" | "not-handled". */
  kind: "get" | "admit" | "deny" | "canary-verified" | "ingest" | "error" | "not-handled";
  /** The HTML to return on GET (kind === "get"). */
  html?: string;
  /** Set-Cookie header(s) to return. */
  setCookie?: string;
  /** Disposition recorded (admit/deny paths). */
  disposition?: string;
  /** Whether the upstream ledger created the account (the experiment's truth). */
  upstreamCreated?: boolean;
  /** Ingest ACK (kind === "ingest"): events accepted, stream watermark. */
  received?: number;
  acceptedThrough?: number;
  /**
   * P1-AUDIT-2 (P0-4): the session this request resolved to (POST paths +
   * canary GET). Host-layer bookkeeping only — hosts own session identity
   * (they issue the cookie); this lets a host join its own request log to
   * the middleware's outcomes. Never serialized to clients by the reference
   * facade.
   */
  sessionId?: string;
  /**
   * P1-AUDIT-2 (P0-4): the decision's total score, set on every path that
   * reached decide() (admit and decision-deny alike — a QUARANTINE's score
   * is exactly the evidence weight the host may want to log).
   */
  score?: number;
  /**
   * P1-AUDIT-2 (P0-4): the registration identity carried on the evaluated
   * submit (the FireRaid-stripped form's email field). Lets a host join the
   * middleware outcome to ITS OWN submission record (the origin ledger's
   * email-keyed truth) without re-parsing carriers.
   */
  submittedEmail?: string;
  /**
   * TRUE when the deny came from the DECISION path (REVIEW/QUARANTINE) —
   * as opposed to a precondition failure (no session, bad CSRF, invalid
   * form). The origin projection uses this to give decision-denied
   * submissions the SAME neutral receipt as admits: the decision delta is
   * itself the leak an autonomous agent iterates on. Host logs still get
   * the full disposition.
   */
  decisionDenied?: boolean;
  /**
   * Reviewer-facing risk projection (set on every path that reached decide()).
   */
  risk?: {
    score: number;
    tier: string;
    confidence: string;
    recommendedAction: string;
    evidence: Array<{ class: "A" | "B" | "C"; source: string; weight: number; verified: boolean; description: string }>;
  };
}

// Strip FireRaid-injected fields before forwarding to the upstream so the
// ordinary app's ledger never carries our decoy/telemetry artifacts.
// E5 lever 1: SESSION_RESPONSE_FIELD (the actuator sink the route ask binds
// to) is also FireRaid-issued — dropped from forwarding, scored server-side.
function stripFireRaidFields(
  form: Record<string, string>,
  profile: DefenseProfile
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(["csrf"]);
  if (profile.decoyField) drop.add(profile.decoyField.fieldName);
  if (profile.semantic && profile.decoyRoute) drop.add(SESSION_RESPONSE_FIELD);
  for (const [k, v] of Object.entries(form)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ─── Route resolution: THE one canonical table ────────────────────────────

/**
 * Resolve MiddlewareRouteConfig (+ legacy top-level fields) into the ONE
 * canonical route table. Called by createFireRaidMiddleware (validation)
 * and admit() (dispatch) — dispatch, artifact generation, canary parsing,
 * and the client config can never disagree again.
 */
export function resolveRoutes(deps: {
  routes?: MiddlewareRouteConfig;
  telemetryIngestPath?: string;
  clientScriptSrc?: string;
}): ResolvedFireRaidRoutes | null {
  const r = deps.routes;
  if (!r) return null;
  const canaryPrefix = r.canaryPrefix ?? DEFAULT_CANARY_PREFIX;
  const telemetry = deps.telemetryIngestPath === ""
    ? ""
    : (r.telemetry ?? deps.telemetryIngestPath ?? DEFAULT_TELEMETRY_PATH);
  const client: Required<MiddlewareClientConfig> = {
    formSelector: r.client?.formSelector ?? DEFAULT_FORM_SELECTOR,
    submitEndpoint: r.client?.submitEndpoint ?? r.applicationSubmit,
    telemetryEndpoint: r.client?.telemetryEndpoint ?? (telemetry === "" ? DEFAULT_TELEMETRY_PATH : telemetry),
  };
  return {
    applicationPage: r.applicationPage,
    applicationSubmit: r.applicationSubmit,
    telemetry,
    canaryPrefix,
    client,
    trustedIngress: r.trustedIngress ?? "direct",
  };
}

// ─── Secret resolution: ONE source per purpose ────────────────────────────

/** Error thrown when a session references a key id absent from the ring. */
export class UnknownProfileKeyError extends Error {
  constructor(kid: string) {
    super(`UNKNOWN_PROFILE_KEY: ${kid}`);
    this.name = "UnknownProfileKeyError";
  }
}

/**
 * Resolve the effective profile key secret for a session — EXACT lookup,
 * fail-closed (audit P1): current id → current secret; a previous id →
 * that secret; anything else throws. There is NO silent fallback to the
 * current key for an explicit unknown id — deriving with the wrong key
 * would reconstruct a DIFFERENT profile (every downstream signal drifts).
 * No kid (fresh issuance) uses the current key.
 */
function resolveKeySecret(ring: ProfileKeyRing, kid?: string): string {
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
function resolveCsrfSecret(deps: MiddlewareDeps, ring: ProfileKeyRing, sessionKeyId?: string): string {
  if (deps.csrfSecret !== undefined) return deps.csrfSecret;
  return resolveKeySecret(ring, sessionKeyId);
}

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
 * production admit() passes undefined, and derivation then goes through
 * deriveProductionProfile with no override surface at all.
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
  const ring = deps.profileKeys ?? { current: { id: "default", secret: deps.secret ?? "" } };
  const routes = resolveRoutes(deps);

  // Opportunistic TTL sweep — the lifecycle contract keeps a long-lived
  // origin from accumulating per-session evidence forever.
  sweepStores(deps);

  // ── Route-table dispatch (when `routes` is provided) ─────────────────────
  if (routes) {
    // GET path dispatch
    if (req.method === "GET") {
      // Canary probe — parsed with THE SAME resolved prefix the artifacts
      // emit (audit P0: three subsystems previously disagreed here).
      if (pathname.startsWith(routes.canaryPrefix)) {
        return handleCanaryGet(req, deps, url, ring, routes, evaluation);
      }
      // Application page injection
      if (pathname === routes.applicationPage) {
        return handleInjectGet(req, deps, htmlLoader, labMode, ring, routes, evaluation);
      }
      // Everything else → not-handled
      return { kind: "not-handled" };
    }

    // POST path dispatch
    if (req.method === "POST") {
      // Telemetry ingest
      if (routes.telemetry !== "" && pathname === routes.telemetry) {
        return handleIngestPost(req, deps);
      }
      // Application submit
      if (pathname === routes.applicationSubmit) {
        return handleSubmitPost(req, deps, labMode, ring, routes, evaluation);
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
      return handleCanaryGet(req, deps, url, ring, null, evaluation);
    }

    return handleInjectGet(req, deps, htmlLoader, labMode, ring, null, evaluation);
  }

  if (req.method === "POST") {
    // P1-AUDIT-2 (P1-14): the REAL client (public/signup.js) persists its
    // queue via POST /api/events ({events: [...]} → {received, acceptedThrough})
    // before submitting, exactly as on the Worker plane.
    const ingestPath = deps.telemetryIngestPath === "" ? "" : (deps.telemetryIngestPath ?? DEFAULT_TELEMETRY_PATH);
    if (ingestPath !== "" && pathname === ingestPath) {
      return handleIngestPost(req, deps);
    }

    // Legacy: all POST goes to the submit branch.
    return handleSubmitPost(req, deps, labMode, ring, null, evaluation);
  }

  return { kind: "deny", disposition: "METHOD_NOT_ALLOWED" };
}

// ── Store lifecycle (TTL + finalization) ──────────────────────────────────

type Swept = { sweepExpired?: () => Promise<number> | number };

function sweepStores(deps: MiddlewareDeps): void {
  for (const store of [deps.canaryStore, deps.telemetry as unknown as Swept]) {
    const s = store as Swept | undefined;
    if (s && typeof s.sweepExpired === "function") {
      try {
        void s.sweepExpired();
      } catch {
        // Lifecycle hygiene is best-effort; never fail a request for it.
      }
    }
  }
}

async function finalizeStores(deps: MiddlewareDeps, sessionId: string): Promise<void> {
  for (const store of [deps.canaryStore, deps.telemetry as unknown as { finalize?: (sid: string) => unknown }]) {
    const s = store as { finalize?: (sid: string) => unknown } | undefined;
    if (s && typeof s.finalize === "function") {
      try {
        await s.finalize(sessionId);
      } catch {
        // Finalization failure must not corrupt the response path.
      }
    }
  }
}

// ── Route-handled helper functions ──────────────────────────────────────────

async function handleCanaryGet(
  req: Request,
  deps: MiddlewareDeps,
  url: URL,
  ring: ProfileKeyRing,
  routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined
): Promise<MiddlewareResult> {
  const store = deps.canaryStore;
  // Parse with the EXACT prefix the artifacts emitted.
  const prefix = routes?.canaryPrefix ?? DEFAULT_CANARY_PREFIX;
  const token = url.pathname.slice(prefix.length);
  if (!token) return { kind: "deny", disposition: "MISSING_TOKEN" };
  if (!store) return { kind: "deny", disposition: "NO_ROUTE_STORE" };
  const session = await deps.session.resolveSession(req);
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
    const profile = await deriveForRequest(
      { secret, version: deriveVersion, sessionId },
      evaluation,
      labModeOf(evaluation)
    );
    if (!profile.decoyRoute) return { kind: "deny", disposition: "NO_ROUTE" };
    const expected = profile.decoyRoute.endpointToken;
    if (!constantTimeTokenEqual(token, expected)) {
      return { kind: "deny", disposition: "INVALID_TOKEN" };
    }
    const persisted = await store.record(sessionId, token, expected);
    if (!persisted) return { kind: "deny", disposition: "CANARY_PERSIST_FAILED" };
    return { kind: "canary-verified", disposition: "CANARY_VERIFIED" };
  } catch {
    return { kind: "deny", disposition: "EVAL_ERROR" };
  }
}

function labModeOf(evaluation: EvaluationControls | undefined): boolean {
  return evaluation?.labMode === true;
}

/** Derivation — the ONLY place a profile is derived in this file. */
function deriveForRequest(
  key: { secret: string; version: number; sessionId: string },
  evaluation: EvaluationControls | undefined,
  labMode: boolean
): Promise<DefenseProfile> {
  if (evaluation) {
    return deriveEvaluationProfile(
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
  return deriveProductionProfile(key);
}

async function handleInjectGet(
  _req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>,
  labMode: boolean,
  ring: ProfileKeyRing,
  routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined
): Promise<MiddlewareResult> {
  try {
    const sessionId = await deps.session.createSession();
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
    const html = await htmlLoader();
    const renderOpts: RenderInjectOptions = {
      canaryPrefix: routes?.canaryPrefix,
      clientScriptSrc: deps.clientScriptSrc,
    };
    const page = deps.render.inject(html, profile, csrfToken, labMode, renderOpts);
    return { kind: "get", html: page, setCookie: await deps.session.sessionCookie(sessionId) };
  } catch (err) {
    // Fail-closed, but never silent: an inject path failure is a host
    // integration bug (bad fixture, render contract violation) and must be
    // diagnosable from logs.
    console.error("FireRaid middleware: GET inject failed:", err instanceof Error ? err.message : err);
    return { kind: "error" };
  }
}

async function handleIngestPost(
  req: Request,
  deps: MiddlewareDeps
): Promise<MiddlewareResult> {
  const session = await deps.session.resolveSession(req);
  const sessionId = session?.id ?? null;
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };

  let ingestBody: { events?: unknown };
  try {
    ingestBody = (await req.json()) as { events?: unknown };
  } catch {
    return { kind: "deny", disposition: "BAD_JSON" };
  }
  const ingest = await deps.telemetry.accept(sessionId, ingestBody.events ?? []);
  if (ingest.kind === "invalid") {
    deps.enforcement.deny(sessionId, "INVALID_TELEMETRY");
    return { kind: "deny", disposition: "INVALID_TELEMETRY" };
  }
  if (ingest.kind === "conflict") {
    return {
      kind: "ingest",
      acceptedThrough: ingest.acceptedThrough,
      received: 0,
    };
  }
  return {
    kind: "ingest",
    acceptedThrough: ingest.acceptedThrough,
    received: ingest.received,
  };
}

async function handleSubmitPost(
  req: Request,
  deps: MiddlewareDeps,
  labMode: boolean,
  ring: ProfileKeyRing,
  _routes: ResolvedFireRaidRoutes | null,
  evaluation: EvaluationControls | undefined
): Promise<MiddlewareResult> {
  const session = await deps.session.resolveSession(req);
  const sessionId = session?.id ?? null;
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };
  const deriveVersion = session?.profileVersion ?? deps.version;

  // P1-AUDIT-2 Phase F: browser form posts
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  let body: SubmitInbound;
  if (contentType === "application/x-www-form-urlencoded") {
    let text: string;
    try {
      text = await req.text();
    } catch {
      return { kind: "deny", disposition: "BAD_FORM" };
    }
    const entries: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) entries[k] = v;
    const { csrf, ...form } = entries;
    body = { csrf, form };
  } else {
    try {
      body = await req.json();
    } catch {
      return { kind: "deny", disposition: "BAD_JSON" };
    }
  }
  const formCheck = validateSignupForm(body.form ?? {});
  if (!formCheck.ok) {
    deps.enforcement.deny(sessionId, "INVALID_FORM");
    return { kind: "deny", disposition: "INVALID_FORM" };
  }
  const form = formCheck.form;

  // THE resolver — same source GET minted from (audit P0 roundtrip).
  const csrfSecret = resolveCsrfSecret(deps, ring, session!.keyId);
  if (!body.csrf || !(await verifyCsrf(csrfSecret, sessionId, body.csrf))) {
    return { kind: "deny", disposition: "CSRF_FAILED" };
  }

  let profileSecret: string;
  try {
    profileSecret = resolveKeySecret(ring, session!.keyId);
  } catch {
    deps.enforcement.deny(sessionId, "UNKNOWN_PROFILE_KEY");
    return { kind: "deny", disposition: "UNKNOWN_PROFILE_KEY" };
  }
  try {
    const profile = await deriveForRequest(
      { secret: profileSecret, version: deriveVersion, sessionId },
      evaluation,
      labMode
    );

      // Verification gate (Turnstile in production; host-owned in the FI
      // reference; disabled-test only in explicitly-marked evaluation wiring).
      // P1-AUDIT-2 (P1-4): the middleware extracts the CANONICAL
      // VerificationInput from the already-consumed body + headers ONCE —
      // a provider adapter never guesses where the token lives or re-reads
      // a consumed request stream.
      const verificationInput: VerificationInput = {
        token:
          body.turnstileToken ??
          (typeof (body as Record<string, unknown>).cf_turnstile_response === "string"
            ? ((body as Record<string, string>).cf_turnstile_response)
            : form["cf-turnstile-response"]),
        action: typeof (body as Record<string, unknown>).turnstileAction === "string"
          ? (body as Record<string, string>).turnstileAction
          : undefined,
        hostname: typeof (body as Record<string, unknown>).turnstileHostname === "string"
          ? (body as Record<string, string>).turnstileHostname
          : undefined,
        // Rereview item 24: CF-Connecting-IP is trusted ONLY when the
        // deployment declares a Cloudflare-only ingress. Default
        // ("direct") never reads it — a forged header must not inject an
        // IP into verification.
        remoteIp:
          resolveRoutes(deps)?.trustedIngress === "cloudflare"
            ? (req.headers.get("cf-connecting-ip") ?? undefined)
            : undefined,
        userAgent: req.headers.get("user-agent") ?? undefined,
        requestUrl: req.url,
      };
      const allowed = await deps.verification.verify(profile, verificationInput);
      if (!allowed) return { kind: "deny", disposition: "VERIFICATION_FAILED" };

      // Build server-verifiable observations from the submitted form.
      const observations: ObservationSet = {};
      if (profile.decoyField) {
        const v = form[profile.decoyField.fieldName];
        if (v && v !== "") {
          observations.decoyFieldPopulated = true;
          if (profile.semantic && v === profile.semantic.nonce) {
            observations.decoyFieldMatchesNonce = true;
          }
        }
      }
      // Server-derived canary reference (parity with the Worker submit
      // route): a nonce echoed into a VISIBLE field is reproduced hidden
      // instruction material — server-verifiable behavioral evidence.
      if (profile.semantic && deriveCanaryReference(profile, form)) {
        observations.semanticNonceEcho = true;
      }
      // E5 lever 1 (parity with the Worker submit route): the
      // session_response actuator sink. Route-armed strategies instruct the
      // fill; any non-empty value is the compliant act (Class-A evidence
      // via correlate's SESSION_RESPONSE_PROVIDED).
      if (profile.semantic && profile.decoyRoute) {
        const resp = form[SESSION_RESPONSE_FIELD];
        if (resp && resp !== "") observations.sessionResponsePopulated = true;
      }
      // Telemetry → interaction observations.
      // P1-AUDIT-2 (P0-5): the batch is PERSISTED via the observation store
      // before scoring, so a session that flushed batches through earlier
      // requests scores its WHOLE stream — the Worker behavior — instead of
      // only whatever rode along on this submit. The store validates with
      // the CANONICAL validateTelemetryBatch (P0-4: same events accepted,
      // same rejected, same seq/dt/kind/target/meta — no fabricated
      // timestamps). A structurally invalid batch is a DENY, never a
      // silent repair (FR-R6-035 semantics on the host plane).
      const ingest = await deps.telemetry.accept(sessionId, body.eventBatch ?? []);
      if (ingest.kind === "invalid") {
        deps.enforcement.deny(sessionId, "INVALID_TELEMETRY");
        return { kind: "deny", disposition: "INVALID_TELEMETRY" };
      }
      // kind "conflict" on the submit carrier is NOT a denial either — the
      // session's stored stream already holds the overlapping events and the
      // scoring pass below reads the whole persisted stream.
      if (profile.interaction?.scoringEnabled) {
        // Score the WHOLE persisted stream, not just the final batch.
        const events = await deps.telemetry.collect(sessionId);
        if (events.length > 0) {
          const capture: CaptureConfig = {
            capturePointer: profile.telemetry.capturePointer,
            captureKey: profile.telemetry.captureKey,
          };
          // P1-AUDIT-2: the canonical aggregator over CANONICAL events —
          // real client dt values, capture-aware metrics, the same mapping
          // submit.ts applies (veryShortCompletion threshold included).
          const metrics = aggregateTelemetry(events, capture);
          observations.directFill = metrics.directFill;
          if (metrics.completionMs > 0 && metrics.completionMs < 3000) {
            observations.veryShortCompletion = true;
          }
          if (metrics.noPointerEvents === true) observations.noPointerEvents = true;
          if (metrics.missingInteractionSequence === true) observations.missingInteractionSequence = true;
          // E5 lever 5: interaction-depth signals (parity with the Worker
          // submit route; undefined when not scorable).
          if (metrics.zeroDwellFill === true) observations.zeroDwellFill = true;
          if (metrics.uniformCadence === true) observations.uniformCadence = true;
          if (metrics.noBlurBeforeSubmit === true) observations.noBlurBeforeSubmit = true;
        }
      }

      // P1-AUDIT-2 Phase D (audit item 6): read back VERIFIED canary hits —
      // the host counterpart of submit.ts's canary_hits COUNT. A verified
      // probe of the decoy route before submission is Class-A causal
      // evidence (CANARY_ROUTE_MATCH, weight 100 → QUARANTINE).
      if (profile.decoyRoute) {
        const hit = await deps.canaryStore.readVerified(sessionId);
        if (hit) observations.canaryEndpointHit = true;
      }

      const evidence = await correlate(profile, observations);
      // P1-AUDIT-2 (P1-2): the profile's OWN scoring policy decides —
      // strict-v1 / permissive-v1 are real treatments on the host plane
      // too. Unknown policy fails closed (deny, never default-score).
      const policy = resolveScoringPolicy(profile);
      if (!policy) {
        deps.enforcement.deny(sessionId, "UNKNOWN_SCORING_POLICY");
        return { kind: "deny", disposition: "UNKNOWN_SCORING_POLICY" };
      }
      const decision = decide(evidence, policy);

      // Advisory risk projection: reviewers see score + evidence; applicants
      // see only workflow state.
      const riskTiers = deps.riskTiers ?? DEFAULT_RISK_TIERS;
      const risk = projectRisk(decision.score, evidence, riskTiers);
      const tierConfig = getRiskTier(decision.score, riskTiers);
      const mode = deps.enforcementMode ?? "advisory";
      const runtimeDisposition = resolveRuntimeDisposition(decision.disposition, mode, tierConfig);

      // P1-AUDIT-2 (P0-4): the email the stripped registration carries —
      // the join key to the host's own ledger truth.
      const submittedEmail = typeof form.email === "string" ? form.email : undefined;

      // In advisory mode, every submission is forwarded with an annotation so
      // the upstream/manual-review workflow can see FireRaid's evidence.
      // In review/enforcement, only ACCEPT proceeds automatically; REVIEW/
      // QUARANTINE are denied (the host's queue can pick them up from the
      // annotation if desired).
      if (runtimeDisposition !== "ACCEPT") {
        deps.enforcement.deny(sessionId, decision.disposition, {
          score: risk.score,
          tier: risk.tier,
          confidence: risk.confidence,
          recommendedAction: risk.recommendedAction,
          evidence: risk.evidence,
        });
        void finalizeStores(deps, sessionId);
        return {
          kind: "deny",
          disposition: decision.disposition,
          decisionDenied: true,
          sessionId,
          score: decision.score,
          submittedEmail,
          risk: {
            score: risk.score,
            tier: risk.tier,
            confidence: risk.confidence,
            recommendedAction: risk.recommendedAction,
            evidence: risk.evidence,
          },
        };
      }

      // Admission allowed: strip FireRaid fields and forward to upstream.
      // A urlencoded post carries the submit button's name/value too — the
      // strip pass only removes FireRaid fields, so non-string values can
      // never appear here (URLSearchParams yields strings), but the forward
      // payload must stay Record<string,string>-shaped.
      const cleanForm = stripFireRaidFields(form, profile);
      const cookies = req.headers.get("cookie") ?? "";
      const upstreamCreated = await deps.enforcement.allow(
        deps.upstreamRegisterUrl,
        cleanForm,
        cookies
      );
      void finalizeStores(deps, sessionId);
      return {
        kind: "admit",
        disposition: decision.disposition,
        upstreamCreated,
        sessionId,
        score: decision.score,
        submittedEmail,
        risk: {
          score: risk.score,
          tier: risk.tier,
          confidence: risk.confidence,
          recommendedAction: risk.recommendedAction,
          evidence: risk.evidence,
        },
      };
    } catch {
      // Fail-closed: never forward on an evaluation error.
      return { kind: "deny", disposition: "EVAL_ERROR" };
    }
}

/**
 * P1-AUDIT-2: KEYED CSRF token. The prior `makeCsrf(sessionId)` was an unkeyed
 * SHA-256 of the PUBLIC sid — anyone who saw the cookie could forge the token.
 * Now it's HMAC-SHA-256 keyed with the deployment secret, so the token is
 * unforgeable without the secret and is bound to the session.
 */
export async function makeCsrf(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`csrf:${sessionId}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a keyed CSRF token against a session (constant-time compare). */
export async function verifyCsrf(
  secret: string,
  sessionId: string,
  token: string
): Promise<boolean> {
  const expected = await makeCsrf(secret, sessionId);
  // Constant-time compare with length folded in (no early return — mirrors
  // constantTimeTokenEqual; an early length-check would leak token length).
  const len = Math.max(expected.length, token.length);
  let diff = expected.length ^ token.length;
  for (let i = 0; i < len; i++) {
    const x = i < expected.length ? expected.charCodeAt(i) : 0;
    const y = i < token.length ? token.charCodeAt(i) : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

// hashProfile re-exported for hosts that persist the profile hash.
export { hashProfile };

// ─── Startup factory & error types ──────────────────────────────────────────

/**
 * P1-AUDIT-2 (audit item 17): startup capability validation.
 * Validates and returns deps unchanged on success, throws MiddlewareConfigError
 * with a precise message on failure.
 */
export class MiddlewareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiddlewareConfigError";
  }
}

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
 */
export function createFireRaidMiddleware(
  deps: MiddlewareDeps
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

  return deps;
}
