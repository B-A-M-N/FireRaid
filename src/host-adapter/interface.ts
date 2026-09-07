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

export type DecisionDisposition = "ACCEPT" | "REVIEW" | "QUARANTINE";

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
  /**
   * FR-RR-27: the issued-profile INTEGRITY capability. When true, the
   * adapter GUARANTEES both halves of the drift check:
   *   1. sessionCookie() signs the issuance's `profileHash` into the
   *      carrier (the fr2 format — never dropping it), and
   *      resolveSession() returns that signed hash as
   *      `profileHash` on every verified session.
   * The PRODUCTION factory REQUIRES this capability: without it a host can
   * silently discard the signed hash and the middleware can never detect
   * that the treatment it evaluates differs from the treatment that was
   * issued. Hashless/legacy carriers are the evaluation plane's domain.
   */
  readonly profileIntegrity?: "issued-hash";
  /** Create a new opaque session id (host may persist whatever it needs). */
  createSession(): Promise<string>;
  /**
   * Build the Set-Cookie header value(s) for a fresh session.
   * Async so a host may sign the session id (integrity-protected cookie —
   * see the reference adapter).
   *
   * FR-RR (P2 sunset rule): `issuance` carries what FireRaid actually
   * issued — the derived profile version, the signing key id, and the
   * issued profile hash. FR-RR-17: the ADAPTER no longer owns any of
   * these values — it signs what FireRaid tells it was issued, so there
   * is exactly ONE configuration source for the session's treatment.
   * FR-RR-27: a production adapter (profileIntegrity === "issued-hash")
   * MUST sign the hash (issue the fr2 format with the signed `ph` claim,
   * Worker parity with the FR-P0-G drift check).
   */
  sessionCookie(sessionId: string, issuance?: HostSessionIssuance): Promise<string>;
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
  /**
   * FR-P1-11: trailing `signal` carries the per-request deadline the
   * middleware owns. A host adapter must abort its underlying work when it
   * fires; the middleware races the await regardless, so ignoring it cannot
   * hang the request.
   */
  resolveSession(req: Request, signal?: AbortSignal): Promise<HostSessionContext | null>;
}

/**
 * FR-RR-17 — what FireRaid tells the session adapter was ISSUED. The
 * adapter signs these values into the carrier verbatim; it never supplies
 * its own version/key-id configuration (the duplicate-source deployment
 * bug: page rendered under v2 while the envelope says pv=1). profileHash
 * presence is what selects the fr2 format.
 */
