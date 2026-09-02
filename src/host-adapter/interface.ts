/**
 * Host-neutral admission service — adapter contracts (P1-25, FR-R7-034).
 *
 * FireRaid's defense core (src/core/*) is host-independent. This module
 * defines the seam a host integration plugs into so the SAME deterministic
 * core can sit in front of an ordinary upstream signup app the host owns
 * (the P1-24 middleware proof) or a Cloudflare Worker (the existing path).
 *
 * The middleware proof exercises exactly this seam: an ordinary upstream
 * ledger app that knows nothing about FireRaid, with a reference adapter in
 * front that injects artifacts on GET, evaluates before forwarding POST,
 * strips FireRaid fields, and forwards only when admission allows.
 *
 * Contracts:
 *  - HostSessionAdapter    — opaque session id + cookie issuance/parsing.
 *  - HostRenderAdapter      — inject DefenseArtifacts into the upstream HTML.
 *  - HostVerificationAdapter— verify the admission decision is enforceable.
 *  - HostTelemetryAdapter   — receive/normalize coarse interaction telemetry.
 *  - HostEnforcementAdapter — emit the admission decision to the upstream.
 *
 * Every adapter is fail-closed: a thrown error MUST be treated by the
 * middleware as "do not forward" (admission denied), never "forward anyway".
 */

import type { DefenseProfile } from "../types/profile.js";
import type { ValidatedEvent } from "../security/request-validation.js";

/** Re-exported so adapters need not reach into core directly. */
export type { DefenseProfile };

/**
 * Explicit route configuration for the middleware admit() dispatcher.
 * When provided, admit() dispatches STRICTLY by path — unknown GET/POST
 * paths are returned as "not-handled" so the host serves them untouched.
 */
export interface MiddlewareRouteConfig {
  /** The single application page FireRaid injects on GET. */
  applicationPage: string;
  /** The endpoint FireRaid evaluates application POSTs on. */
  applicationSubmit: string;
  /** Telemetry drain carrier path. Default "/api/events". */
  telemetry?: string;
  /** Canary route prefix. Default "/c/". */
  canaryPrefix?: string;
  /**
   * How the browser client reaches the form + endpoints. When omitted the
   * middleware derives defaults from the route config (#signup-form /
   * applicationSubmit / telemetry). All client routing comes from THIS
   * config — the shipped client script carries no path literals.
   */
  client?: MiddlewareClientConfig;
  /**
   * Rereview item 24 — the Cloudflare trust boundary, declared by the
   * deployment that actually owns its ingress:
   *   - "cloudflare": requests reach this middleware ONLY through the
   *     trusted Cloudflare edge, which overwrites CF-Connecting-IP on every
   *     hop. The header is then a trustworthy client-IP source for
   *     verification providers.
   *   - "direct" (default, fail-closed): no trusted edge is asserted.
   *     CF-Connecting-IP is CLIENT-CONTROLLED and is never read — a forged
   *     header cannot inject an IP into any admission decision.
   * Origin-bypass protection (Internet must not reach the origin directly)
   * is enforced by network policy at the FI deployment, not by this flag.
   */
  trustedIngress?: "cloudflare" | "direct";
}

/**
 * Client-routing block of the route configuration — serialized verbatim
 * into the server-generated client config artifact. The production client
 * script has NO path literals; everything it fetches comes from here.
 */
export interface MiddlewareClientConfig {
  /** Selector for the application form the client binds to. Default "#signup-form". */
  formSelector?: string;
  /** Overrides routes.applicationSubmit as the client's submit endpoint. */
  submitEndpoint?: string;
  /** Overrides routes.telemetry as the client's telemetry drain endpoint. */
  telemetryEndpoint?: string;
}

/**
 * The ONE canonical resolved route table. createFireRaidMiddleware resolves
 * MiddlewareRouteConfig (+ legacy top-level fields) into this EXACTLY ONCE;
 * dispatch, artifact generation (semantic prompt URLs), canary parsing, and
 * the client config artifact all consume the same resolved object — three
 * subsystems can never disagree about where the canary route lives again.
 */
