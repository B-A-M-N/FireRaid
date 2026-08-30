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
  loadSession,
} from "../cloudflare/session.js";;
import { getPolicy } from "../core/decision.js";
import { reconstructFromSessionId } from "../core/reconstruct.js";
import type { DefenseRecipe } from "../core/recipe-schema.js";
import { checkCsrf } from "../security/csrf.js";
import { verifyTurnstile } from "../turnstile/verify.js";
import { correlate, type ObservationSet } from "../core/correlation.js";
import { decide } from "../core/decision.js";
import { MAX_SUBMIT_BODY_BYTES } from "../types/telemetry.js";
import { isLabMode } from "../env.js";
import { validateTelemetryBatch, persistTelemetryBatch } from "./telemetry.js";
import { aggregateSessionTelemetry } from "../telemetry/aggregate.js";
import { D1SubmissionFinalizer } from "../cloudflare/session-store.js";
import { randomUUID } from "node:crypto";

interface SubmitBody {
  csrf?: string;
  turnstileToken?: string;
  form?: Record<string, string>;
  eventBatch?: unknown;
}

/** FR-R6-025: bounded form validation (count / key length / value length). */
const MAX_FORM_FIELDS = 64;
const MAX_FORM_KEY_BYTES = 64;
const MAX_FORM_VALUE_BYTES = 4096;

function validateForm(form: unknown): { ok: true; form: Record<string, string> } | { ok: false; reason: string } {
  if (typeof form !== "object" || form === null || Array.isArray(form)) {
    return { ok: false, reason: "form must be an object" };
  }
  const entries = Object.entries(form as Record<string, unknown>);
  if (entries.length > MAX_FORM_FIELDS) {
    return { ok: false, reason: "too many form fields" };
  }
  const out: Record<string, string> = {};
  const enc = new TextEncoder();
  for (const [key, value] of entries) {
    if (typeof value !== "string") return { ok: false, reason: `form value for "${key}" is not a string` };
    if (enc.encode(key).length > MAX_FORM_KEY_BYTES) return { ok: false, reason: "form key too long" };
    if (enc.encode(value).length > MAX_FORM_VALUE_BYTES) return { ok: false, reason: `form value for "${key}" too long` };
    out[key] = value;
  }
  return { ok: true, form: out };
}

export async function submit(req: Request, env: Env): Promise<Response> {
  // 1. method + content-type
  if (req.method !== "POST") return error("method not allowed", 405);

  // FIX: Validate Content-Type
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  // 2. resolve session
  const sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  const session = await loadSession(env.DB, sessionId);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);

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
    const checked = validateForm(body.form ?? {});
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

  // FR-R6-020: required + verifier unavailable = configuration failure.
  // Never silently turn a required experimental treatment off.
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  if (turnstileRequired && !turnstileSecret) {
    console.error("Turnstile required but TURNSTILE_SECRET_KEY is not configured");
    return error("turnstile configuration error", 500);
  }
  if (turnstileRequired && turnstileSecret) {
    if (!body.turnstileToken) {
      // FR-R6-022: record the missing-token attempt.
      await recordVerificationAttempt(env, sessionId, false, "missing_token").catch(() => {});
      return json({
        status: "verification_required",
        message: "Turnstile verification required. Please complete the challenge.",
      }, 403);
    }
    const turnstileResult = await verifyTurnstile({
      token: body.turnstileToken,
      secret: turnstileSecret,
      expectedAction: "fireraid_signup",
      // FR-R6-019: hostname + remote IP enforcement restored.
      expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME,
      remoteip: req.headers.get("cf-connecting-ip") ?? undefined,
    });
    // FR-R6-022: every verification attempt is recorded.
    await recordVerificationAttempt(
      env,
      sessionId,
      turnstileResult.ok,
      turnstileResult.ok ? undefined : (turnstileResult.errorCodes?.join(",") ?? "verification_failed")
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
  let profile;
  {
    let recipeJson: string | undefined;
    let holdoutMode: boolean | undefined;
    try {
      const row = await env.DB.prepare(
        `SELECT recipe_json, holdout_mode FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
      )
        .bind(sessionId)
        .first<{ recipe_json: string | null; holdout_mode: number | null }>();
      const raw = row?.recipe_json;
      if (typeof raw === "string" && raw.length > 0) recipeJson = raw;
      // FR-POST-R6-P5: holdout flag is part of the treatment identity.
      if (row && row.holdout_mode !== null) holdoutMode = row.holdout_mode === 1;
    } catch {
      recipeJson = undefined; // unbound session — random lab/production profile
    }
    let recipe: DefenseRecipe | undefined;
    if (recipeJson !== undefined) {
      try {
        recipe = JSON.parse(recipeJson) as DefenseRecipe;
      } catch {
        recipe = undefined;
      }
    }
    const reconstructed = await reconstructFromSessionId(env, sessionId, {
      profileVersion: session.profileVersion,
      recipe,
      holdoutMode,
    });
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
  const canaryRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS hits FROM canary_hits WHERE session_id = ? AND verified = 1`
    )
    .bind(sessionId)
    .first<{ hits: number }>();
  if (canaryRow && canaryRow.hits > 0) {
    observations.canaryEndpointHit = true;
  }

  // FIX: 10. Process eventBatch from submit (FR-R2-008, FR-R2-009)
  // FR-R5-018: watermark-gated persist.
  // FR-R6-026: structural validation failures (TOO_MANY_EVENTS,
  // MALFORMED_EVENT, SEQ_ORDER_VIOLATION) are rejected — an invalid batch is
  // NEVER silently discarded at submit time. Oversize arrays are 413.
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
      try {
        await persistTelemetryBatch(env.DB, sessionId, validated.events);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
          return error("payload too large", 413);
        }
        // Watermark/identity violations at submit: the final telemetry batch
        // may have already been delivered via /api/events — treat duplicate
        // delivery as benign, log anything else.
        console.warn("telemetry persist at submit failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  // FR-R6-018: interaction evidence — aggregate the session's telemetry and
  // populate the observation set when the interaction family is scoring.
  if (profile.interaction?.scoringEnabled) {
    try {
      const metrics = await aggregateSessionTelemetry(env.DB, sessionId, {
        capturePointer: profile.telemetry.capturePointer,
        captureKey: profile.telemetry.captureKey,
      });
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
    } catch (err) {
      // Telemetry aggregation failure must not block submission.
      console.warn("interaction aggregation failed:", err instanceof Error ? err.message : err);
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
      turnstileOk: true,
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
 * FR-R6-022: record a Turnstile verification attempt for research
 * auditability. Best-effort — recording failure never blocks submission.
 */
async function recordVerificationAttempt(
  env: Env,
  sessionId: string,
  ok: boolean,
  errorCode: string | undefined
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO verification_attempts (session_id, created_at, provider, result, error_codes_json) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, Date.now(), "turnstile", ok ? "success" : "failure", errorCode ?? null)
    .run();
}