export interface HostSessionIssuance {
  profileVersion: number;
  profileKeyId: string;
  profileHash: string;
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
  /**
   * FR-RR-12: the profile hash SIGNED into the session's fr2 envelope at
   * issuance (`ph`). Present when, and only when, the carrier is an fr2
   * envelope — i.e. issuance proved what treatment the session was shown
   * and signed it. When present, the middleware MUST derive the session's
   * profile and compare it against this hash (fail closed on mismatch,
   * the Worker path's FR-P0-G drift check); a session without one cannot
   * be drift-checked and is a legacy fr1 artifact. The reference GET path
   * always issues fr2, so every session it mints carries this field.
   */
  profileHash?: string;
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
  verify(profile: DefenseProfile, input: VerificationInput, signal?: AbortSignal): Promise<boolean>;
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
   * FR-P1-03: durability is a formal part of the contract, not a comment.
   * "volatile" names an in-memory store (lost on restart); "durable" names
   * one that survives restarts/region moves (D1, R2, Postgres, …). The
   * PRODUCTION constructor rejects volatile adapters: interaction evidence
   * that evaporates on restart cannot anchor a review decision.
   */
  readonly durability: "durable" | "volatile";
  /**
   * Validate + persist one client batch under the Worker's watermark
   * semantics (see HostTelemetryIngest). A structurally invalid batch
   * returns kind:"invalid" — the middleware treats that as a deny (an
   * invalid observation stream is never silently repaired: FR-R6-035
   * semantics on the host plane too).
   */
  accept(sessionId: string, batch: unknown, signal?: AbortSignal): Promise<HostTelemetryIngest>;
  /** The session's full validated stream, in seq order (deduplicated). */
  collect(sessionId: string, signal?: AbortSignal): Promise<ValidatedEvent[]>;
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
   *
   * FR-RR-24: the discriminated result is THE contract. The legacy bare
   * boolean was removed before v0.1.0 stable — `false` could never say
   * whether the upstream rejected the application or never received it,
   * and a definite failure mapping released the forward slot for an
   * automatic retry that could create a duplicate. A host with an
   * adapter still speaking the boolean shape MUST migrate it (return
   * `{ kind: "created" }` for true; false must become an UNCERTAIN
   * transport-failure — the send may have crossed the boundary).
   * The discriminated kinds carry exactly that distinction:
   *
   *   - created:            the upstream accepted and durably recorded the
   *                         registration.
   *   - business-rejected:  the upstream RECEIVED the application and
   *                         rejected it on its own semantics (409/422/…).
   *                         The application will not be created; no retry.
   *   - queued-for-retry:   forwarding failed BUT the adapter durably
   *                         captured the application for retry (retryId
   *                         identifies the pending record). The application
   *                         is not lost; the host's retry worker owns it.
   *   - transport-failure:  the upstream (or network) failed. When
   *                         `uncertain` is true the request MAY have been
   *                         received (the middleware holds the forward
   *                         slot); only a definite pre-send failure may
   *                         release it.
   */
  allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string,
    signal?: AbortSignal,
    // FR-P0-02: the claim's idempotency key. A retry-capable adapter MUST
    // present it to the upstream (e.g. an `Idempotency-Key` header) so the
    // upstream can deduplicate its own side of the irreversible act —
    // exactly-once cannot be guaranteed from the caller alone.
    opts?: { idempotencyKey?: string }
  ): Promise<EnforcementResult>;
  /**
   * Record a denied submission (never forwarded).
   * The annotation carries FireRaid's risk projection so a host queue can
   * surface it to reviewers even when admission was automatic.
   *
   * P1-10: returns void | Promise<void> so a host that persists the
   * annotation/review data asynchronously can await durability. The
   * middleware awaits the result.
   *
   * FR-P1-11: optional trailing signal is the request deadline.
   * FR-RR-56: every deny is an idempotent projection and receives the same
   * explicit key on retries. The host MUST upsert/deduplicate by this key.
   */
  deny(
    sessionId: string,
    reason: string,
    annotation: RiskAnnotation | undefined,
    signal: AbortSignal | undefined,
    opts: { idempotencyKey: string }
  ): void | Promise<void>;
}

/**
 * Enforcement result — discriminated outcome of forwarding to the upstream.
 *
 * P0-8: the failure taxonomy the middleware's own receipt policy is built
 * on. `queued-for-retry` (durably captured) is deliberately distinct from
 * `transport-failure` (nothing captured): only the former may ever reach
 * the applicant as a neutral success receipt — a receipt for an
 * uncaptured application is a lie a crash turns into a lost application.
 */
export type EnforcementResult =
  | { kind: "created" }
  | { kind: "business-rejected"; status: number; body?: string }
  | { kind: "queued-for-retry"; retryId: string }
  | {
      kind: "transport-failure";
      reason: string;
      /**
       * FR-P0-02: TRUE when the adapter cannot tell whether the upstream
       * RECEIVED the request (a timeout after send, an ambiguous network
       * error). An uncertain outcome is NOT a definite pre-send failure:
       * the upstream may have committed the account. The middleware holds
       * the session's forward slot on uncertain (fail closed — retries
       * conflict until an operator reconciles) instead of releasing it for
       * an automatic retry that could create a duplicate. Only a DEFINITE
       * pre-send failure (connection refused, DNS miss, a received-and-
       * classified response) may release the slot.
       */
      uncertain?: boolean;
    };

/**
 * FR-P0-02 — the durable one-submission-per-session authority.
 *
 * FireRaid's invariant: ONE session causes ONE irreversible forward. The
 * Worker plane enforces this with an atomic D1 claim (`UPDATE sessions SET
 * submitted = 1 WHERE id = ? AND submitted = 0`). The host plane — where the
 * upstream forward is equally irreversible — previously delegated that
 * guarantee to "the host's idempotency problem", which meant a client retry
 * (or two concurrent submits) after a lost response could create TWO upstream
 * accounts for one session.
 *
 * The middleware therefore claims BEFORE the forward and completes AFTER:
 *
 *   claim(sessionId, idempotencyKey)
 *     claimed   → this call owns the forward; proceed to enforcement.allow()
 *     replay    → the session ALREADY finalized durably; the stored result is
 *                 returned to the applicant WITHOUT calling the upstream
 *                 again (the lost-response retry converges)
 *     conflict  → another request holds the unfinished claim (two concurrent
 *                 submits); fail closed as forward-failed
 *
 *   complete(claimId, outcome) is called once the forward outcome exists —
 *   including transport-failure (the claim is released by recording the
 *   failure, so a genuine retry may proceed) — and MUST be durable before
 *   the middleware responds.
 *
 * `claim` returning a rejected promise, or an object outside the three
 * contract kinds, fails CLOSED (conflict semantics): an unclaimable session
 * is never forwarded.
 */