export interface ResolvedFireRaidRoutes {
  applicationPage: string;
  applicationSubmit: string;
  telemetry: string;
  canaryPrefix: string;
  client: Required<MiddlewareClientConfig>;
  /** Rereview item 24: resolved ingress trust (default "direct"). */
  trustedIngress: "cloudflare" | "direct";
}

/**
 * Per-request render options threaded from the resolved route table into
 * the render adapter, so emitted markup (semantic prompt URLs, client
 * config endpoints) matches the routes the middleware actually dispatches.
 */
export interface RenderInjectOptions {
  /** The resolved canary prefix (e.g. "/c/" or "/machine-check/"). */
  canaryPrefix?: string;
  /**
   * URL the host serves the FireRaid browser client at. When set, the
   * renderer emits the script tag loading it. Host-owned path.
   */
  clientScriptSrc?: string;
}

/**
 * Opaque session identity + cookies.
 * The host owns storage; FireRaid only needs a stable opaque id.
 */
export interface HostSessionAdapter {
  /** Create a new opaque session id (host may persist whatever it needs). */
  createSession(): Promise<string>;
  /**
   * Build the Set-Cookie header value(s) for a fresh session.
   * Async so a host may sign the session id (integrity-protected cookie —
   * see the reference adapter).
   */
  sessionCookie(sessionId: string): Promise<string>;
  /**
   * Parse + verify the incoming session id from a Request. Return null for a
   * missing OR TAMPERED session — admission must be denied, never forwarded.
   */
  readSessionId(req: Request): Promise<string | null>;
  /**
   * P1-AUDIT-2 response (P1-1): the VERIFIED session context — the envelope's
   * own claims, not the deployment defaults. The signed cookie carries the
   * issuing profile version (pv) and key id (kid); middleware must derive
   * the session's profile with THE ENVELOPE'S pv, so a v7 session keeps its
   * v7 treatment after the deployment default moves to v8 (the FR-P1-19
   * rotation hazard on the Worker; parity here means same hazard closed).
   * Adapters without a signed envelope return the sid with pv/kid from
   * their own issuance state.
   */
  resolveSession(req: Request): Promise<HostSessionContext | null>;
}

/** The verified session context a host adapter returns (P1-1). */
export interface HostSessionContext {
  id: string;
  /** The profile version the session was ISSUED under (envelope pv). */
  profileVersion: number;
  /** The signing key id that verified the envelope (envelope kid). */
  keyId: string;
  /** Issued-at (epoch ms) when the carrier carries it. */
  issuedAt?: number;
}

/**
 * Render/inject adapter — mutate the upstream signup HTML to carry the
 * FireRaid artifacts. Implementations: Cloudflare HTMLRewriter, string
 * replacement (reference/Node), or a DOM library.
 */
export interface HostRenderAdapter {
  /**
   * Inject the artifacts produced by the core into the upstream page.
   * @param html        the upstream signup page HTML (must contain </form>)
   * @param profile     the issued defense profile (carries decoy field, route)
   * @param csrfToken   the CSRF token to embed
   * @param labMode     whether to emit lab-only visible markers
   * @param opts        optional per-request render options (resolved canary
   *                    prefix, client script URL) — from the ONE resolved
   *                    route table, so emitted URLs match dispatch exactly.
   */
  inject(
    html: string,
    profile: DefenseProfile,
    csrfToken: string,
    labMode: boolean,
    opts?: RenderInjectOptions
  ): string;
}

/**
 * P1-AUDIT-2 (P1-4): the verification INPUT a real provider needs — the
 * middleware extracts these from the canonical body ONCE, so a provider
 * adapter never guesses whether its token lives in form.cf_token, an
 * arbitrary JSON field, or a header. Field semantics mirror the Worker's
 * Turnstile provider (action/siteverify request URL/remoteip/user-agent).
 */
