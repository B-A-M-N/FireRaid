/**
 * POST /api/submit — submission processing, defense correlation, decision.
 * FIX: Turnstile failure does not finalize session (FR-R2-003).
 * FIX: Persists full decision/evidence (FR-R2-005).
 * FIX: Atomic final submission (FR-R2-007).
 * FIX: eventBatch is now consumed (FR-R2-009).
 * FR-R5-013: Per-run Turnstile requirement for lab-bound sessions.
 * FR-R6-015/016: atomic finalization via D1SubmissionFinalizer (session claim
 *   + submission INSERT + evidence INSERTs in ONE db.batch) — evidence is
 *   persisted, and a failed insert can no longer leave session.submitted=1
 *   with no submission record.
 * FR-R6-017: scoring uses the profile's scoring policy.
 * FR-R6-018: interaction evidence restored via aggregateSessionTelemetry.
 * FR-R6-019: Turnstile hostname (+ remote IP) verification restored.
 * FR-R6-020/021: required-but-unavailable Turnstile and lab condition
 *   resolution failures FAIL the trial — they never silently disable a
 *   treatment.
 * FR-R6-022: verification attempts recorded for lab/research auditability.
 * FR-R6-023: ALL finalized responses (resubmission + raced loser) go through
 *   the same projection as the primary path.
 * FR-R6-024: byte-based body limit (TextEncoder), not UTF-16 units.
 * FR-R6-025: bounded form validation restored.
 * FR-R6-026: oversize/invalid telemetry at submit → 413, not silent drop.
 * FR-R6-004: profile reconstruction via the canonical reconstructIssuedProfile.
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  isExpired,
} from "../core/session.js";
import {
  ensureSessionRow,
  verifyEnvelopeOnly,
} from "../cloudflare/session-envelope.js";
import { loadSession } from "../cloudflare/session.js";;
import { reconstructIssuedProfile } from "../core/reconstruct.js";
import type { DefenseRecipe } from "../core/recipe-schema.js";
import { readLabAssignment, type LabAssignment } from "../core/lab-assignment.js";
import { checkCsrf } from "../security/csrf.js";
import { defaultVerificationProvider } from "../turnstile/verify.js";
import { deriveCanaryReference, type ObservationSet } from "../core/correlation.js";
import { correlateByVersion, getScoringPolicyByVersion, decideByVersion } from "../core/scoring-versions.js";
import { SESSION_RESPONSE_FIELD } from "../core/artifacts.js";
import { MAX_SUBMIT_BODY_BYTES } from "../types/telemetry.js";
import { readJsonBody } from "../security/body-limits.js";
import { isLabMode } from "../env.js";
import {
  validateTelemetryBatch,
  ingestTelemetryBatch,
  type ValidatedEvent,
} from "./telemetry.js";
import { aggregateSessionTelemetry, loadSessionMetrics, mergeSessionMetrics } from "../cloudflare/session-metrics.js";
import { validateSignupForm } from "../security/request-validation.js";
import type { TelemetryMetrics } from "../telemetry/aggregate.js";
import { D1SubmissionFinalizer } from "../cloudflare/session-store.js";
import { randomUUID } from "node:crypto";

interface SubmitBody {
  csrf?: string;
  turnstileToken?: string;
  form?: Record<string, string>;
  eventBatch?: unknown;
}

// P1-AUDIT-2 (P1-3): the bounded form validation moved to
// security/request-validation.ts — ONE implementation for the Worker route
// and the host middleware (the prior two drifted; the host had no caps).

export async function submit(req: Request, env: Env): Promise<Response> {
  // 1. method + content-type
  if (req.method !== "POST") return error("method not allowed", 405);

  // FIX: Validate Content-Type
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  // 2. resolve session.
  // FR-P1-19 + FR-P1-08: `let` — reassigned to the canonical (envelope-
  // unwrapped) id AFTER materialization. The envelope (production) is HMAC-
  // verified here with ZERO D1 writes so a forged cookie is rejected before
  // any parse work; the verified inner sid is what the CSRF was keyed on at
  // signup (the CSRF is a pure HMAC — no D1 — so it can be checked before
  // materialization).
  const rawCookieSid = getSessionId(req);
  if (!rawCookieSid) return error("no session", 403);
  const envelope = await verifyEnvelopeOnly(env, rawCookieSid);
  const csrfSid = envelope.ok ? envelope.sid : rawCookieSid;

  // FR-P1-08: validate the request FULLY before any D1 write. The production
  // stateless session row is only materialized (ensureSessionRow, below) after
  // the body parses, the form validates, and the CSRF/challenge passes — a
  // malformed body, invalid form, or forged CSRF turns into a 4xx with ZERO
  // D1 writes. (For a FORGED production envelope, verifyEnvelopeOnly failed
  // above; the materialize step below re-verifies and refuses with no INSERT.)

  // 3+4. parse + validate — FR-P1-02 closure: the bounded streaming reader
  // replaces the old read-then-check pattern (Content-Length pre-check plus a
  // full req.text() buffer). The body is now counted AS IT ARRIVES and the
  // read cancelled the moment the cap is crossed.
  const bodyRead = await readJsonBody(req, MAX_SUBMIT_BODY_BYTES);
  if (!bodyRead.ok) {
    return error(
      bodyRead.reason === "OVERSIZE" ? "payload too large" : "invalid JSON",
      bodyRead.reason === "OVERSIZE" ? 413 : 400
    );
  }
  const body = bodyRead.data as SubmitBody;

  // FR-R6-025: bounded form schema validation.
  let form: Record<string, string>;
  {
    const checked = validateSignupForm(body.form ?? {});
    if (!checked.ok) return error(checked.reason, 400);
    form = checked.form;
  }

  // 5. CSRF (pure HMAC over the csrf secret + the session id the token was
  // issued against — no D1).
  if (!body.csrf || !(await checkCsrf(env, csrfSid, body.csrf))) {
    return error("invalid CSRF token", 403);
  }

  // The request is valid enough to warrant state — materialize the session
  // row now (the first D1 mutation on this request), or load it if it already
  // exists (lab sessions / prior stateful action). A forged production
  // envelope is refused here without an INSERT.
  let sessionId = rawCookieSid;
  const session = await ensureSessionRow(env, rawCookieSid);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);
  // FR-P1-19: canonical id — FK targets materialize under the envelope's
  // inner sid, never the envelope string.
  sessionId = session.id;

  // FIX: Check for resubmission (idempotent)
  // FR-R6-023: goes through the SAME projection as the primary path — the
  // raw stored disposition (QUARANTINE, real score) must not leak to
  // production clients.
  if (session.submitted) {
    return projectFinalized(env, session.finalDisposition ?? "REVIEW", session.finalScore ?? 0, true);
  }

  // FIX: 6. Turnstile is now an EXPLICIT GATE, not a heuristic
  // FR-R2-003: Turnstile failure does NOT finalize session.
  // FR-R5-013 + FR-R6-021: the lab run's turnstile_required IS the assigned
  // treatment. Resolution failure fails the trial — it never falls back to
  // global config (that would scramble treatment assignment).
  // P1-AUDIT-2 (P1-3): ONE lab_runs read serves BOTH consumers (the
  // Turnstile gate below and the profile reconstruction at step 7). The
  // prior code issued a bare SELECT here and a second readLabAssignment()
  // later — two reads of the SAME immutable assignment per lab submit,
  // which besides the extra D1 round-trip could observe a mid-request
  // rebind (the reads are not in one transaction) and derive the recipe
  // from a DIFFERENT row than the gate consulted. The assignment is bound
  // at signup and never mutates; one read, one truth.
  let labAssignment: LabAssignment | null = null;
  if (isLabMode(env)) {
    const read = await readLabAssignment(env.DB, sessionId);
    if (!read.ok) {
      console.error(
        "submit lab-assignment read failed (failing closed):",
        `${read.code}: ${read.detail}`
      );
      return error(
        read.code === "assignment_corrupt" ? "session assignment corrupt" : "session assignment unreadable",
        500
      );
    }
    labAssignment = read.assignment;
  }
  let turnstileRequired: boolean;
  if (isLabMode(env)) {
    if (labAssignment === null) {
      // No bound lab run for this session in lab mode: use global config.
      turnstileRequired = Boolean(env.TURNSTILE_SECRET_KEY);
    } else if (labAssignment.turnstileRequired === undefined) {
      // Bound run with an unresolved condition (turnstile_required NULL) —
      // refuse to guess.
      return error("lab turnstile condition unresolved", 500);
    } else {
      turnstileRequired = labAssignment.turnstileRequired;
    }
  } else {
    turnstileRequired = Boolean(env.TURNSTILE_SECRET_KEY);
  }
  // FR-P0-16: provider identity defaults to "none" — the truthful name for a
  // submission that was never challenged.
  let verificationProvider = "none";

  // FR-R6-020: required + verifier unavailable = configuration failure.
  // Never silently turn a required experimental treatment off.
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  if (turnstileRequired && !turnstileSecret) {
    console.error("Turnstile required but TURNSTILE_SECRET_KEY is not configured");
    return error("turnstile configuration error", 500);
  }
  if (turnstileRequired && turnstileSecret) {
    if (!body.turnstileToken) {
      // FR-R6-022 + FR-R7-021: missing-token attempts are always recorded
      // (every production signup benefits from a forensic trail of
      // unverified submissions; this path represents a deliberate gap).
      // FR-RR-39: persistence is best-EFFORT, not best-SILENT — a failed
      // write on the FORENSIC path is surfaced (production logs; lab fails
      // the request — research auditability is the lab contract, a silently
      // missing record violates it).
      await persistVerificationAttemptOrHonestFailure(
        env, sessionId, false, "missing_token", true,
      );
      return json({
        status: "verification_required",
        message: "Turnstile verification required. Please complete the challenge.",
      }, 403);
    }
    // FR-R7-026: the route depends on a VerificationProvider, not on the
    // Turnstile implementation directly. Cloudflare's reference deployment
    // configures the Turnstile provider via env; other deployments can
    // swap implementations in defaultVerificationProvider().
    const provider = defaultVerificationProvider(env);
    if (!provider) {
      return error("verification provider unavailable", 500);
    }
    // FR-P0-16: record WHO adjudicated. The submissions row carries the
    // provider name so analysis can distinguish a real challenge from an
    // unchallenged submission.
    verificationProvider = provider.name;
    const turnstileResult = await provider.verify({
      token: body.turnstileToken,
      expectedAction: "fireraid_signup",
      // FR-R6-019: hostname + remote IP enforcement restored.
      expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME,
      remoteip: req.headers.get("cf-connecting-ip") ?? undefined,
    });
    // FR-R6-022 + FR-R7-021: every verification attempt is recorded.
    // FR-R7-021: in PRODUCTION we only persist the row on FAILURE unless the
    // operator explicitly opted into full audit logging via
    // FIRERAID_AUDIT_VERIFICATION_ATTEMPTS=1 — successful production
    // signups already record turnstile_ok on the submission, so an extra
    // row per signup is pure D1 amplification. Lab mode keeps full records
    // because research auditability is part of the experimental contract.
    await persistVerificationAttemptOrHonestFailure(
      env,
      sessionId,
      turnstileResult.ok,
      turnstileResult.ok ? undefined : (turnstileResult.errorCodes?.join(",") ?? "verification_failed"),
      isLabMode(env) || !turnstileResult.ok || env.FIRERAID_AUDIT_VERIFICATION_ATTEMPTS === "1"
    );
    if (!turnstileResult.ok) {
      // Do NOT finalize session on Turnstile failure.
      return json({
        status: "verification_required",
        message: "Turnstile verification failed. Please try again.",
      }, 403);
    }
  }

  // 7. reconstruct profile via the canonical service (FR-R6-004): lab recipe
  //    + persisted profile key id are honored, so reconciliation sees the
  //    profile that was actually issued.
  // FR-R7-018: pass the loaded session's key id straight through — no
  // second session SELECT.
  // FR-R7-019: lab_runs query only in lab mode.
  let profile;
  {
    let recipe: DefenseRecipe | undefined;
    let holdoutMode: boolean | undefined;
    // FR-P0-17: the run's verification condition — same treatment-identity
    // rule as holdout_mode (part of the hashed variant id).
    let turnstileRequiredForId: boolean | undefined;
    if (isLabMode(env)) {
      // P1-AUDIT-2: FAIL CLOSED on bound-assignment read errors (shared helper
      // readLabAssignment, also used by canary.ts). P1-3: the SAME single
      // read taken for the Turnstile gate above — the assignment was already
      // fetched (or the request already failed closed); no second query.
      // readLabAssignment distinguishes:
      //   - query SUCCEEDS, no lab_runs row  → genuinely unbound → random (legit)
      //   - query THROWS / recipe_json corrupt → infrastructure failure → 500
      // A bound session's immutable treatment is never replaceable by a guess.
      if (labAssignment?.recipe != null) recipe = labAssignment.recipe;
      // FR-POST-R6-P5: holdout flag is part of the treatment identity.
      holdoutMode = labAssignment?.holdoutMode;
      // FR-P0-17: verification condition likewise.
      turnstileRequiredForId = labAssignment?.turnstileRequired;
    }
    const reconstructed = await reconstructIssuedProfile(env, {
      id: sessionId,
      profileVersion: session.profileVersion,
      profileKeyId: session.profileKeyId ?? null,
      // FR-P0-04: the hash persisted at issuance — a reconstructed profile
      // that no longer matches it is drift, and drift fails closed.
      profileHash: session.profileHash,
    }, recipe, { holdoutMode, turnstileRequired: turnstileRequiredForId });
    if (!reconstructed.ok) {
      console.error("submit reconstruction failed:", reconstructed.code, reconstructed.detail);
      return error("profile reconstruction failed", 500);
    }
    profile = reconstructed.profile;
  }

  // 8. build observations
  const observations: ObservationSet = {};

  // FR-R6-029: decoy-field observation uses decoyField specifically —
  // DECOY_ROUTE_ONLY sessions have no field to observe.
  if (profile.decoyField) {
    const decoyValue = form[profile.decoyField.fieldName];
    // FIX: Only count non-empty field as evidence (FR-R2-011)
    if (decoyValue && decoyValue !== "") {
      observations.decoyFieldPopulated = true;
      if (profile.semantic && decoyValue === profile.semantic.nonce) {
        observations.decoyFieldMatchesNonce = true;
      }
    }
  }

  // Server-derived canary reference: an agent that pasted the semantic trap
  // text (nonce) into a VISIBLE field is reproducing hidden instruction
  // material — server-verifiable behavioral evidence. (The decoy field's
  // own fill has its own, stronger evidence path.)
  if (profile.semantic && deriveCanaryReference(profile, form)) {
    observations.semanticNonceEcho = true;
  }

  // E5 lever 1: the session_response actuator sink. Route-armed strategies
  // (P02/P04) instruct the fill; any non-empty value is the compliant act,
  // scored Class-A (SESSION_RESPONSE_PROVIDED) via correlate().
  if (profile.semantic && profile.decoyRoute) {
    const resp = form[SESSION_RESPONSE_FIELD];
    if (resp && resp !== "") observations.sessionResponsePopulated = true;
  }

  // 9. inspect canary evidence (causal hits recorded during this session)
  // FR-R7-020: skipped entirely when the profile has no decoyRoute.
  // P1-9: the verified-hit boolean is compacted onto the session row at hit
  // time (canary.ts persistVerifiedHit, same batch as the hit insert) and
  // arrives here via the session SELECT submit already performed — no
  // per-submission canary_hits COUNT round-trip. Legacy rows (flag NULL)
  // fall back to the COUNT exactly once, on sessions that predate
  // migration 0014.
  if (profile.decoyRoute) {
    let hit: boolean;
    if (session.causalRouteHit === 1) {
      hit = true;
    } else if (session.causalRouteHit === 0) {
      hit = false;
    } else {
      const canaryRow = await env.DB
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM canary_hits WHERE session_id = ? AND verified = 1) AS hit`
        )
        .bind(sessionId)
        .first<{ hit: number }>();
      hit = canaryRow?.hit === 1;
    }
    if (hit) observations.canaryEndpointHit = true;
  }

  // FIX: 10. Process eventBatch from submit (FR-R2-008, FR-R2-009)
  // FR-R5-018: watermark-gated persist.
  // FR-R6-026: structural validation failures (TOO_MANY_EVENTS,
  // MALFORMED_EVENT, SEQ_ORDER_VIOLATION) are rejected — an invalid batch is
  // NEVER silently discarded at submit time. Oversize arrays are 413.
  // FR-P0-3: the SAME canonical ingestion as /api/events — the final batch
  // often overlaps what /api/events already stored (client retries, pagehide
  // race). The overlap is stripped here and only the never-stored suffix is
  // persisted + folded, so a submit-time suffix can no longer silently
  // vanish before scoring.
  let finalTelemetryBatch: ValidatedEvent[] = [];
  if (body.eventBatch !== undefined) {
    if (!Array.isArray(body.eventBatch)) {
      return error("eventBatch must be an array", 400);
    }
    const validated = validateTelemetryBatch(body.eventBatch);
    if (!validated.ok) {
      const status = validated.code === "TOO_MANY_EVENTS" ? 413 : 400;
      return error(`telemetry rejected: ${validated.code}`, status);
    }
    if (validated.events.length > 0) {
      const outcome = await ingestTelemetryBatch(env.DB, sessionId, validated.events);
      switch (outcome.kind) {
        case "too_large":
          return error("payload too large", 413);
        case "failed":
          // Storage failure at submit: the submission itself can still be
          // finalized, but interaction scoring would silently read a stream
          // missing its final events. Treat as a hard 5xx — the client
          // retains its queue and can retry the whole submit.
          console.error("telemetry persist at submit failed");
          return error("telemetry storage failure", 500);
        case "conflict":
          // Concurrent writer covered this range. The authoritative stream
          // is complete; fold nothing new. (outcome.acceptedThrough is
          // server truth.)
          break;
        case "accepted":
          finalTelemetryBatch = outcome.stored;
          break;
      }
      // Fold the newly-stored suffix into the compact metrics state so
      // scoring below sees the complete session. Production only.
      if (!isLabMode(env) && finalTelemetryBatch.length > 0) {
        try {
          await mergeSessionMetrics(
            env.DB,
            sessionId,
            finalTelemetryBatch,
            {
              capturePointer: profile.telemetry.capturePointer,
              captureKey: profile.telemetry.captureKey,
            }
          );
        } catch (mergeErr) {
          console.warn("session_metrics merge at submit failed:", mergeErr);
        }
      }
    }
  }

  // FR-R6-018: interaction evidence — aggregate the session's telemetry and
  // populate the observation set when the interaction family is scoring.
  // FR-P0-1: production reads the compact incremental state (the same state
  // machine proven equivalent to full aggregation by the parity test) in ONE
  // D1 row read; lab mode uses the raw aggregator for research fidelity.
  if (profile.interaction?.scoringEnabled) {
    // Telemetry state is tri-valued and preserved through submission:
    //   complete      -> score compact metrics (authoritative behavioral evidence)
    //   incomplete    -> NO interaction evidence (known unsafe to score)
    //   absent        -> explicitly chosen fail-open/no-evidence policy
    //
    // "incomplete" means the server KNOWS the compact window is truncated
    // (raw rows pruned/missing) and MUST NOT convert known-incomplete data
    // into behavioral evidence — interaction observations stay unset, which
    // under scoring can only ever make the decision LESS incriminating
    // (fail-open for the user, never evidence). Lab mode bypasses this
    // entirely: the raw aggregator is the research-authoritative path and
    // raw rows are always retained there.
    let telemetryState: "complete" | "incomplete" | "absent" = "absent";
    let metrics: TelemetryMetrics | null = null;

    if (!isLabMode(env)) {
      const read = await loadSessionMetrics(env.DB, sessionId, {
        capturePointer: profile.telemetry.capturePointer,
        captureKey: profile.telemetry.captureKey,
      }).catch(() => null);

      if (read) {
        telemetryState = read.status;
        if (read.status === "complete" && read.metrics) {
          metrics = read.metrics;
        } else if (read.status === "incomplete") {
          // Known-incomplete: do NOT fall through to raw aggregation.
          // Partial behavioral history from pruned raw rows must never be
          // scored as interaction evidence.
          console.warn(
            `interaction metrics incomplete (through ${read.actualThrough}, expected ${read.expectedThrough}) — scoring without interaction evidence`
          );
        }
        // absent: metrics stays null, no evidence emitted.
      }
    }

    if (!metrics && telemetryState === "absent") {
      // No compact row at all (or lab mode): fall back to raw aggregation
      // only when the state is genuinely "absent" — NOT when the server
      // already knows the data is incomplete.
      try {
        metrics = await aggregateSessionTelemetry(env.DB, sessionId, {
          capturePointer: profile.telemetry.capturePointer,
          captureKey: profile.telemetry.captureKey,
        });
      } catch (err) {
        // Telemetry aggregation failure must not block submission.
        console.warn("interaction aggregation failed:", err instanceof Error ? err.message : err);
        metrics = null;
      }
    }

    if (metrics) {
      observations.directFill = metrics.directFill;
      // veryShortCompletion: no dedicated metric field — completionMs < 3s is
      // the definition used by the aggregator's own thresholds.
      if (metrics.completionMs > 0 && metrics.completionMs < 3000) {
        observations.veryShortCompletion = true;
      }
      // capture-gated signals are undefined (unknown) when capture was off —
      // assigning them only when true keeps "capture disabled" from scoring
      // against the user.
      if (metrics.noPointerEvents === true) observations.noPointerEvents = true;
      if (metrics.missingInteractionSequence === true) observations.missingInteractionSequence = true;
      // E5 lever 5: interaction-depth signals (undefined when not scorable).
      if (metrics.zeroDwellFill === true) observations.zeroDwellFill = true;
      if (metrics.uniformCadence === true) observations.uniformCadence = true;
      if (metrics.noBlurBeforeSubmit === true) observations.noBlurBeforeSubmit = true;
    }
  }

  // 11. correlate + decide
  // FR-R6-017: the profile's OWN scoring policy decides — strict-v1 and
  // permissive-v1 are real treatments, not labels. STRICT lookup: an unknown
  // policy name is a configuration/derivation error, never a silent
  // default-v1 score (the profile and the decision plane must agree).
  // FR-RR-15: correlation + policy + decision route through the profile's
  // OWN version (the frozen evidence model + policy table), never the live
  // modules — a v2 change cannot mutate what a pv=1 session decides.
  const policy = getScoringPolicyByVersion(profile.version, profile.scoringPolicy);
  const evidence = await correlateByVersion(profile, observations);
  const decision = decideByVersion(profile, evidence, policy);

  // FIX: 12. Atomic submission finalization (FR-R2-007 / FR-R6-015/016):
  // session claim + submission INSERT + evidence INSERTs in ONE db.batch via
  // D1SubmissionFinalizer. A failed insert can no longer leave
  // session.submitted=1 with no submission record.
  const finalizer = new D1SubmissionFinalizer(env.DB);
  const publicId = randomUUID();
  // P0-2: create a review-queue entry for REVIEW/QUARANTINE dispositions
  // so human reviewers can see FireRaid's annotation.
  const createReviewEntry = decision.disposition !== "ACCEPT";
  const { claimed } = await finalizer.finalizeSubmission({
    sessionClaim: { sessionId, score: decision.score, disposition: decision.disposition },
    submission: {
      publicId,
      sessionId,
      createdAt: Date.now(),
      // FR-P0-16: reality, not a constant — false when no challenge ran.
      turnstileOk: verificationProvider !== "none",
      verificationProvider,
      causalHits: decision.signals.filter((e) => e.class === "A").length,
      strongHits: decision.signals.filter((e) => e.class === "B").length,
      weakHits: decision.signals.filter((e) => e.class === "C").length,
      riskScore: decision.score,
      disposition: decision.disposition,
      policy: decision.policy,
      reasons: decision.reasons,
    },
    evidence: decision.signals.map((e) => ({
      evidenceClass: e.class,
      source: e.source,
      weight: e.weight,
      verified: e.verified,
      metadata: (e.metadata ?? {}) as Record<string, unknown>,
    })),
    createReviewEntry,
  });

  if (!claimed) {
    // Another request already finalized this session.
    // FR-R6-023: the raced loser goes through the SAME projection.
    const currentSession = await loadSession(env.DB, sessionId);
    return projectFinalized(
      env,
      currentSession?.finalDisposition ?? "REVIEW",
      currentSession?.finalScore ?? 0,
      true
    );
  }

  // 13. respond (FIX: FR-R2-004 - proper response projection)
  return projectDecisionResponse(env, decision);
}

/**
 * FR-R6-023: shared projection for finalized-but-replayed responses.
 * Production clients see only workflow state, never the real disposition
 * or risk score.
 */
