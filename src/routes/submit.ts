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
} from "../cloudflare/session-envelope.js";
import { loadSession } from "../cloudflare/session.js";;
import { getPolicy } from "../core/decision.js";
import { reconstructIssuedProfile } from "../core/reconstruct.js";
import type { DefenseRecipe } from "../core/recipe-schema.js";
import { readLabAssignment } from "../core/lab-assignment.js";
import { checkCsrf } from "../security/csrf.js";
import { defaultVerificationProvider } from "../turnstile/verify.js";
import { correlate, type ObservationSet } from "../core/correlation.js";
import { decide } from "../core/decision.js";
import { MAX_SUBMIT_BODY_BYTES } from "../types/telemetry.js";
import { isLabMode } from "../env.js";
import {
  validateTelemetryBatch,
  ingestTelemetryBatch,
  type ValidatedEvent,
} from "./telemetry.js";
import { aggregateSessionTelemetry, loadSessionMetrics, mergeSessionMetrics, type SessionMetricsRead } from "../telemetry/aggregate.js";
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

  // 2. resolve session
  // FR-P1-19: let — reassigned to the canonical (envelope-unwrapped) id
  // after ensureSessionRow.
  let sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  // FR-P1-19: submit is a stateful first action — materializes the
  // stateless production session row from the signed envelope.
  const session = await ensureSessionRow(env, sessionId);
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

  // 3. body size limit — FR-R6-024: BYTE-based, not UTF-16 code units.
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_SUBMIT_BODY_BYTES) {
    return error("payload too large", 413);
  }

  // 4. parse + validate
  let body: SubmitBody;
  try {
    const text = await req.text();
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > MAX_SUBMIT_BODY_BYTES) {
      return error("payload too large", 413);
    }
    body = JSON.parse(text) as SubmitBody;
  } catch {
    return error("invalid JSON", 400);
  }

  // FR-R6-025: bounded form schema validation.
  let form: Record<string, string>;
  {
    const checked = validateSignupForm(body.form ?? {});
    if (!checked.ok) return error(checked.reason, 400);
    form = checked.form;
  }

  // 5. CSRF
  if (!body.csrf || !(await checkCsrf(env, sessionId, body.csrf))) {
    return error("invalid CSRF token", 403);
  }

  // FIX: 6. Turnstile is now an EXPLICIT GATE, not a heuristic
  // FR-R2-003: Turnstile failure does NOT finalize session.
  // FR-R5-013 + FR-R6-021: the lab run's turnstile_required IS the assigned
  // treatment. Resolution failure fails the trial — it never falls back to
  // global config (that would scramble treatment assignment).
  let turnstileRequired: boolean;
  if (isLabMode(env)) {
    let run: { turnstile_required: number | null } | null;
    try {
      run = await env.DB.prepare(
        `SELECT turnstile_required FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
      )
        .bind(sessionId)
        .first<{ turnstile_required: number | null }>();
    } catch (err) {
      console.error("lab turnstile condition unreadable:", err);
      return error("lab condition unavailable", 500);
    }
    if (!run) {
      // No bound lab run for this session in lab mode: use global config.
      turnstileRequired = Boolean(env.TURNSTILE_SECRET_KEY);
    } else if (run.turnstile_required === null) {
      // Bound run with an unresolved condition — refuse to guess.
      return error("lab turnstile condition unresolved", 500);
    } else {
      turnstileRequired = run.turnstile_required === 1;
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
      await recordVerificationAttempt(env, sessionId, false, "missing_token", true).catch(() => {});
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
    await recordVerificationAttempt(
      env,
      sessionId,
      turnstileResult.ok,
      turnstileResult.ok ? undefined : (turnstileResult.errorCodes?.join(",") ?? "verification_failed"),
      isLabMode(env) || !turnstileResult.ok || env.FIRERAID_AUDIT_VERIFICATION_ATTEMPTS === "1"
    ).catch(() => {});
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
    let turnstileRequired: boolean | undefined;
    if (isLabMode(env)) {
      // P1-AUDIT-2: FAIL CLOSED on bound-assignment read errors (shared helper
      // readLabAssignment, also used by canary.ts). The prior code caught a D1
      // error and treated it as "unbound", silently reconstructing a RANDOM
      // profile for a session that was actually bound to a specific lab
      // condition — corrupting the experiment (an assigned FULL run could be
      // scored as random). readLabAssignment distinguishes:
      //   - query SUCCEEDS, no lab_runs row  → genuinely unbound → random (legit)
      //   - query THROWS / recipe_json corrupt → infrastructure failure → 500
      // A bound session's immutable treatment is never replaceable by a guess.
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
      if (read.assignment?.recipe != null) recipe = read.assignment.recipe;
      // FR-POST-R6-P5: holdout flag is part of the treatment identity.
      holdoutMode = read.assignment?.holdoutMode;
      // FR-P0-17: verification condition likewise.
      turnstileRequired = read.assignment?.turnstileRequired;
    }
    const reconstructed = await reconstructIssuedProfile(env, {
      id: sessionId,
      profileVersion: session.profileVersion,
      profileKeyId: session.profileKeyId ?? null,
    }, recipe, { holdoutMode, turnstileRequired });
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

  // 9. inspect canary evidence (causal hits recorded during this session)
  // FR-R7-020: skip the canary_hits COUNT when the profile has no
  // decoyRoute — the answer is necessarily zero and the query is wasted
  // work on every defended submission.
  if (profile.decoyRoute) {
    const canaryRow = await env.DB
      .prepare(
        `SELECT COUNT(*) AS hits FROM canary_hits WHERE session_id = ? AND verified = 1`
      )
      .bind(sessionId)
      .first<{ hits: number }>();
    if (canaryRow && canaryRow.hits > 0) {
      observations.canaryEndpointHit = true;
    }
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
    // P1-AUDIT-2 (P0-7): the read is an INTEGRITY result. "complete" carries
    // behavioral evidence; "incomplete" means the server KNOWS the compact
    // window is truncated (raw rows pruned/missing) and MUST NOT convert
    // known-incomplete data into behavioral evidence — interaction
    // observations stay unset, which under scoring can only ever make the
    // decision LESS incriminating (fail-open for the user, never evidence).
    // Lab mode bypasses this entirely: the raw aggregator is the
    // research-authoritative path and raw rows are always retained there.
    let read: SessionMetricsRead | null = !isLabMode(env)
      ? await loadSessionMetrics(env.DB, sessionId).catch(() => null)
      : null;
    if (read && read.status === "incomplete") {
      console.warn(
        `interaction metrics incomplete (through ${read.actualThrough}, expected ${read.expectedThrough}) — scoring without interaction evidence`
      );
      read = null;
    }
    let metrics: TelemetryMetrics | null = read?.metrics ?? null;
    if (!metrics) {
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
    }
  }

  // 11. correlate + decide
  // FR-R6-017: the profile's OWN scoring policy decides — strict-v1 and
  // permissive-v1 are real treatments, not labels.
  const policy = getPolicy(profile.scoringPolicy);
  const evidence = await correlate(profile, observations);
  const decision = decide(evidence, policy);

  // FIX: 12. Atomic submission finalization (FR-R2-007 / FR-R6-015/016):
  // session claim + submission INSERT + evidence INSERTs in ONE db.batch via
  // D1SubmissionFinalizer. A failed insert can no longer leave
  // session.submitted=1 with no submission record.
  const finalizer = new D1SubmissionFinalizer(env.DB);
  const publicId = randomUUID();
  const { claimed } = await finalizer.finalizeSubmission({
    sessionClaim: { sessionId, score: decision.score, disposition: decision.disposition },
    submission: {
      publicId,
      sessionId,
      createdAt: Date.now(),
      // FR-P0-16: reality, not a constant — false when no challenge ran.
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
function projectFinalized(env: Env, disposition: string, score: number, alreadySubmitted: boolean): Response {
  if (isLabMode(env)) {
    return json({ status: "received", disposition, score, alreadySubmitted });
  }
  const workflowState = disposition === "ACCEPT" ? "ACCEPT" : "REVIEW";
  return json({ status: "received", disposition: workflowState, alreadySubmitted });
}

/**
 * Project decision response based on environment (FR-R2-004).
 */
function projectDecisionResponse(env: Env, decision: { disposition: string; score: number; signals: unknown[]; reasons: string[] }): Response {
  if (isLabMode(env)) {
    return json({
      status: "received",
      disposition: decision.disposition,
      score: decision.score,
    });
  } else {
    // Production: only expose workflow state
    const workflowState = decision.disposition === "ACCEPT" ? "ACCEPT" : "REVIEW";
    return json({
      status: "received",
      disposition: workflowState,
    });
  }
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