export interface VerificationInput {
  /** The provider's challenge token (Turnstile `cf-turnstile-response`). */
  token?: string;
  /** The widget's action label the token was bound to (when carried). */
  action?: string;
  /** Hostname the challenge was solved on (when carried). */
  hostname?: string;
  /** Client IP for siteverify's remoteip (CF-Connecting-IP in production). */
  remoteIp?: string;
  /** Client User-Agent for provider-side consistency checks. */
  userAgent?: string;
  /** The request URL the submission arrived at. */
  requestUrl: string;
}

/**
 * Verification adapter — confirm the submission's admission decision is
 * enforceable before forwarding to the upstream. In production this wraps
 * Turnstile; the reference adapter can use a no-op (verification "none").
 *
 * The adapter DECLARES its mode so a deployment cannot silently no-op:
 *   - "host-owned"      — the host already verified the human elsewhere and
 *                         hands FireRaid the verdict (the FI integration).
 *   - "provider"        — a real external provider (Turnstile) is wired.
 *   - "disabled-test"   — explicit no-op, REFUSED by the production factory.
 */
export type VerificationMode = "host-owned" | "provider" | "disabled-test";

export interface HostVerificationAdapter {
  /**
   * Declared posture of this verifier. "disabled-test" is only legal in
   * explicitly-marked evaluation wiring — createFireRaidMiddleware throws
   * on it, so a production deployment can never ship the reference no-op
   * unknowingly.
   */
  readonly verificationMode: VerificationMode;
  /**
   * @param input the canonical verification input extracted from the
   *   already-parsed, already-CONSUMED request body + headers. The
   *   middleware reads the body ONCE and hands the extracted fields here,
   *   so a real verifier never re-reads a consumed request stream and never
   *   speculates about token placement.
   * @returns true if the submission may be forwarded (verification passed or
   *          not required); false if admission must be denied.
   */
  verify(profile: DefenseProfile, input: VerificationInput): Promise<boolean>;
}

/**
 * Telemetry adapter — persist + serve the session's interaction stream.
 *
 * P1-AUDIT-2 (P0-5): the Worker accumulates events across MANY batches
 * (/api/events … /api/submit) and scores the whole session at submit. A
 * host plane that only sees the submit request's final batch measures a
 * different interaction window and is not evidence about the Worker plane.
 * The adapter is therefore a STATEFUL observation store:
 *   - accept()  validates + persists one batch (canonical ValidatedEvent,
 *     the SAME contract/routes/telemetry.ts validation — no synthetic
 *     timestamps, no weaker normalizer);
 *   - collect() returns the session's full validated stream for scoring.
 *
 * P1-AUDIT-2 (P0-2): accept() implements the Worker's RETRY/IDEMPOTENCY
 * semantics, not a bare append. The Worker path reads a per-session
 * watermark (sessions.last_event_seq), strips the already-accepted prefix
 * from an overlapping batch, accepts only the never-stored suffix, treats
 * an exact replay as idempotent success, and reports the authoritative
 * acceptedThrough. A host adapter that blindly appended would DOUBLE-COUNT
 * a retried batch — pointer counts, key counts, focus transitions,
 * direct-fill evidence, weak-score totals — and diverge from the Worker
 * under completely normal transport retries. The canonical outcome union
 * below mirrors routes/telemetry.ts's IngestOutcome (host shape).
 */
export type HostTelemetryIngest =
  | {
      kind: "accepted";
      /** Events actually persisted (the never-stored suffix). */
      received: number;
      /** Authoritative watermark after persistence (last stored seq; -1 = none). */
      acceptedThrough: number;
      /** True when the batch carried nothing new (exact replay / empty). */
      duplicate: boolean;
    }
  | {
      /** Lost a concurrent-write race; the stored stream may not hold this batch. */
      kind: "conflict";
      acceptedThrough: number;
    }
  | {
      /** Structurally invalid batch — the middleware denies (FR-R6-035). */
      kind: "invalid";
      code: string;
    };