export function projectFinalized(env: Env, disposition: string, score: number, alreadySubmitted: boolean): Response {
  if (isLabMode(env)) {
    return json({ status: "received", disposition, score, alreadySubmitted });
  }
  // Audit item 24 (applicant opacity): production NEVER reveals the internal
  // disposition — FI reviews every application manually anyway, so an
  // ACCEPT/REVIEW differential would let an autonomous agent iterate on its
  // own submissions and learn the defenses. Every valid submission sees the
  // same neutral receipt.
  return json({ status: "received", message: "Submission received.", alreadySubmitted });
}

/**
 * Project decision response based on environment (FR-R2-004).
 *
 * Audit item 24: the production surface is the neutral receipt regardless of
 * the core decision, the advisory-forward disposition, or the risk projection.
 * Lab mode keeps full internal state for the harness.
 */
export function projectDecisionResponse(
  env: Env,
  decision: { disposition: string; score: number; signals: unknown[]; reasons: string[] },
  runtimeDisposition?: string,
  risk?: { tier: string; confidence: string; recommendedAction: string }
): Response {
  if (isLabMode(env)) {
    return json({
      status: "received",
      disposition: runtimeDisposition ?? decision.disposition,
      score: decision.score,
      risk,
    });
  }
  return json({ status: "received", message: "Submission received." });
}