export interface HostSubmissionClaim {
  kind: "claimed";
  /** Opaque handle the middleware passes back to complete(). */
  claimId: string;
  /**
   * Deterministic upstream idempotency key derived from
   * (sessionId, idempotencyKey). An enforcement adapter forwarding through
   * a retry-capable transport MUST present this so the upstream can
   * deduplicate its own side of the irreversible act.
   */
  idempotencyKey: string;
}
export type HostSubmissionReplay = {
  kind: "replay";
  /**
   * FR-RR-14: the COMPLETE durable record — the outcome AND the immutable
   * assessment snapshot captured when it was recorded. A replay must be
   * able to reproduce the original assessment exactly, not a degraded
   * reconstruction of it.
   */
  record: FinalSubmissionRecord;
};
export type HostSubmissionConflict = { kind: "conflict" };
export type HostSubmissionClaimResult =
  | HostSubmissionClaim
  | HostSubmissionReplay
  | HostSubmissionConflict;

/**
 * The durable record of how a session's single forward ended. Stored by
 * complete() and replayed to later POSTs of the same session.
 *
 * FR-RR-21: `decision-denied` is the terminal outcome of a submission the
 * DECISION path refused (REVIEW/QUARANTINE) — no forward was attempted, but
 * the denial is exactly as terminal and replayable as a forward outcome. A
 * session whose terminal decision record is durable must never be
 * re-evaluated on retry (the causal evidence that produced the denial is
 * finalized away after the record lands; a re-evaluation could flip to
 * ACCEPT and forward what the decision had already refused).
 */
export type FinalSubmissionOutcome =
  | { kind: "created" }
  | { kind: "business-rejected"; status: number }
  | { kind: "queued-for-retry"; retryId: string }
  | { kind: "decision-denied"; disposition: "REVIEW" | "QUARANTINE" };

/**
 * FR-RR-14 — the immutable assessment snapshot persisted ALONGSIDE the
 * terminal outcome. The prior contract stored only the outcome kind, so a
 * client retry after a failed onAssessment replayed a DEGRADED receipt:
 * the upstream account existed, but the original score, disposition, and
 * risk evidence were lost — the second onAssessment succeeded with less
 * than the first one carried, and the application got acked on that
 * degraded pass. With the snapshot stored, replay reproduces the original
 * assessment byte-for-byte.
 *
 * `sessionId` doubles as the idempotency identity: a host persisting
 * assessments MUST upsert on it, so a replayed onAssessment can never
 * duplicate a review row.
 */
export interface AssessmentSnapshot {
  sessionId: string;
  submittedEmail?: string;
  /**
   * The ORIGINAL CORE disposition (ACCEPT/REVIEW/QUARANTINE) — what the
   * evidence model + policy decided, BEFORE any deployment-posture remap.
   * FR-RR-55: this is deliberately distinct from `runtimeDisposition` —
   * a review-mode deployment turns a core QUARANTINE into a runtime
   * REVIEW, and a custom tier map's autoSuppress flag can turn a core
   * REVIEW into a runtime QUARANTINE. Conflating the two fabricated
   * either "we decided REVIEW" when the core call was QUARANTINE, or the
   * reverse.
   */
  coreDisposition: DecisionDisposition;
  /**
   * FR-RR-55: the disposition the RUNTIME actually acted on at the
   * boundary (the post-`resolveRuntimeDisposition` form). Present on every
   * snapshot this codebase writes and mandatory in the V2 runtime contract.
   */
  runtimeDisposition: DecisionDisposition;
  /** @deprecated Use coreDisposition. New records never write this alias. */
  disposition?: string;
  /** FR-RR-26: MANDATORY in every terminal record (schema v2). */
  score: number;
  /** FR-RR-26: MANDATORY in every terminal record (schema v2). */
  risk: {
    score: number;
    tier: string;
    confidence: string;
    recommendedAction: string;
    evidence: RiskAnnotation["evidence"];
  };
}

