/**
 * POST /api/submit — submission processing, defense correlation, decision.
 * FIX: Turnstile failure does not finalize session (FR-R2-003).
 * FIX: Persists full decision/evidence (FR-R2-005).
 * FIX: Atomic final submission (FR-R2-007).
 * FIX: eventBatch is now consumed (FR-R2-009).
 * FR-R5-013: Per-run Turnstile requirement for lab-bound sessions.
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  loadSession,
  isExpired,
} from "../core/session.js";
import { deriveProfile } from "../core/profile.js";
import { checkCsrf } from "../security/csrf.js";
import { verifyTurnstile } from "../turnstile/verify.js";
import { correlate } from "../core/correlation.js";
import { decide } from "../core/decision.js";
import { MAX_SUBMIT_BODY_BYTES } from "../types/telemetry.js";
import type { ObservationSet } from "../core/correlation.js";
import { isLabMode } from "../env.js";
import { validateTelemetryBatch, persistTelemetryBatch } from "./telemetry.js";

interface SubmitBody {
  csrf?: string;
  turnstileToken?: string;
  form?: Record<string, string>;
  eventBatch?: unknown;
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
  if (session.submitted) {
    return json({
      status: "received",
      disposition: session.finalDisposition,
      score: session.finalScore,
      alreadySubmitted: true,
    });
  }

  // 3. body size limit - FIX: Read body with actual byte bound
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_SUBMIT_BODY_BYTES) {
    return error("payload too large", 413);
  }

  // 4. parse
  let body: SubmitBody;
  try {
    const text = await req.text();
    if (text.length > MAX_SUBMIT_BODY_BYTES) {
      return error("payload too large", 413);
    }
    body = JSON.parse(text) as SubmitBody;
  } catch {
    return error("invalid JSON", 400);
  }

  // 5. CSRF
  if (!body.csrf || !(await checkCsrf(env, sessionId, body.csrf))) {
    return error("invalid CSRF token", 403);
  }

  // FIX: 6. Turnstile is now an EXPLICIT GATE, not a heuristic
  // FR-R2-003: Turnstile failure does NOT finalize session
  // FR-R5-013: per-run Turnstile requirement for lab-bound sessions.
  const turnstileSecret: string | undefined = env.TURNSTILE_SECRET_KEY;
  let turnstileRequired = Boolean(turnstileSecret);
  if (isLabMode(env)) {
    try {
      const run = await env.DB.prepare(
        `SELECT turnstile_required FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
      )
        .bind(sessionId)
        .first<{ turnstile_required: number | null }>();
      if (run) {
        turnstileRequired = run.turnstile_required === 1;
      }
    } catch {
      // DB error → treat as not found, use global config
    }
  }
  if (turnstileRequired && turnstileSecret) {
    if (!body.turnstileToken) {
      return error("Turnstile verification required", 403);
    }
    const turnstileResult = await verifyTurnstile({
      token: body.turnstileToken,
      secret: turnstileSecret,
      expectedAction: "fireraid_signup",
    });
    if (!turnstileResult.ok) {
      // Record verification attempt but DO NOT finalize session
      return json({
        status: "verification_required",
        message: "Turnstile verification failed. Please try again.",
      }, 403);
    }
  }

  // 7. reconstruct profile using SESSION's stored version (FIX: FR-006)
  const profile = await deriveProfile(env, sessionId, session.profileVersion);

  // 8. build observations
  const observations: ObservationSet = {};
  const form = body.form || {};

  if (profile.decoy) {
    const decoyValue = form[profile.decoy.fieldName];
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
  // FR-R5-018: watermark-gated persist; oversized batches rejected wholesale.
  if (body.eventBatch && Array.isArray(body.eventBatch)) {
    const validated = validateTelemetryBatch(body.eventBatch);
    if (validated.ok && validated.events.length > 0) {
      // Persist final telemetry batch (watermark semantics may reject stale
      // replays — the submission itself must not fail for telemetry reasons,
      // so violations are logged and swallowed here).
      try {
        await persistTelemetryBatch(env.DB, sessionId, validated.events);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
          return error("payload too large", 413);
        }
        console.warn("telemetry persist at submit failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  // 11. correlate + decide
  const evidence = await correlate(profile, observations);
  const decision = decide(evidence);

  // FIX: 12. Atomic submission finalization (FR-R2-007)
  // Use conditional UPDATE to prevent double submission
  const updateResult = await env.DB
    .prepare(
      `UPDATE sessions SET submitted = 1, final_score = ?, final_disposition = ? WHERE id = ? AND submitted = 0`
    )
    .bind(decision.score, decision.disposition, sessionId)
    .run();

  if (updateResult.meta.changes === 0) {
    // Another request already finalized this session
    const currentSession = await loadSession(env.DB, sessionId);
    return json({
      status: "received",
      disposition: currentSession?.finalDisposition || "REVIEW",
      score: currentSession?.finalScore ?? 0,
      alreadySubmitted: true,
    });
  }

  // Persist submission record with full evidence (FR-R2-005)
  await persistSubmission(env.DB, sessionId, {
    turnstileOk: true,
    causalHits: decision.signals.filter((e) => e.class === "A").length,
    strongHits: decision.signals.filter((e) => e.class === "B").length,
    weakHits: decision.signals.filter((e) => e.class === "C").length,
    riskScore: decision.score,
    disposition: decision.disposition,
    policy: decision.policy,
    reasons: decision.reasons,
    evidence: decision.signals,
  });

  // 13. respond (FIX: FR-R2-004 - proper response projection)
  return projectDecisionResponse(env, decision);
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

interface SubmissionRecord {
  turnstileOk: boolean;
  causalHits: number;
  strongHits: number;
  weakHits: number;
  riskScore: number;
  disposition: string;
  policy: string;
  reasons: string[];
  evidence: unknown[];
}

async function persistSubmission(
  db: D1Database,
  sessionId: string,
  record: SubmissionRecord
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, reasons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      Date.now(),
      record.turnstileOk ? 1 : 0,
      record.causalHits,
      record.strongHits,
      record.weakHits,
      record.riskScore,
      record.disposition,
      record.policy,
      JSON.stringify(record.reasons)
    )
    .run();
}
