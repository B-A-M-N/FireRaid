/**
 * Middleware dependency/result types (extracted from middleware.ts so the
 * config/, handlers/, submission/, profile/ and lifecycle/ modules can
 * import them without a cycle back into the orchestrator).
 */
import type { DefenseRecipe } from "../core/recipe-schema.js";
import type { RiskTierConfig } from "../core/risk.js";
import type { ProfileKeyRing } from "../core/session.js";
import type { MiddlewareRouteConfig } from "./interface.js";

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
  session: import("./interface.js").HostSessionAdapter;
  render: import("./interface.js").HostRenderAdapter;
  verification: import("./interface.js").HostVerificationAdapter;
  telemetry: import("./interface.js").HostTelemetryAdapter;
  enforcement: import("./interface.js").HostEnforcementAdapter;
  /**
   * Verified canary-hit storage (P1-AUDIT-2 Phase D, audit item 6).
   * MANDATORY for the production factory: the production composition draws
   * P02/P04, whose causal channel is the canary route — issuing those
   * strategies without route-evidence storage would deploy a defense that
   * is physically incapable of observing one of its causal channels.
   */
  canaryStore: import("./interface.js").HostCanaryStore;
  /**
   * FR-P0-02: durable one-submission-per-session authority. MANDATORY for
   * the production factory — the upstream forward is irreversible, so the
   * middleware claims the session's single forward slot and completes the
   * claim with the outcome after. Without it, a client retry after a lost
   * response (or two concurrent submits) can create multiple upstream
   * accounts for one session.
   */
  submissionStore: import("./interface.js").HostSubmissionStore;
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
  /**
   * P1-10: operational-error sink for infrastructure failures that must
   * not corrupt the applicant response path (store TTL sweeps, store
   * finalization). Default: console.error. A host with a real error
   * pipeline should wire it here — these failures are exactly the
   * degradation that silently turns into a review-data hole.
   */
  onOperationalError?: (op: string, err: unknown) => void;
  /**
   * FR-P1-10: the EXPLICIT allowlist of cookie names (lowercased for
   * comparison) the middleware forwards to the upstream on admission.
   * Default EMPTY = forward NO cookies. FireRaid's OWN cookies under the
   * `__Host-fr_` namespace are excluded regardless of this list.
   */
  cookieForwardAllowlist?: string[];
  /**
   * FR-P1-11: per-request adapter-call deadline budget (ms). See
   * lifecycle/deadlines.ts. Default DEFAULT_ADAPTER_CALL_TIMEOUT_MS (10s).
   */
  adapterTimeoutMs?: number;
  /**
   * FR-P1-11 (closure 4): budget (ms) for each POST-BOUNDARY durability
   * write (submissionStore.complete, finalizeStores) — a FRESH deadline that
   * starts when the write begins, never raced against the request deadline
   * (which may be spent after a long forward). See
   * DEFAULT_DURABILITY_TIMEOUT_MS. Default 5s.
   */
  durabilityTimeoutMs?: number;
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

/** Default forward-cookie spec: forward nothing unless the host opts in. */
export const DEFAULT_FORWARD_COOKIE_ALLOWLIST: readonly string[] = [];

export interface MiddlewareResult {
  /** "get" | "admit" | "deny" | "forward-failed" | "canary-verified" | "ingest" | "error" | "not-handled". */
  kind: "get" | "admit" | "deny" | "forward-failed" | "canary-verified" | "ingest" | "error" | "not-handled";
  /**
   * FR-P0-03: INTERNAL-ONLY reason when kind === "error" — a FireRaid or
   * host-infrastructure failure (store outage, evaluation exception). Never
   * serialized to applicants: the runtime projects kind "error" to a generic
   * 5xx, and the reason exists so hosts can log/alert on the class of
   * failure. Distinct from "deny" (an applicant/precondition fact → 4xx or a
   * neutral decision receipt) and "forward-failed" (the upstream transport
   * → 502).
   */
  operationalReason?: string;
  /** The HTML to return on GET (kind === "get"). */
  html?: string;
  /** Set-Cookie header(s) to return. */
  setCookie?: string;
  /** @deprecated Generic compatibility alias for runtimeDisposition; use the
   * explicit coreDisposition/runtimeDisposition pair. */
  disposition?: string;
  /** Core evidence/policy disposition before deployment remapping. */
  coreDisposition?: "ACCEPT" | "REVIEW" | "QUARANTINE";
  /** Disposition actually enforced at the host boundary. */
  runtimeDisposition?: "ACCEPT" | "REVIEW" | "QUARANTINE";
  /**
   * FR-RR-09: the HTTP STATUS this deny carries, when the middleware knows
   * better than a blanket 403. A request whose BODY is a protocol problem
   * (too large, unparseable, absent) is a 413/400 client error — not an
   * admission denial. The middleware keeps emitting kind "deny" (hosts
   * project dispositions as they always have); when `httpStatus` is
   * present, a conforming runtime uses it instead of the default 403. The
   * Worker plane already answered these correctly; this preserves the same
   * semantics through the generic host middleware. Only ever a 4xx in
   * {400, 403, 405, 413}.
   */
  httpStatus?: 400 | 403 | 405 | 413;
  /** Whether the upstream ledger created the account (the experiment's truth). */
  upstreamCreated?: boolean;
  /**
   * FR-RR-14: TRUE when this receipt is a REPLAY of a durably-recorded
   * terminal outcome rather than the request that performed the work.
   * Orthogonal to the explicit core/runtime disposition pair — a replay
   * carries both original values, the original score, and the original risk
   * evidence captured at complete() time; it never invents a "REPLAY"
   * disposition. A host's onAssessment receives the same assessment the
   * original request produced (idempotent on the snapshot's sessionId).
   */
  replayed?: boolean;
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
   * P0-4/P0-8: the enforcement result detail (set when the adapter returns a
   * discriminated EnforcementResult instead of a legacy boolean). Lets the
   * host distinguish a business rejection from a capture-for-retry from a
   * bare transport failure.
   */
  enforcementDetail?: {
    kind: "created" | "business-rejected" | "queued-for-retry" | "transport-failure";
    status?: number;
    reason?: string;
    retryId?: string;
  };
  /**
   * P0-8: set on kind "forward-failed" — the upstream never accepted the
   * application AND the adapter durably captured nothing, so this request
   * must never surface to the applicant as a success receipt. Hosts run
   * their own retry/monitoring off the reason string; the applicant sees a
   * retryable failure.
   */
  forwardFailureReason?: string;
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