/**
 * FR-RR-26 — the terminal record contract, versioned. New records are
 * ALWAYS schema v2: the assessment snapshot is mandatory, so every replay
 * reproduces the original decision material in full — the degraded
 * assessment-less receipt FR-RR-14 closed can never be written again. V2 is
 * the only runtime record shape: coreDisposition and runtimeDisposition are
 * mandatory, and there is no legacy runtime replay window.
 */
export interface FinalSubmissionRecord {
  /** Discriminant for the record shape. 2 = assessment-bearing. */
  version: 2;
  outcome: FinalSubmissionOutcome;
  /** FR-RR-26: REQUIRED — the immutable assessment at record time. */
  assessment: AssessmentSnapshot;
}

/**
 * FR-RR-40 — the result of a decision-finalize attempt against the
 * submission state machine:
 *
 *   NONE ─claimForward──────────→ FORWARD_CLAIMED
 *                                   ├─ complete(terminal)  → TERMINAL
 *                                   └─ complete(uncertain) → FORWARD_UNCERTAIN
 *   NONE ─finalizeDecision──────→ TERMINAL (decision-denied)
 *
 * There is NO automatic transition out of FORWARD_CLAIMED or
 * FORWARD_UNCERTAIN into a decision denial: another request may already
 * have crossed the irreversible boundary, and overwriting its claim would
 * let FireRaid report "blocked" about an upstream account that may exist.
 * FORWARD_UNCERTAIN is ABSORBING for automatic admission processing —
 * only an explicit operator reconciliation may move it.
 */
export type FinalizeDecisionResult =
  | { kind: "stored"; record: FinalSubmissionRecord }
  | { kind: "replay"; record: FinalSubmissionRecord }
  | { kind: "conflict"; state: "forward-claimed" | "forward-uncertain" };

export type UncertainReconciliationResolution =
  | { kind: "created"; assessment: AssessmentSnapshot }
  | { kind: "not-created-release"; reason: string };

export interface SubmissionReconciliationAudit {
  actor: string;
  at: string;
  oldState: "forward-uncertain";
  newState: "terminal" | "none";
  reason?: string;
}

export type UncertainReconciliationResult =
  | { kind: "created"; record: FinalSubmissionRecord; audit: SubmissionReconciliationAudit }
  | { kind: "released"; audit: SubmissionReconciliationAudit }
  | { kind: "conflict"; state: "not-uncertain" | "forward-claimed" | "terminal" };

