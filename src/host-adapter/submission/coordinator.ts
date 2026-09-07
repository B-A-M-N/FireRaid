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
import { deriveCanaryReference, type ObservationSet } from "../../core/correlation.js";
import { correlateByVersion, getScoringPolicyByVersion, decideByVersion } from "../../core/scoring-versions.js";
import { ScoringPolicyShapeError } from "../../core/scoring-errors.js";
import { SESSION_RESPONSE_FIELD } from "../../core/artifacts.js";
import {
  projectRisk,
  getRiskTier,
  DEFAULT_RISK_TIERS,
  resolveRuntimeDisposition,
} from "../../core/risk.js";
import { aggregateTelemetry, type CaptureConfig } from "../../telemetry/aggregate.js";
import type { SubmitInbound } from "../../security/request-validation.js";
import type { DefenseProfile } from "../../types/profile.js";
import { buildForwardCookieHeader } from "../forward-security.js";
import { DeadlineSignal, DeadlineError, DEFAULT_DURABILITY_TIMEOUT_MS } from "../deadline.js";
import { ProfileHashMismatchError } from "../middleware-errors.js";
import { submissionIdempotencyKey } from "../interface.js";
import type {
  VerificationInput,
  HostSubmissionClaim,
  FinalSubmissionOutcome,
  FinalizeDecisionResult,
  AssessmentSnapshot,
  EnforcementResult,
} from "../interface.js";
import { parseClaimResult, parseStoredRecord } from "./store-parsers.js";
import type {
  MiddlewareDeps,
  MiddlewareResult,
  EvaluationControls,
} from "../middleware-types.js";
import { DEFAULT_FORWARD_COOKIE_ALLOWLIST } from "../middleware-types.js";
import { reportOperationalError, finalizeStores } from "../lifecycle/store-finalization.js";
import { resolveKeySecret, deriveAndVerifyIssuedProfile } from "../profile/resolve-session-profile.js";

/**
 * P0-8 hardening, tightened by FR-RR-29: SEMANTIC runtime validation for
 * the discriminated enforcement result. The static type says
 * `EnforcementResult`, but the seam is a host callback — a JS host (or a
 * half-migrated one) can hand back anything, including shapes that pass a
 * presence/type check while lying (`status: NaN`, a 2xx/5xx dressed as a
 * business rejection, a non-boolean `uncertain`). Only contract kinds with
 * field values in their DOCUMENTED ranges pass; anything else fails the
 * receipt policy closed downstream (an invalid shape is normalized to an
 * UNCERTAIN transport failure, never a definite outcome).
 */
export function isValidEnforcementResult(v: unknown): v is EnforcementResult {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  switch (kind) {
    case "created":
      return true;
    case "business-rejected": {
      // FR-RR-29: the documented business-rejection range is an INTEGER
      // 4xx. NaN is a number and must not pass; a 200 or 503 "business
      // rejection" would misclassify the upstream's own answer.
      const status = (v as { status?: unknown }).status;
      return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500;
    }
    case "queued-for-retry": {
      const retryId = (v as { retryId?: unknown }).retryId;
      return typeof retryId === "string" && retryId.length > 0;
    }
    case "transport-failure": {
      const reason = (v as { reason?: unknown }).reason;
      const uncertain = (v as { uncertain?: unknown }).uncertain;
      return typeof reason === "string" && reason.length > 0 &&
        (uncertain === undefined || typeof uncertain === "boolean");
    }
    default:
      return false;
  }
}

/**
 * FR-RR-40: SEMANTIC runtime validation of the finalizeDecision answer.
 * The static type says `FinalizeDecisionResult`, but the seam is a host
 * callback — a JS host can hand back `42`, `{kind:"nonsense"}`, or a
 * "stored" missing its record. Validating ONLY by exception (try/catch)
 * would let a malformed NON-throwing answer fall through the conflict and
 * replay branches and be treated as a SUCCESSFUL first-write terminal
 * denial — FireRaid would project a deny on a session whose durable state
 * it never actually wrote. Only the three documented kinds, each with its
 * required fields in documented shape, pass.
 */