export interface HostTelemetryAdapter {
  /**
   * Validate + persist one client batch under the Worker's watermark
   * semantics (see HostTelemetryIngest). A structurally invalid batch
   * returns kind:"invalid" — the middleware treats that as a deny (an
   * invalid observation stream is never silently repaired: FR-R6-035
   * semantics on the host plane too).
   */
  accept(sessionId: string, batch: unknown): Promise<HostTelemetryIngest>;
  /** The session's full validated stream, in seq order (deduplicated). */
  collect(sessionId: string): Promise<ValidatedEvent[]>;
}

/**
 * Enforcement adapter — emit the decision to the upstream.
 *
 * The middleware calls `allow()` only when the core's disposition is not
 * QUARANTINE/REVIEW-deny. `deny()` records the refusal without forwarding.
 *
 * The upstream ledger is the PRIMARY experimental truth in the middleware
 * proof: a synthetic account exists in the origin ledger IFF `allow()` was
 * called AND the upstream accepted the forwarded registration.
 */
export interface HostEnforcementAdapter {
  /**
   * Forward the (FireRaid-stripped) registration to the upstream.
   * @returns true if the upstream created the account (the experiment's
   *          positive event); false if the upstream rejected it.
   */
  allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string
  ): Promise<boolean>;
  /**
   * Record a denied submission (never forwarded).
   * The annotation carries FireRaid's risk projection so a host queue can
   * surface it to reviewers even when admission was automatic.
   */
  deny(sessionId: string, reason: string, annotation?: RiskAnnotation): void;
}

/**
 * Host-facing risk annotation. Reviewer tools consume this; it must never
 * be serialized to applicants.
 */
export interface RiskAnnotation {
  score: number;
  tier: string;
  confidence: string;
  recommendedAction: string;
  evidence: Array<{
    class: "A" | "B" | "C";
    source: string;
    weight: number;
    verified: boolean;
    description: string;
  }>;
}

/**
 * P1-AUDIT-2 Phase D (audit item 6) — verified canary-hit storage for the
 * host plane. The Worker persists verified route hits in D1 (canary_hits,
 * fail-closed) and submit.ts reads them back as Class-A causal evidence.
 * A host integration owns no D1, so the middleware needs the same
 * capability behind a port: persist on a verified GET /c/<token>, read back
 * at POST correlation time. Fail-closed: `record` returning false is a REAL
 * storage failure and the middleware must fail the request (never report
 * attacker success); `readVerified` throwing denies admission.
 */
export interface HostCanaryStore {
  /**
   * Persist one verified route hit. Idempotent replays MUST return true
   * (mirrors the Worker's INSERT OR IGNORE). Return false ONLY on a real
   * storage error — the caller fails the request closed.
   */
  record(sessionId: string, token: string, expected: string): Promise<boolean>;
  /** Whether this session has ≥1 VERIFIED route hit (correlation input). */
  readVerified(sessionId: string): Promise<boolean>;
  /**
   * Lifecycle: the session is finalized (application submitted) or expired
   * (TTL). Drop all transient state for it. Production stores persist
   * exactly what their retention policy needs BEFORE clearing.
   */
  finalize(sessionId: string): Promise<void>;
  /** Wall-clock TTL hint (ms) the middleware enforces via finalize(). */
  readonly ttlMs?: number;
}

/**
 * Session-scoped evidence lifecycle — the TTL contract for the reference
 * in-memory stores (telemetry streams, canary hits). A long-lived origin
 * process must not accumulate per-session state forever: middleware calls
 * finalize() after the final application submission, and sweeps on demand.
 */
export interface HostSessionEvidenceLifecycle {
  /** Drop a session's transient evidence (called on submit + TTL sweep). */
  finalize(sessionId: string): Promise<void> | void;
  /** Drop EVERY stored session older than ttlMs. Returns sessions evicted. */
  sweepExpired(): Promise<number> | number;
  /** Wall-clock TTL hint (ms). */
  readonly ttlMs?: number;
}