/**
 * FR-R6-022 + FR-R7-021: record a Turnstile verification attempt.
 * `persist` defaults to true; FR-R7-021 flips it false for successful
 * production signups unless full audit logging is explicitly enabled.
 * Best-effort — recording failure never blocks submission.
 */
async function recordVerificationAttempt(
  env: Env,
  sessionId: string,
  ok: boolean,
  errorCode: string | undefined,
  persist: boolean = true
): Promise<void> {
  if (!persist) return;
  await env.DB.prepare(
    `INSERT INTO verification_attempts (session_id, created_at, provider, result, error_codes_json) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, Date.now(), "turnstile", ok ? "success" : "failure", errorCode ?? null)
    .run();
}

/**
 * FR-RR-39 — persistence HONESTY for the verification-attempt trail. The
 * old `.catch(() => {})` swallowed EVERY write failure, so a D1 outage on
 * a FAILED verification silently deleted the forensic record of a blocked
 * bot — the audit trail claimed a completeness it did not have, and lab
 * research (whose contract IS the record) ran on a silent hole. Now:
 *   - PRODUCTION: the attempt outcome itself is unaffected (a verification
 *     row write outage must not turn a bot rejection into a 5xx for the
 *     applicant), but the loss is LOUD — an error log naming the session.
 *   - LAB: the write failure FAILS THE REQUEST (500). Research
 *     auditability is part of the lab contract; a silently missing record
 *     would corrupt experiments downstream.
 */
async function persistVerificationAttemptOrHonestFailure(
  env: Env,
  sessionId: string,
  ok: boolean,
  errorCode: string | undefined,
  persist: boolean
): Promise<void> {
  try {
    await recordVerificationAttempt(env, sessionId, ok, errorCode, persist);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isLabMode(env)) {
      console.error(
        `verification attempt persistence FAILED (lab, session ${sessionId}) — failing the request (FR-RR-39): ${detail}`
      );
      throw err;
    }
    console.error(
      `verification attempt persistence FAILED (production, session ${sessionId}) — ` +
        `the forensic trail is INCOMPLETE for this attempt: ${detail}`
    );
  }
}
