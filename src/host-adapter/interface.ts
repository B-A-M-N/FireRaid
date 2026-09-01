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
   */
  inject(
    html: string,
    profile: DefenseProfile,
    csrfToken: string,
    labMode: boolean
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
 */
export interface HostVerificationAdapter {
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
  /** Record a denied submission (never forwarded). */
  deny(sessionId: string, reason: string): void;
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
}
