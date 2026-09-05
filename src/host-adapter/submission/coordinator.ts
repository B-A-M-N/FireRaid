/**
 * Submission coordination (extracted from middleware.ts) — THE subsystem that
 * owns the "one session → one irreversible forward" invariant.
 *
 * coordinateSubmission() takes an already-authenticated (session + CSRF +
 * form-validated) submit and drives the whole evaluation → disposition →
 * claim → forward → complete pipeline. Every durable outcome transition
 * (claim/replay/complete) lives here and nowhere else.
 */
import type { ProfileKeyRing } from "../../core/session.js";
import { correlate, deriveCanaryReference, type ObservationSet } from "../../core/correlation.js";
import { SESSION_RESPONSE_FIELD } from "../../core/artifacts.js";
import { decide } from "../../core/decision.js";
import {
  projectRisk,
  getRiskTier,
  DEFAULT_RISK_TIERS,
  resolveRuntimeDisposition,
} from "../../core/risk.js";
import { aggregateTelemetry, type CaptureConfig } from "../../telemetry/aggregate.js";
import type { SubmitInbound } from "../../security/request-validation.js";
import type { DefenseProfile } from "../../types/profile.js";
import { resolveScoringPolicy } from "../reference-adapters.js";
import { buildForwardCookieHeader } from "../forward-security.js";
import { DeadlineSignal, DeadlineError } from "../deadline.js";
import { submissionIdempotencyKey } from "../interface.js";
import type {
  VerificationInput,
  HostSubmissionClaimResult,
  HostSubmissionClaim,
  FinalSubmissionOutcome,
  EnforcementResult,
} from "../interface.js";
import type {
  MiddlewareDeps,
  MiddlewareResult,
  EvaluationControls,
} from "../middleware-types.js";
import { DEFAULT_FORWARD_COOKIE_ALLOWLIST } from "../middleware-types.js";
import { reportOperationalError, finalizeStores } from "../lifecycle/store-finalization.js";
import { resolveKeySecret, deriveForRequest } from "../profile/resolve-session-profile.js";

/**
 * P0-8 hardening: runtime shape check for the discriminated enforcement
 * result. The static type says `EnforcementResult`, but the seam is a host
 * callback — a JS host (or a half-migrated one) can hand back anything.
 * Only the four contract kinds with their required field types pass; a
 * kind missing or mistyped (or a `queued-for-retry` without a retryId)
 * fails the receipt policy closed downstream.
 */
export function isValidEnforcementResult(v: unknown): v is EnforcementResult {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  switch (kind) {
    case "created":
      return true;
    case "business-rejected":
      return typeof (v as { status?: unknown }).status === "number";
    case "queued-for-retry":
      return typeof (v as { retryId?: unknown }).retryId === "string" &&
        (v as { retryId: string }).retryId.length > 0;
    case "transport-failure":
      return typeof (v as { reason?: unknown }).reason === "string" &&
        (v as { reason: string }).reason.length > 0;
    default:
      return false;
  }
}