export interface HostSubmissionStore {
  /**
   * FR-P1-03: the one-submission authority MUST be durable. A volatile
   * submission store would lose a claim on restart and re-run an
   * irreversible upstream forward — the exact FR-P0-02 failure. The
   * PRODUCTION constructor rejects volatile submission stores.
   */
  readonly durability: "durable" | "volatile";
  /**
   * Atomically claim the session's single forward slot. Implementations
   * MUST be durable and atomic (a unique constraint or conditional UPDATE,
   * never check-then-insert).
   */
  claim(sessionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<HostSubmissionClaimResult>;
  /**
   * FR-P0-02 (rereview P0-E): read the session's FINALIZED record, if one
   * exists, WITHOUT claiming the forward slot. Lets the middleware serve
   * replays cheaply before evaluation while keeping the claim itself
   * at the irreversible boundary — an early deny (verification failure,
   * invalid telemetry, …) never opens a claim, so a corrected retry never
   * collides with an orphaned one. Returns null when no terminal outcome
   * is stored (a FORWARD_UNCERTAIN session has NO final record — its
   * upstream outcome is genuinely unknown). Implementations SHOULD be
   * optional at the type level (an older store without it simply skips the
   * fast replay path; claim()'s own replay remains the backstop).
   */
  lookupFinal?(sessionId: string, signal?: AbortSignal): Promise<FinalSubmissionRecord | null>;
  /**
   * FR-RR-21 — durably record a DECISION denial (REVIEW/QUARANTINE) as the
   * session's TERMINAL outcome, WITHOUT opening or touching a forward
   * claim. Called BEFORE the enforcement deny and evidence finalization.
   *
   * FR-RR-40 state machine: the store MUST perform this as an ATOMIC
   * conditional transition (never check-then-write), and it MUST refuse:
   *   - FORWARD_CLAIMED  → conflict ("forward-claimed"): another request
   *     owns the forward slot and may be mid-irreversible-forward. The
   *     decision must NOT overwrite it.
   *   - FORWARD_UNCERTAIN → conflict ("forward-uncertain"): the upstream
   *     outcome is UNKNOWN — a decision denial would fabricate "blocked"
   *     for a state that may be "created". Absorbing for automatic
   *     processing; only operator reconciliation may resolve it.
   * "replay" means a TERMINAL record already exists (a concurrent request
   * won the race, or a previous denial finalized): the caller MUST surface
   * the returned record's outcome instead of its own evaluation and MUST
   * NOT re-run deny-side effects against the already-finalized session.
   */
  finalizeDecision(
    sessionId: string,
    record: FinalSubmissionRecord,
    signal?: AbortSignal
  ): Promise<FinalizeDecisionResult>;
  /**
   * FR-RR-42 — mark the enforcement.deny PROJECTION of a terminal
   * decision-denied record durably complete. The coordinator calls this
   * after the deny side effect lands; a retry that finds the projection
   * still "pending" (denyProjectionState) re-runs the IDEMPOTENT deny and
   * re-marks BEFORE any receipt acknowledges the denial. The marker update
   * itself MUST be idempotent for concurrent replay repairs. Production
   * stores MUST implement this projection barrier.
   */
  markDenyProjectionComplete(sessionId: string, signal?: AbortSignal): Promise<void>;
  /** FR-RR-42: read the deny-projection state of a terminal decision. */
  denyProjectionState(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<"pending" | "complete">;
  /**
   * Resolve a FORWARD_UNCERTAIN claim ONLY through an explicit operator
   * action. Automatic retries must never call this operation. A
   * not-created-release requires positive upstream evidence in `reason`.
   */
  reconcileUncertain(
    sessionId: string,
    resolution: UncertainReconciliationResolution,
    actor: string,
    signal?: AbortSignal
  ): Promise<UncertainReconciliationResult>;
  /**
   * Record the forward's outcome against the claim durably. Called exactly
   * once per successful claim, before the middleware responds. `outcome`
   * covers ALL terminal forward results — created, business-rejected,
   * queued-for-retry, AND transport-failure (a recorded transport failure
   * releases the claim so a genuine client retry may re-attempt).
   *
   * FR-RR-14: `meta.assessment` — the immutable core/runtime disposition
   * pair, score, email, and risk snapshot to persist WITH the outcome, so
   * replays reproduce the original assessment exactly.
   *
   * FR-RR-25: the historical argument order (claimId, outcome, signal) is
   * PRESERVED — the assessment rides in a trailing `meta` object, never in
   * a position that reinterprets an existing adapter's `signal`
   * parameter. A host implementation written against the pre-FR-RR-14
   * three-argument signature keeps working unchanged.
   *
   * FR-RR-45 (type level): a TERMINAL outcome without its assessment is
   * UNREPRESENTABLE for TypeScript hosts — the terminal overload REQUIRES
   * meta.assessment; only the transport-failure overload accepts the
   * assessment-less shape (an uncertain transport failure carries no
   * assessment by design).
   */
  complete(
    claimId: string,
    outcome: FinalSubmissionOutcome,
    signal: AbortSignal | undefined,
    meta: { assessment: AssessmentSnapshot }
  ): Promise<void>;
  complete(
    claimId: string,
    outcome: { kind: "transport-failure"; reason: string; uncertain?: boolean },
    signal?: AbortSignal,
    meta?: { assessment?: AssessmentSnapshot }
  ): Promise<void>;
}

/** Deterministic idempotency key material for one session's forward. */
export function submissionIdempotencyKey(sessionId: string): string {
  return `fr-forward-${sessionId}`;
}

/** Stable idempotency identity for a terminal deny projection. */
export function denialIdempotencyKey(sessionId: string): string {
  return `fr-deny-${sessionId}`;
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
   * FR-P1-03: Class-A causal evidence (verified route hits) that evaporates
   * on restart loses the strongest signing channel the system owns. The
   * PRODUCTION constructor rejects volatile canary stores.
   */
  readonly durability: "durable" | "volatile";
  /**
   * Persist one verified route hit. Idempotent replays MUST return true
   * (mirrors the Worker's INSERT OR IGNORE). Return false ONLY on a real
   * storage error — the caller fails the request closed.
   */
  record(sessionId: string, token: string, expected: string, signal?: AbortSignal): Promise<boolean>;
  /** Whether this session has ≥1 VERIFIED route hit (correlation input). */
  readVerified(sessionId: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Lifecycle: the session is finalized (application submitted) or expired
   * (TTL). Drop all transient state for it. Production stores persist
   * exactly what their retention policy needs BEFORE clearing.
   */
  finalize(sessionId: string, signal?: AbortSignal): Promise<void>;
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