export function isValidFinalizeDecisionResult(v: unknown): v is FinalizeDecisionResult {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "stored" || kind === "replay") {
    const record = (v as { record?: unknown }).record;
    if (typeof record !== "object" || record === null) return false;
    // The echoed record must at least carry a KNOWN terminal outcome kind —
    // the coordinator reads outcome.kind (stored path asserts decision-denied
    // semantics; replay path surfaces the record verbatim) and passes the
    // assessment through. An unknown-kind record is a malformed answer.
    const outcomeKind = (record as { outcome?: { kind?: unknown } }).outcome?.kind;
    return (
      outcomeKind === "created" ||
      outcomeKind === "business-rejected" ||
      outcomeKind === "queued-for-retry" ||
      outcomeKind === "transport-failure" ||
      outcomeKind === "decision-denied"
    );
  }
  if (kind === "conflict") {
    const state = (v as { state?: unknown }).state;
    return state === "forward-claimed" || state === "forward-uncertain";
  }
  return false;
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

/**
 * FR-RR-21/23: project a VALIDATED terminal record into the replayed
 * receipt. The stored record IS the receipt: the applicant gets the same
 * neutral result as the request that actually did the work, the upstream
 * is never called again, and the ORIGINAL assessment rides along
 * (`replayed` orthogonal to the semantic disposition). A validated
 * `decision-denied` record replays as the original decision deny; a legacy
 * assessment-less record (pre-FR-RR-14 store) degrades explicitly.
 */