// Strip FireRaid-injected fields before forwarding to the upstream so the
// ordinary app's ledger never carries our decoy/telemetry artifacts.
// E5 lever 1: SESSION_RESPONSE_FIELD (the actuator sink the route ask binds
// to) is also FireRaid-issued — dropped from forwarding, scored server-side.
export function stripFireRaidFields(
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

/** The context one evaluated submit needs (resolved by handlers/submit.ts). */
export interface SubmissionContext {
  deps: MiddlewareDeps;
  deadline: DeadlineSignal;
  sessionId: string;
  /** Resolved key id of the session (for secret + CSRF resolution). */
  keyId: string | undefined;
  /** Profile version the session envelope carries (falls back to deps). */
  deriveVersion: number;
  /** The validated, CSRF-verified inbound body. */
  body: SubmitInbound;
  /** The validated form fields (formCheck.form). */
  form: Record<string, string>;
  /** The request URL (verification input passthrough). */
  requestUrl: string;
  /** Raw cookie header (forward-security filters it). */
  cookieHeader: string | null;
  /** The remote IP a trusted (declared) ingress asserted, if any. */
  remoteIp?: string;
  userAgent?: string;
  /** Whether the deployment declared a Cloudflare-only ingress. */
  trustedIngressCloudflare: boolean;
  evaluation: EvaluationControls | undefined;
  labMode: boolean;
}

/**
 * Verify the applicant, collect evidence, score, and — when admission
 * allows — perform the ONE irreversible forward under a durable claim.
 *
 * FR-P0-02 (rereview P0-E): the session's single forward slot is claimed
 * ONLY at the irreversible boundary — after verification, evidence
 * collection, scoring, and the runtime disposition have all approved the
 * forward. A deny anywhere earlier (verification failure, invalid
 * telemetry, unknown scoring policy, decision denial, evaluation error)
 * never opens a claim, so a corrected retry can never collide with an
 * orphaned one. Before the boundary, a cheap non-claiming lookup
 * (lookupFinal) still serves replay: a session that already finalized
 * durably gets its stored outcome without re-evaluating.
 */
export async function coordinateSubmission(
  ctx: SubmissionContext,
  ring: ProfileKeyRing
): Promise<MiddlewareResult> {
  const { deps, deadline, sessionId } = ctx;
  // The forward-boundary claim — defined only from the irreversible boundary
  // onward; the pre-claim catch reads it to decide whether a release is due.
  let claim: HostSubmissionClaim | undefined;

  // Replay check WITHOUT claiming (P0-E fix): the old flow claimed the
  // forward slot merely to discover a finalized outcome, so any early
  // failure AFTER the claim (unknown profile key, verification failure,
  // invalid telemetry, …) left the slot open forever and every corrected
  // retry collided with it. lookupFinal returns the stored outcome, if any,
  // without touching the claim state.
  const idempotencyKey = submissionIdempotencyKey(sessionId);
  let stored: FinalSubmissionOutcome | null = null;
  try {
    stored = await deadline.run(
      deps.submissionStore.lookupFinal
        ? deps.submissionStore.lookupFinal(sessionId, deadline.signal)
        : Promise.resolve(null)
    );
  } catch (err) {
    // A lookup failure must not bypass the invariant: fail closed as if no
    // final result exists (the forward path will claim and re-check).
    reportOperationalError(deps, "submissionStore.lookupFinal", err);
  }
  if (stored) {
    // The stored outcome IS the receipt: the applicant gets the same neutral
    // result as the request that actually did the work (created → success
    // receipt; business-rejected / queued-for-retry → captured-but-not-
    // created receipt). The upstream is never called again.
    return {
      kind: "admit",
      upstreamCreated: stored.kind === "created",
      sessionId,
      disposition: "REPLAY",
      ...(stored.kind !== "created" ? { enforcementDetail: stored } : {}),
    };
  }

  try {
    let profileSecret: string;
    try {
      profileSecret = resolveKeySecret(ring, ctx.keyId);
    } catch {
      await deps.enforcement.deny(sessionId, "UNKNOWN_PROFILE_KEY");
      return { kind: "deny", disposition: "UNKNOWN_PROFILE_KEY" };
    }
    const profile = await deriveForRequest(
      { secret: profileSecret, version: ctx.deriveVersion, sessionId },
      ctx.evaluation,
      ctx.labMode
    );

    // Verification gate (Turnstile in production; host-owned in the FI
    // reference; disabled-test only in explicitly-marked evaluation wiring).
    // P1-AUDIT-2 (P1-4): the middleware extracts the CANONICAL
    // VerificationInput from the already-consumed body + headers ONCE —
    // a provider adapter never guesses where the token lives or re-reads
    // a consumed request stream.
    const b = ctx.body as Record<string, unknown>;
    const verificationInput: VerificationInput = {
      token:
        ctx.body.turnstileToken ??
        (typeof b.cf_turnstile_response === "string"
          ? (b as Record<string, string>).cf_turnstile_response
          : ctx.form["cf-turnstile-response"]),
      action: typeof b.turnstileAction === "string"
        ? (b as Record<string, string>).turnstileAction
        : undefined,
      hostname: typeof b.turnstileHostname === "string"
        ? (b as Record<string, string>).turnstileHostname
        : undefined,
      // Rereview item 24: CF-Connecting-IP is trusted ONLY when the
      // deployment declares a Cloudflare-only ingress. Default
      // ("direct") never reads it — a forged header must not inject an
      // IP into verification.
      remoteIp: ctx.trustedIngressCloudflare ? ctx.remoteIp : undefined,
      userAgent: ctx.userAgent,
      requestUrl: ctx.requestUrl,
    };
    const allowed = await deadline.run(deps.verification.verify(profile, verificationInput, deadline.signal));
    // FR-P0-03: `false` from the adapter is the provider's OWN answer about
    // this applicant — a genuine deny. A verifier OUTAGE throws, and the
    // outer catch now classifies that as an operational error (5xx) rather
    // than blaming the applicant.
    if (!allowed) return { kind: "deny", disposition: "VERIFICATION_FAILED" };

    // Build server-verifiable observations from the submitted form.
    const observations: ObservationSet = {};
    if (profile.decoyField) {
      const v = ctx.form[profile.decoyField.fieldName];
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
    if (profile.semantic && deriveCanaryReference(profile, ctx.form)) {
      observations.semanticNonceEcho = true;
    }
    // E5 lever 1 (parity with the Worker submit route): the
    // session_response actuator sink. Route-armed strategies instruct the
    // fill; any non-empty value is the compliant act (Class-A evidence
    // via correlate's SESSION_RESPONSE_PROVIDED).
    if (profile.semantic && profile.decoyRoute) {
      const resp = ctx.form[SESSION_RESPONSE_FIELD];
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
    const ingest = await deadline.run(deps.telemetry.accept(sessionId, ctx.body.eventBatch ?? [], deadline.signal));
    if (ingest.kind === "invalid") {
      await deadline.run(deps.enforcement.deny(sessionId, "INVALID_TELEMETRY", undefined, deadline.signal));
      return { kind: "deny", disposition: "INVALID_TELEMETRY" };
    }
    // kind "conflict" on the submit carrier is NOT a denial either — the
    // session's stored stream already holds the overlapping events and the
    // scoring pass below reads the whole persisted stream.
    if (profile.interaction?.scoringEnabled) {
      // Score the WHOLE persisted stream, not just the final batch.
      const events = await deadline.run(deps.telemetry.collect(sessionId, deadline.signal));
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
      const hit = await deadline.run(deps.canaryStore.readVerified(sessionId, deadline.signal));
      if (hit) observations.canaryEndpointHit = true;
    }

    const evidence = await correlate(profile, observations);
    // P1-AUDIT-2 (P1-2): the profile's OWN scoring policy decides —
    // strict-v1 / permissive-v1 are real treatments on the host plane
    // too. Unknown policy fails closed (deny, never default-score).
    const policy = resolveScoringPolicy(profile);
    if (!policy) {
      await deadline.run(deps.enforcement.deny(sessionId, "UNKNOWN_SCORING_POLICY", undefined, deadline.signal));
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
    const submittedEmail = typeof ctx.form.email === "string" ? ctx.form.email : undefined;
    const riskProjection = {
      score: risk.score,
      tier: risk.tier,
      confidence: risk.confidence,
      recommendedAction: risk.recommendedAction,
      evidence: risk.evidence,
    };

    // In advisory mode, every submission is forwarded with an annotation so
    // the upstream/manual-review workflow can see FireRaid's evidence.
    // In review/enforcement, only ACCEPT proceeds automatically; REVIEW/
    // QUARANTINE are denied (the host's queue can pick them up from the
    // annotation if desired).
    if (runtimeDisposition !== "ACCEPT") {
      // P1-10: await durability of the deny annotation (e.g. for a host
      // that persists review-queue data asynchronously)
      await deadline.run(deps.enforcement.deny(sessionId, decision.disposition, riskProjection, deadline.signal));
      await finalizeStores(deps, sessionId, deadline.signal);
      // FR-P0-02 (rereview P0-E): the decision denied BEFORE any claim was
      // ever opened — no forward can happen, so no claim must exist. A
      // corrected retry (new evidence, fixed form) starts clean.
      return {
        kind: "deny",
        disposition: decision.disposition,
        decisionDenied: true,
        sessionId,
        score: decision.score,
        submittedEmail,
        risk: riskProjection,
      };
    }

    // ── THE IRREVERSIBLE BOUNDARY (FR-P0-02) ────────────────────────────────
    // Everything above could deny/retry safely with no durable claim. From
    // here the forward may happen, so the session's single forward slot is
    // claimed NOW. Three outcomes:
    //   replay   → between our lookupFinal and this claim, another request
    //              completed the forward durably; return the STORED outcome
    //              without touching the upstream again.
    //   conflict → another in-flight request owns the claim (concurrent
    //              submits); fail closed as forward-failed — never forward.
    //   claimed  → this request owns the forward; the claim is completed
    //              with the outcome below, whichever way it lands.
    // A claim store that throws or returns a non-contract shape fails CLOSED
    // (conflict semantics): an unclaimable session is never forwarded.
    {
      let claimResult: HostSubmissionClaimResult;
      try {
        claimResult = await deadline.run(deps.submissionStore.claim(sessionId, idempotencyKey, deadline.signal));
      } catch (err) {
        reportOperationalError(deps, "submissionStore.claim", err);
        return { kind: "forward-failed", forwardFailureReason: "submission_claim_failed" };
      }
      if (claimResult.kind === "replay") {
        // Another request did the work between lookupFinal and the claim:
        // its stored outcome is the receipt; the upstream is never called.
        const o = claimResult.outcome;
        return {
          kind: "admit",
          upstreamCreated: o.kind === "created",
          sessionId,
          disposition: "REPLAY",
          ...(o.kind !== "created" ? { enforcementDetail: o } : {}),
        };
      }
      if (claimResult.kind !== "claimed") {
        return { kind: "forward-failed", forwardFailureReason: "submission_claim_conflict" };
      }
      claim = claimResult;
    }

    // Admission allowed: strip FireRaid fields and forward to upstream.
    // A urlencoded post carries the submit button's name/value too — the
    // strip pass only removes FireRaid fields, so non-string values can
    // never appear here (URLSearchParams yields strings), but the forward
    // payload must stay Record<string,string>-shaped.
    const cleanForm = stripFireRaidFields(ctx.form, profile);
    // FR-P1-10: NEVER forward the client's raw cookie header. Only the
    // EXPLICITLY allowlisted names reach the upstream, and FireRaid's own
    // `__Host-fr_*` cookies (the envelope, admin CSRF) are excluded no
    // matter what. Default allowlist is empty — a host must opt in.
    const cookies = buildForwardCookieHeader(
      ctx.cookieHeader,
      { allowlist: deps.cookieForwardAllowlist ?? DEFAULT_FORWARD_COOKIE_ALLOWLIST }
    );
    // P0-4/P0-8: handle the discriminated enforcement result (the bare
    // boolean is legacy — `false` cannot say rejected vs unreachable).
    // FR-P1-11: the forward itself is raced against the deadline — a hung
    // upstream (even one the adapter's own timeout misses) becomes a
    // transport failure, never a hang, and never a false created-receipt.
    // FR-P0-02: the claim's idempotency key travels WITH the forward so a
    // retry-capable transport can deduplicate the upstream's side.
    let enforcementResult: boolean | EnforcementResult;
    try {
      enforcementResult = await deadline.run(
        deps.enforcement.allow(deps.upstreamRegisterUrl, cleanForm, cookies, deadline.signal, {
          idempotencyKey: claim.idempotencyKey,
        })
      );
    } catch (err) {
      // DeadlineError (and any abort it surfaces) → the forward never
      // reached a terminal captured state. The request MAY have been sent,
      // so the outcome is UNCERTAIN (held slot, not released).
      reportOperationalError(deps, "enforcement.allow(deadline)", err);
      try {
        await deadline.run(
          deps.submissionStore.complete(claim.claimId, {
            kind: "transport-failure",
            reason: err instanceof DeadlineError ? "adapter_deadline" : "enforcement_allow_failed",
            uncertain: true,
          }, deadline.signal)
        );
      } catch (completeErr) {
        reportOperationalError(deps, "submissionStore.complete(allow-deadline)", completeErr);
      }
      return {
        kind: "forward-failed",
        forwardFailureReason: "adapter_deadline",
        sessionId,
        submittedEmail,
      };
    }
    // Normalize the legacy boolean to the discriminated shape FIRST so the
    // receipt policy below has one code path. Any MALFORMED shape (a
    // string, null, an object whose `kind` is not one of the four contract
    // kinds — e.g. `{status:"created"}` or `{ok:true}`) FAILS CLOSED as a
    // transport failure: an unvalidated "looks-created" shape flowing past
    // this point would produce a success receipt for an application that
    // is nowhere durable — the FR-INV-008 violation the taxonomy exists to
    // prevent, just via a type error instead of a logic error.
    const detail: EnforcementResult = enforcementResult === true
      ? { kind: "created" }
      : enforcementResult === false
        // Legacy `false` is ambiguous by construction; the honest mapping
        // is a transport failure (never claim `created`, never invent a
        // business status).
        ? { kind: "transport-failure", reason: "legacy_boolean_false" }
        : isValidEnforcementResult(enforcementResult)
          ? enforcementResult
          : { kind: "transport-failure", reason: "malformed_enforcement_result" };
    // FR-INV-008 receipt policy: a success receipt may leave the building
    // only when the application is durably SOMEWHERE — created upstream or
    // captured by the host's retry queue. A bare transport failure means
    // nothing was captured: answering "received" would be a lie a crash
    // turns into a silently lost application.
    if (detail.kind === "transport-failure") {
      // FR-P0-02: record the failure against the claim durably — this
      // RELEASES the slot so a genuine client retry may re-attempt the
      // forward (the upstream captured nothing). If the release itself
      // fails, the claim stays held: fail closed (conflict on retry) beats
      // silently allowing a second forward after an unknown-state first.
      try {
        await deadline.run(deps.submissionStore.complete(claim.claimId, detail, deadline.signal));
      } catch (err) {
        reportOperationalError(deps, "submissionStore.complete(transport-failure)", err);
      }
      return {
        kind: "forward-failed",
        forwardFailureReason: detail.reason,
        enforcementDetail: detail,
        sessionId,
        score: decision.score,
        submittedEmail,
        disposition: decision.disposition,
        risk: riskProjection,
      };
    }
    // FR-P0-02: the forward reached a TERMINAL captured state (created /
    // business-rejected / queued-for-retry) — record it durably BEFORE the
    // receipt leaves, so a later retry of the same session replays THIS
    // outcome instead of re-forwarding. A complete() failure here means
    // the durable record may not exist: fail the request (release never
    // happened → the claim still guards the upstream), never ack blindly.
    try {
      await deadline.run(deps.submissionStore.complete(
        claim.claimId,
        detail.kind === "created"
          ? { kind: "created" }
          : detail.kind === "queued-for-retry"
            ? { kind: "queued-for-retry", retryId: detail.retryId }
            : { kind: "business-rejected", status: detail.status },
        deadline.signal
      ));
    } catch (err) {
      reportOperationalError(deps, "submissionStore.complete", err);
      return {
        kind: "forward-failed",
        forwardFailureReason: "submission_complete_failed",
        sessionId,
        score: decision.score,
        submittedEmail,
        disposition: decision.disposition,
      };
    }
    const upstreamCreated = detail.kind === "created";
    // P1-10: await durability of store finalization
    await finalizeStores(deps, sessionId, deadline.signal);
    return {
      kind: "admit",
      disposition: decision.disposition,
      upstreamCreated,
      enforcementDetail: detail,
      sessionId,
      score: decision.score,
      submittedEmail,
      risk: riskProjection,
    };
  } catch (err) {
    // FR-P0-02: an evaluation error BEFORE the claim needs no release —
    // no claim exists (the corrected-retry guarantee). An error AFTER the
    // claim but BEFORE the forward call (e.g. a strip/cookie failure) must
    // RELEASE the claim as a definite transport failure — nothing was sent,
    // so the session may legitimately retry. If the release fails the claim
    // stays held (fail closed: a later retry gets conflict rather than risk
    // a second forward on unknown state).
    if (claim !== undefined) {
      try {
        await deadline.run(deps.submissionStore.complete(claim.claimId, {
          kind: "transport-failure",
          reason: "eval_error",
        }, deadline.signal));
      } catch (completeErr) {
        reportOperationalError(deps, "submissionStore.complete(eval_error)", completeErr);
      }
    }
    // FR-P0-03: the exception is FireRaid/host infrastructure failing —
    // an operational error (5xx), never an applicant-facing denial. The
    // account is not created (fail closed preserved); the classification
    // no longer lies about whose fault it was. A FR-P1-11 deadline expiry
    // is named distinctly so an ops dashboard can tell a rare hang from a
    // routine evaluation fault.
    reportOperationalError(deps, "handleSubmitPost.evaluate", err);
    return {
      kind: "error",
      operationalReason: err instanceof DeadlineError ? "ADAPTER_DEADLINE" : "SUBMIT_EVAL_ERROR",
    };
  }
}