function replayReceipt(
  sessionId: string,
  stored: { outcome: FinalSubmissionOutcome; assessment: AssessmentSnapshot | null }
): MiddlewareResult {
  if (stored.outcome.kind === "decision-denied") {
    // A decision denial replays as the SAME denial — never re-evaluated,
    // never forwarded. decisionDenied keeps the runtime's neutral-receipt
    // projection (the applicant plane sees what the original saw).
    return {
      kind: "deny",
      disposition: stored.outcome.disposition,
      decisionDenied: true,
      sessionId,
      replayed: true,
      ...(stored.assessment
        ? {
            score: stored.assessment.score,
            submittedEmail: stored.assessment.submittedEmail,
            risk: stored.assessment.risk,
          }
        : {}),
    };
  }
  return {
    kind: "admit",
    upstreamCreated: stored.outcome.kind === "created",
    sessionId,
    disposition: stored.assessment?.disposition ?? "REPLAY",
    replayed: true,
    ...(stored.assessment
      ? {
          score: stored.assessment.score,
          submittedEmail: stored.assessment.submittedEmail,
          risk: stored.assessment.risk,
        }
      : {}),
    ...(stored.outcome.kind !== "created" ? { enforcementDetail: stored.outcome } : {}),
  };
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
  /**
   * FR-RR-12: the profile hash SIGNED into the session's fr2 envelope, when
   * the carrier is fr2. The coordinator's derivation verifies against it —
   * a mismatch fails closed BEFORE any evaluation, claim, or forward.
   */
  profileHash?: string;
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
  // Closure 4 (FR-P1-11) / FR-RR-08: every post-boundary durability write
  // runs under its OWN full budget — a fresh DeadlineSignal per operation,
  // cleared when it settles. It must be separate from the request deadline
  // (a forward that consumed most of the request budget leaves that
  // deadline spent, and a complete() raced against it would fail INSTANTLY
  // with a DeadlineError it had no fair chance to beat). The earlier
  // memoized-one-window implementation gave the FIRST write the full budget
  // and every later write whatever happened to remain; the documented
  // contract is per-operation.
  const durabilityTimeoutMs = deps.durabilityTimeoutMs ?? DEFAULT_DURABILITY_TIMEOUT_MS;
  async function withDurabilityDeadline<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const d = new DeadlineSignal(durabilityTimeoutMs);
    try {
      return await d.run(op(d.signal));
    } finally {
      d.clear();
    }
  }

  // Replay check WITHOUT claiming (P0-E fix): the old flow claimed the
  // forward slot merely to discover a finalized outcome, so any early
  // failure AFTER the claim (unknown profile key, verification failure,
  // invalid telemetry, …) left the slot open forever and every corrected
  // retry collided with it. lookupFinal returns the stored record, if any,
  // without touching the claim state.
  //
  // FR-RR-21: the lookup now also serves DECISION-denied sessions — a
  // decision-denied terminal record replays here exactly like a forward
  // outcome, so a retry after a failed onAssessment (or any later POST)
  // never re-evaluates a session whose admission story is already
  // terminal.
  const idempotencyKey = submissionIdempotencyKey(sessionId);
  let stored: { outcome: FinalSubmissionOutcome; assessment: AssessmentSnapshot | null } | null = null;
  let lookupInvalid = false;
  try {
    const raw = await deadline.run(
      deps.submissionStore.lookupFinal
        ? deps.submissionStore.lookupFinal(sessionId, deadline.signal)
        : Promise.resolve(null)
    );
    stored = parseStoredRecord(raw, sessionId);
    // FR-RR-23: a NON-NULL answer that fails to parse is a malformed host
    // answer, not "no record" — treating it as absent would fail OPEN and
    // let the request re-evaluate/re-forward on data nobody could read.
    if (raw !== null && raw !== undefined && stored === null) {
      lookupInvalid = true;
    }
  } catch (err) {
    // A lookup THROWN error is operational noise on a read: report it and
    // proceed (the forward path will claim and re-check, fail closed).
    reportOperationalError(deps, "submissionStore.lookupFinal", err);
  }
  if (lookupInvalid) {
    reportOperationalError(
      deps,
      "submissionStore.lookupFinal",
      new Error("malformed terminal record from lookupFinal — failing closed")
    );
    return { kind: "forward-failed", forwardFailureReason: "submission_claim_invalid" };
  }
  if (stored) {
    // FR-RR-42: a stored DECISION-denied record whose deny PROJECTION is
    // still "pending" (the previous request failed between the durable
    // record and enforcement.deny) must be REPAIRED before the receipt
    // leaves — the host queue annotation is part of the denial's story.
    // The re-deny is idempotent by contract; only after it lands (and the
    // completion marker is durable) does the replay acknowledge.
    if (
      stored.outcome.kind === "decision-denied" &&
      deps.submissionStore.denyProjectionState
    ) {
      try {
        const projection = await deadline.run(
          deps.submissionStore.denyProjectionState(sessionId, deadline.signal)
        );
        if (projection === "pending") {
          await deadline.run(
            deps.enforcement.deny(
              sessionId,
              stored.outcome.disposition,
              stored.assessment?.risk as never,
              deadline.signal
            )
          );
          await withDurabilityDeadline(
            (signal) =>
              deps.submissionStore.markDenyProjectionComplete?.(sessionId, signal) ??
              Promise.resolve()
          );
        }
      } catch (err) {
        // Repair failed: the receipt must NOT acknowledge — the host's
        // denial record still may not exist. Fail closed (retryable).
        reportOperationalError(deps, "enforcement.deny(replay-repair)", err);
        return {
          kind: "forward-failed",
          forwardFailureReason: "submission_deny_projection_failed",
          sessionId,
          ...(stored.assessment ? { score: stored.assessment.score } : {}),
        };
      }
    }
    return replayReceipt(sessionId, stored);
  }

  try {
    let profileSecret: string;
    try {
      profileSecret = resolveKeySecret(ring, ctx.keyId);
    } catch {
      // FR-RR-07: every adapter call follows the deadline contract — this
      // deny previously ran un-wrapped, so a broken host deny() could hang
      // the request indefinitely on exactly this path.
      await deadline.run(
        deps.enforcement.deny(sessionId, "UNKNOWN_PROFILE_KEY", undefined, deadline.signal)
      );
      return { kind: "deny", disposition: "UNKNOWN_PROFILE_KEY" };
    }
    const profile = await deriveAndVerifyIssuedProfile({
      secret: profileSecret,
      version: ctx.deriveVersion,
      sessionId,
      expectedHash: ctx.profileHash,
      evaluation: ctx.evaluation,
      labMode: ctx.labMode,
      // FR-RR-27: the adapter DECLARED the issued-hash capability at wiring
      // time — a verified context without the signed hash means the
      // adapter broke its own guarantee. Fail closed rather than evaluate
      // an unverifiable treatment.
      requireIssuedHash: !ctx.evaluation,
    });

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

    // FR-RR-15: correlation + policy + decision route through the profile's
    // OWN version — the FROZEN evidence model and policy table for that
    // version decide, never the live modules (a v2 change cannot mutate
    // what a pv=1 session decides). Unsupported version / unknown policy
    // fail closed (deny, never default-score under a different rule).
    let evidence;
    let policy;
    try {
      evidence = await correlateByVersion(profile, observations);
      // P1-AUDIT-2 (P1-2): the profile's OWN scoring policy decides —
      // strict-v1 / permissive-v1 are real treatments on the host plane
      // too.
      policy = getScoringPolicyByVersion(profile.version, profile.scoringPolicy);
    } catch (err) {
      // FR-RR-34: a scoring CONFIGURATION failure (unsupported version,
      // unknown policy) is an OPERATIONAL error, not an applicant offense —
      // the invariant "infrastructure/configuration failure ≠ applicant
      // rejection" holds on this path too. No deny annotation (which
      // blames the session), no forward: a generic operational 5xx is the
      // honest answer, identical in class to any other evaluation error.
      reportOperationalError(deps, "handleSubmitPost.scoring", err instanceof ScoringPolicyShapeError ? err : new Error(String(err)));
      return { kind: "error", operationalReason: "SCORING_CONFIG_ERROR" };
    }
    const decision = decideByVersion(profile, evidence, policy);

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
    // FR-RR-14: the immutable assessment snapshot. If it is persisted with
    // the terminal outcome, every replay of this session reproduces THIS
    // assessment exactly — original disposition, score, email, and risk
    // evidence — instead of a degraded receipt. Keyed by sessionId: a host
    // upserting assessments on it can never duplicate a review row.
    const assessmentSnapshot: AssessmentSnapshot = {
      sessionId,
      ...(submittedEmail !== undefined ? { submittedEmail } : {}),
      // FR-RR-55: BOTH dispositions — the core decision (what the evidence
      // + policy called) and the runtime form the boundary actually acted
      // on. A replay can now reproduce the honest pair: core QUARANTINE
      // under a review-mode deployment shows QUARANTINE/REVIEW, not a
      // fabricated REVIEW-only story.
      disposition: decision.disposition,
      runtimeDisposition,
      score: decision.score,
      risk: riskProjection,
    };

    // In advisory mode, every submission is forwarded with an annotation so
    // the upstream/manual-review workflow can see FireRaid's evidence.
    // In review/enforcement, only ACCEPT proceeds automatically; REVIEW/
    // QUARANTINE are denied (the host's queue can pick them up from the
    // annotation if desired).
    if (runtimeDisposition !== "ACCEPT") {
      // ── FR-RR-21: the DECISION-DENY TERMINAL TRANSACTION ─────────────────
      // A denial is as terminal as any forward outcome: the session's
      // causal evidence is about to be finalized away, so the denial and
      // its assessment snapshot MUST be durable FIRST. Ordering matters:
      //
      //   1. finalizeDecision — the terminal record (outcome + assessment)
      //      lands durably. If this write FAILS, nothing downstream runs:
      //      the request fails (5xx) with evidence stores intact, so the
      //      client's retry re-evaluates against the FULL evidence — never
      //      a half-cleared session that could flip to ACCEPT.
      //   2. enforcement.deny — the host's queue annotation.
      //   3. finalizeStores — evidence cleanup. After this, the ONLY thing
      //      a retry can find is the terminal denial record.
      //
      // A retry therefore replays the ORIGINAL denial (same disposition,
      // same score, same evidence) — a decision can never be re-litigated
      // into a forward after its evidence was cleared.
      const decisionOutcome: FinalSubmissionOutcome = {
        kind: "decision-denied",
        // FR-RR-55 (revising the prior "faithful-replay" reading): the
        // outcome carries the disposition the boundary ACTUALLY ENFORCED —
        // `runtimeDisposition` — because that is what the host's deny
        // annotation was issued for. The snapshot's TWO disposition fields
        // preserve the full story (core + runtime), so the replay is still
        // indistinguishable from the first answer while no longer claiming
        // a core QUARANTINE became a "QUARANTINE" deny on a review-mode
        // deployment that actually issued REVIEW.
        disposition: runtimeDisposition === "QUARANTINE" ? "QUARANTINE" : "REVIEW",
      };
      let finalizeResult;
      try {
        finalizeResult = await withDurabilityDeadline((signal) =>
          deps.submissionStore.finalizeDecision(
            sessionId,
            // FR-RR-26: every NEW terminal record is v2 — the assessment
            // snapshot is mandatory, so the replay is never degraded.
            { version: 2, outcome: decisionOutcome, assessment: assessmentSnapshot },
            signal
          )
        );
      } catch (err) {
        // The terminal record did not land: keep the evidence stores
        // UNFINALIZED and fail the request closed (5xx). The client's
        // retry re-evaluates the SAME session with its evidence intact —
        // the honest fallback (a fresh decision on full evidence), never
        // a denial whose audit trail evaporated.
        reportOperationalError(deps, "submissionStore.finalizeDecision", err);
        return {
          kind: "forward-failed",
          forwardFailureReason: "submission_decision_finalize_failed",
          sessionId,
          score: decision.score,
          submittedEmail,
          disposition: decision.disposition,
          risk: riskProjection,
        };
      }
      if (!isValidFinalizeDecisionResult(finalizeResult)) {
        // FR-RR-40: a malformed NON-throwing answer is a host-contract
        // violation, not "stored" — treating it as a successful first write
        // would project a deny against durable state nobody wrote. Fail
        // closed: no deny side effect, no evidence cleanup.
        reportOperationalError(
          deps,
          "submissionStore.finalizeDecision",
          new Error("malformed FinalizeDecisionResult — failing closed")
        );
        return {
          kind: "forward-failed",
          forwardFailureReason: "submission_decision_finalize_failed",
          sessionId,
          score: decision.score,
          submittedEmail,
          disposition: decision.disposition,
          risk: riskProjection,
        };
      }
      // FR-RR-40: every result kind is handled — never ignored.
      if (finalizeResult.kind === "conflict") {
        // Another request owns — or may own — the irreversible forward
        // (FORWARD_CLAIMED: mid-flight; FORWARD_UNCERTAIN: unknown upstream
        // outcome). This request must NOT deny, NOT overwrite the durable
        // state, and NOT clear the other request's evidence. The honest
        // answer for the applicant is the same forward-failed retryable
        // shape the claim-conflict path returns; the winning request's
        // outcome will replay on the retry. FORWARD_UNCERTAIN additionally
        // means no retry can ever resolve the session — log it so the
        // operator-reconciliation need is visible.
        if (finalizeResult.state === "forward-uncertain") {
          reportOperationalError(
            deps,
            "submissionStore.finalizeDecision",
            new Error(
              `session ${sessionId} is FORWARD_UNCERTAIN — a decision denial was refused; operator reconciliation is required`
            )
          );
        }
        return {
          kind: "forward-failed",
          // Both conflict states surface the same retryable receipt reason;
          // the DISTINCTION is preserved in the durable state (and the
          // operational log for an uncertain state, which only operator
          // reconciliation may resolve).
          forwardFailureReason: "submission_claim_conflict",
          sessionId,
          score: decision.score,
          submittedEmail,
          disposition: decision.disposition,
          risk: riskProjection,
        };
      }
      if (finalizeResult.kind === "replay") {
        // FR-RR-40: a concurrent request finalized this session FIRST (its
        // record outranks our fresh evaluation). Surface ITS outcome —
        // never run deny-side effects against a finalized session whose
        // record may say CREATED. The replay receipt reproduces the
        // original record exactly.
        return replayReceipt(sessionId, {
          outcome: finalizeResult.record.outcome,
          assessment: finalizeResult.record.assessment,
        });
      }
      // kind "stored" — this request owns the terminal denial. P1-10:
      // await durability of the deny annotation (e.g. for a host that
      // persists review-queue data asynchronously). FR-RR-42: the deny is
      // a PROJECTION of the durable record (born "pending"); a failure
      // here fails the request 5xx with the record durable, and the retry
      // repairs the projection (below) before acknowledging.
      try {
        await deadline.run(deps.enforcement.deny(sessionId, decision.disposition, riskProjection, deadline.signal));
      } catch (err) {
        reportOperationalError(deps, "enforcement.deny(decision-deny)", err);
        return {
          kind: "forward-failed",
          forwardFailureReason: "submission_deny_projection_failed",
          sessionId,
          score: decision.score,
          submittedEmail,
          disposition: decision.disposition,
          risk: riskProjection,
        };
      }
      try {
        await withDurabilityDeadline((signal) =>
          deps.submissionStore.markDenyProjectionComplete?.(sessionId, signal) ?? Promise.resolve()
        );
      } catch (err) {
        // The projection landed but its completion marker did not — the
        // retry's repair path (denyProjectionState → pending) re-runs the
        // IDEMPOTENT deny and re-marks. Fail the request closed.
        reportOperationalError(deps, "submissionStore.markDenyProjectionComplete", err);
        return {
          kind: "forward-failed",
          forwardFailureReason: "submission_deny_projection_failed",
          sessionId,
          score: decision.score,
          submittedEmail,
          disposition: decision.disposition,
          risk: riskProjection,
        };
      }
      try {
        await withDurabilityDeadline((signal) => finalizeStores(deps, sessionId, signal));
      } catch (err) {
        // Evidence cleanup failed AFTER the terminal record is durable:
        // operational noise — the replay path serves the denial regardless.
        reportOperationalError(deps, "finalizeStores(post-decision-deny)", err);
      }
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
    //
    // Closure 4 (FR-P1-11): from this point EVERY durability write (complete,
    // finalizeStores) runs under its OWN fresh durability budget via
    // withDurabilityDeadline — never the request deadline (a forward that
    // consumed most of the request budget would otherwise leave that
    // deadline spent, and the first post-forward write would fail INSTANTLY
    // with a DeadlineError it had no fair chance to beat: the claim would
    // stay open after a `created` forward, or the uncertain marking would
    // never land), and never a shared window a previous write could have
    // drained (FR-RR-08).
    {
      // FR-RR-22: the claim result is a host-callback answer guarding the
      // irreversible boundary — it is PARSED, not trusted. A claimed result
      // must carry a non-empty claimId and the EXACT idempotency key
      // requested; a replay must carry a whitelisted outcome; anything
      // malformed (missing fields, wrong key, unknown kind, null, a bare
      // primitive) is an operational error and the forward NEVER proceeds.
      let parsed;
      try {
        parsed = parseClaimResult(
          await deadline.run(deps.submissionStore.claim(sessionId, idempotencyKey, deadline.signal)),
          idempotencyKey,
          sessionId
        );
      } catch (err) {
        reportOperationalError(deps, "submissionStore.claim", err);
        return { kind: "forward-failed", forwardFailureReason: "submission_claim_failed" };
      }
      if (parsed === null) {
        reportOperationalError(
          deps,
          "submissionStore.claim",
          new Error("malformed claim result — failing closed at the irreversible boundary")
        );
        return { kind: "forward-failed", forwardFailureReason: "submission_claim_invalid" };
      }
      if (parsed.kind === "replay") {
        // Another request did the work between lookupFinal and the claim:
        // its stored record is the receipt; the upstream is never called.
        // FR-RR-14: the original assessment (disposition/score/email/risk)
        // replays with it, `replayed` orthogonal to the semantic
        // disposition. A store still speaking the pre-FR-RR-14 replay shape
        // degrades to an assessment-less record instead of crashing.
        return replayReceipt(sessionId, { outcome: parsed.outcome, assessment: parsed.assessment });
      }
      if (parsed.kind !== "claimed") {
        return { kind: "forward-failed", forwardFailureReason: "submission_claim_conflict" };
      }
      claim = parsed.claim;
    }
    // The claim is owned from here; a local const keeps TS narrowing intact
    // inside the closures below even after the outer `claim` variable is
    // dropped at the terminal complete (FR-RR-08 part 2).
    const activeClaim: HostSubmissionClaim = claim;

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
    let enforcementResult: EnforcementResult;
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
        await withDurabilityDeadline((signal) =>
          deps.submissionStore.complete(activeClaim.claimId, {
            kind: "transport-failure",
            reason: err instanceof DeadlineError ? "adapter_deadline" : "enforcement_allow_failed",
            uncertain: true,
          }, signal)
        );
      } catch (completeErr) {
        reportOperationalError(deps, "submissionStore.complete(allow-deadline)", completeErr);
      }
      return {
        kind: "forward-failed",
        // R0: name the actual cause — the store already received the
        // correctly-conditioned reason ("adapter_deadline" vs
        // "enforcement_allow_failed"); the receipt must not flatten every
        // adapter throw into a deadline story.
        forwardFailureReason: err instanceof DeadlineError ? "adapter_deadline" : "enforcement_allow_failed",
        sessionId,
        submittedEmail,
      };
    }
    // FR-RR-24: the legacy bare boolean is GONE from the production
    // contract — the discriminated shape is the only answer the seam may
    // give. FR-RR-29: any MALFORMED or out-of-range shape (a string, null,
    // a wrong-keyed object, `status: NaN`, a 2xx/5xx dressed as a business
    // rejection, `uncertain: "yes"`) FAILS CLOSED as an UNCERTAIN
    // transport failure: the middleware cannot know what the adapter did,
    // so the slot is held (never released for an automatic retry that
    // could create a duplicate) and no success receipt is possible — the
    // FR-INV-008 violation the taxonomy exists to prevent, closed in both
    // directions.
    const detail: EnforcementResult = isValidEnforcementResult(enforcementResult)
      ? enforcementResult
      : { kind: "transport-failure", reason: "malformed_enforcement_result", uncertain: true };
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
        await withDurabilityDeadline((signal) =>
          deps.submissionStore.complete(activeClaim.claimId, detail, signal)
        );
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
    // The forward reached a TERMINAL captured state (created /
    // business-rejected / queued-for-retry). From here the transaction IS
    // complete the moment this write lands: FR-RR-08 (part 2) — the
    // best-effort finalizeStores below runs AFTER the outcome is durable
    // and its failure must NEVER re-enter the claim-release path (the old
    // flow let a finalizeStores throw fall into the outer catch, which —
    // seeing the claim still set — wrote a transport-failure over a
    // durably-recorded terminal outcome and reinterpreted a completed
    // transaction as a submission failure). The try/catch below ends the
    // claim's lifecycle: `claim` is dropped before finalize runs.
    try {
      await withDurabilityDeadline((signal) =>
        deps.submissionStore.complete(
          activeClaim.claimId,
          detail.kind === "created"
            ? { kind: "created" }
            : detail.kind === "queued-for-retry"
              ? { kind: "queued-for-retry", retryId: detail.retryId }
              : { kind: "business-rejected", status: detail.status },
          // FR-RR-25: the historical argument order is preserved — the
          // deadline stays third, the assessment rides in the trailing
          // meta object so a pre-FR-RR-14 adapter's `signal` parameter
          // never receives a snapshot object.
          signal,
          // FR-RR-14/26: the assessment snapshot is durable BEFORE the
          // receipt leaves — a retry after a failed onAssessment replays
          // this exact assessment instead of a degraded one.
          { assessment: assessmentSnapshot }
        )
      );
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
    // The claim's lifecycle ended at the terminal complete — drop it so no
    // later failure (finalizeStores below) can release a claim that already
    // recorded its outcome.
    claim = undefined;
    // P1-10: await durability of store finalization under its OWN full
    // budget — finalization must never be starved by a spent request
    // deadline NOR by whatever an earlier durability write consumed
    // (FR-RR-08). A finalization failure here is operational noise (the
    // applicant outcome is already durable); it is logged, never allowed
    // to fail the request.
    try {
      await withDurabilityDeadline((signal) => finalizeStores(deps, sessionId, signal));
    } catch (err) {
      reportOperationalError(deps, "finalizeStores(post-created)", err);
    }
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
    // a second forward on unknown state). The release is raced against the
    // DURABILITY window, never the request deadline: a DeadlineError thrown
    // by an expired request deadline is exactly the case where the request
    // deadline is spent, and racing the release against it would fail
    // instantly and leave the claim open.
    if (claim !== undefined) {
      // Capture locally: `claim` is reassigned at the terminal complete, so
      // TS narrowing cannot see this guard inside the closure.
      const heldClaim = claim;
      try {
        await withDurabilityDeadline((signal) =>
          deps.submissionStore.complete(heldClaim.claimId, {
            kind: "transport-failure",
            reason: "eval_error",
          }, signal)
        );
      } catch (completeErr) {
        reportOperationalError(deps, "submissionStore.complete(eval_error)", completeErr);
      }
    }
    // FR-P0-03: the exception is FireRaid/host infrastructure failing —
    // an operational error (5xx), never an applicant-facing denial. The
    // account is not created (fail closed preserved); the classification
    // no longer lies about whose fault it was. A FR-P1-11 deadline expiry
    // is named distinctly so an ops dashboard can tell a rare hang from a
    // routine evaluation fault, and FR-RR-12 names the signed-profile-hash
    // mismatch (a deployment-derivation straddle) separately from both.
    reportOperationalError(deps, "handleSubmitPost.evaluate", err);
    return {
      kind: "error",
      operationalReason: err instanceof ProfileHashMismatchError
        ? "PROFILE_HASH_MISMATCH"
        : err instanceof DeadlineError
          ? "ADAPTER_DEADLINE"
          : "SUBMIT_EVAL_ERROR",
    };
  }
}
