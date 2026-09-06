/**
 * FR-RR-01: PRODUCT-PLANE admin routes — the surface a real FireRaid
 * production deployment serves.
 *
 * Everything in this module reads and writes ONLY the product schema
 * (sessions, event_batches, canary_hits, submissions, submission_evidence,
 * verification_attempts, session_metrics, review_queue, review_calibration).
 * review_queue/review_calibration ARE product tables: the production submit
 * route writes review annotations through D1SubmissionFinalizer, reviewers
 * read them here, and the retention sweep must reclaim them or they pin
 * their submission and session forever.
 *
 * This module must never reach the evaluation control plane's tables
 * (lab_runs, experiments, harness_runs) — that is the property the
 * production persistence-closure test pins
 * (tests/unit/production-persistence-closure.test.ts). The evaluation-plane
 * admin surface lives in ./evaluation.ts, which MAY import from this module
 * (evaluation → product is the legal direction); production never imports
 * evaluation.
 */
import { json, error, withSecurityHeaders } from "../../security/headers.js";
import { requireAdmin, requireAdminMutation } from "../../security/admin-auth.js";
import { isLabMode } from "../../env.js";
import type { Env } from "../../env.js";
import { reconstructIssuedProfile } from "../../core/reconstruct.js";
import { runRetentionSweep } from "../../cloudflare/retention.js";

// GET /api/admin/summary — aggregate metrics (PRODUCT tables only)
export async function adminSummary(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);

  const sessions = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM sessions`
  ).first<{ total: number }>();
  const submitted = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM sessions WHERE submitted = 1`
  ).first<{ total: number }>();
  const quarantined = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM sessions WHERE final_disposition = 'QUARANTINE'`
  ).first<{ total: number }>();
  const causalHits = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM canary_hits WHERE verified = 1`
  ).first<{ total: number }>();

  return json({
    sessions: sessions?.total ?? 0,
    submitted: submitted?.total ?? 0,
    quarantined: quarantined?.total ?? 0,
    causalHits: causalHits?.total ?? 0,
  });
}

// GET /api/admin/sessions — list sessions (paginated)
export async function adminSessions(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const url = new URL(req.url);
  // FR-R3-071: Clamp pagination values
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const rows = await env.DB.prepare(
    `SELECT id, created_at, profile_version, profile_id, submitted, final_score, final_disposition
     FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<{ id: string; created_at: number; profile_version: number; profile_id: string; submitted: number; final_score: number | null; final_disposition: string | null }>();

  return json({ sessions: rows.results, limit, offset });
}

/**
 * GET /api/admin/sessions/:id — session detail.
 *
 * FR-RR-01: the LAB-aware variant (bound-recipe reconstruction) lives in
 * ./evaluation.ts — reading a lab assignment means querying lab_runs, and
 * this product-plane variant must not. Production reconstruction is
 * env-authentic WITHOUT the lab read: a production session was never bound
 * to a run, so its issued treatment is fully determined by the session's own
 * persisted fields (version + key id + profile hash).
 */
export async function adminSessionDetail(req: Request, env: Env, sessionId: string): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  return buildSessionDetail(env, sessionId, {});
}

/**
 * Shared detail builder. `lab` callers (evaluation.ts) pass the resolved
 * assignment; the product path passes nothing. `presetReconstructionError`
 * (evaluation plane) short-circuits derivation entirely — a lab-assignment
 * read that failed closed must surface THAT error, never a silent random-
 * profile reconstruction result.
 */
export async function buildSessionDetail(
  env: Env,
  sessionId: string,
  lab: {
    recipe?: LabAssignmentLike["recipe"];
    holdoutMode?: boolean;
    turnstileRequired?: boolean;
  },
  presetReconstructionError?: string
): Promise<Response> {
  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE id = ?`
  ).bind(sessionId).first();
  if (!session) return error("not found", 404);

  const events = await env.DB.prepare(
    `SELECT id, created_at, first_seq, last_seq, event_count, payload_json
     FROM event_batches WHERE session_id = ? ORDER BY first_seq`
  ).bind(sessionId).all();

  const canaryHits = await env.DB.prepare(
    `SELECT id, created_at, family, evidence_class, verified
     FROM canary_hits WHERE session_id = ? ORDER BY created_at`
  ).bind(sessionId).all();

  const submission = await env.DB.prepare(
    `SELECT * FROM submissions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(sessionId).first();

  // FR-R3-103: Include decision chain (evidence)
  let evidence: unknown[] = [];
  if (submission) {
    const evidenceRows = await env.DB
      .prepare(
        `SELECT evidence_class, source, weight, verified, metadata_json
         FROM submission_evidence WHERE submission_id = ? ORDER BY id`
      )
      .bind(submission.id)
      .all<{
        evidence_class: string;
        source: string;
        weight: number;
        verified: number;
        metadata_json: string;
      }>();
    evidence = evidenceRows.results.map((e) => ({
      class: e.evidence_class,
      source: e.source,
      weight: e.weight,
      verified: e.verified === 1,
      metadata: JSON.parse(e.metadata_json || "{}"),
    }));
  }

  // FR-R4-071 / FR-R6-094: Reconstruct defense families from the session's
  // stored profile version via the canonical reconstruction service.
  const defense_families: string[] = [];
  let reconstructionError: string | undefined;

  if (presetReconstructionError !== undefined) {
    reconstructionError = presetReconstructionError;
  } else {
    // FR-RR-03/FR-RR-04: load the session THROUGH the canonical path — the
    // reconstruction threads the persisted profile key id AND the issued
    // profile hash into the versioned reconstruction, so an admin view
    // fails closed on derivation drift exactly like submit/canary do.
    const result = await reconstructIssuedProfile(
      env,
      {
        id: sessionId,
        profileVersion: (session as { profile_version: number }).profile_version,
        profileKeyId: (session as { profile_key_id?: string | null }).profile_key_id ?? null,
        profileHash: (session as { profile_hash?: string | null }).profile_hash ?? null,
      },
      lab.recipe ?? undefined,
      { holdoutMode: lab.holdoutMode, turnstileRequired: lab.turnstileRequired }
    );
    if (result.ok) {
      defense_families.push(...result.profile.families);
    } else {
      reconstructionError = `${result.code}: ${result.detail}`;
    }
  }

  return json({
    session,
    events: events.results,
    canaryHits: canaryHits.results,
    submission,
    evidence,
    defense_families,
    ...(reconstructionError ? { reconstructionError } : {}),
  });
}

// Minimal structural type so the lab import below does not drag the
// lab-assignment module into this file's import graph.
interface LabAssignmentLike {
  recipe?: import("../../core/recipe-schema.js").DefenseRecipe | null;
  holdoutMode?: boolean;
  turnstileRequired?: boolean;
}

// GET /api/admin/export?type=sessions — sessions CSV export (PRODUCT plane)
// FIX: Proper CSV escaping to prevent CSV injection and formula injection
// FR-RR-01: the harness-run export (type=runs) is the EVALUATION plane's —
// it lives in ./evaluation.ts; this handler answers only the product type.
export async function adminExportSessions(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "sessions";

  if (type === "sessions") {
    const rows = await env.DB.prepare(
      `SELECT id, created_at, profile_version, profile_id, submitted, final_score, final_disposition
       FROM sessions ORDER BY created_at DESC LIMIT 10000`
    ).all<{ id: string; created_at: number; profile_version: number; profile_id: string; submitted: number; final_score: number | null; final_disposition: string | null }>();

    const header = "id,created_at,profile_version,profile_id,submitted,final_score,final_disposition\n";
    const lines = rows.results.map((r) =>
      `${escapeCsv(r.id)},${r.created_at},${r.profile_version},${escapeCsv(r.profile_id)},${r.submitted},${r.final_score ?? ""},${escapeCsv(r.final_disposition ?? "")}`
    );
    const csv = header + lines.join("\n");
    const resp = new Response(csv, {
      headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=sessions.csv" },
    });
    return withSecurityHeaders(resp);
  }

  return error("unknown export type", 400);
}

/**
 * RFC 4180 CSV escaping, shared with the evaluation-plane export. Exported
 * for ./evaluation.ts (evaluation → product is the legal import direction).
 */
export function escapeCsv(value: string): string {
  // Prevent formula injection: prefix values starting with = + - @ with a single quote
  // See: https://owasp.org/www-community/attacks/CSV_Injection
  let safe = value;
  if (/^[=+\-@]/.test(safe)) {
    safe = `'${safe}`;
  }
  // Standard RFC 4180 escaping
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// POST /api/admin/cleanup — retention/cleanup for old records (FR-R3-080)
// Deletes records older than the retention period.
const DEFAULT_RETENTION_DAYS = 30;
// P1-10: raw keystroke telemetry window (matches the cron default).
const DEFAULT_RAW_RETENTION_DAYS = 7;
// FR-P0-01: review/lab dataset windows (match the cron defaults).
const DEFAULT_REVIEW_RETENTION_DAYS = 90;
const DEFAULT_LAB_RETENTION_DAYS = 90;

export async function adminCleanup(req: Request, env: Env): Promise<Response> {
  // FR-P1-06: cleanup DELETE-rows for real — a destructive cookie mutation
  // MUST clear the origin+CSRF gate. A Bearer API caller (operator script)
  // passes with the token alone; a browser cookie caller must present the
  // CSRF header echoing the CSRF cookie from a same-site origin.
  if (!(await requireAdminMutation(req, env))) return error("unauthorized", 401);
  if (req.method !== "POST") return error("method not allowed", 405);

  const url = new URL(req.url);
  const retentionDays = Math.max(1, Math.min(Number(url.searchParams.get("days")) || DEFAULT_RETENTION_DAYS, 365));
  // P1-10: raw telemetry obeys its own (shorter) window, mirroring the cron
  // path; clamp to the derived-records window so raw payloads never outlive
  // dispositions.
  const rawRetentionDays = Math.max(1, Math.min(Number(url.searchParams.get("rawDays")) || DEFAULT_RAW_RETENTION_DAYS, retentionDays));
  // FR-P0-01: review/lab datasets keep their own explicit windows (longer
  // than derived records by default), overridable via ?reviewDays= / ?labDays=
  // — the sweep can now reclaim them, but only on an operator-visible clock.
  const reviewRetentionDays = Math.max(
    1,
    Math.min(
      Number(url.searchParams.get("reviewDays")) || Number(env.FIRERAID_REVIEW_RETENTION_DAYS) || DEFAULT_REVIEW_RETENTION_DAYS,
      365
    )
  );
  const labRetentionDays = Math.max(
    1,
    Math.min(
      Number(url.searchParams.get("labDays")) || Number(env.FIRERAID_LAB_RETENTION_DAYS) || DEFAULT_LAB_RETENTION_DAYS,
      365
    )
  );
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const rawCutoff = Date.now() - rawRetentionDays * 24 * 60 * 60 * 1000;
  const reviewCutoff = Date.now() - reviewRetentionDays * 24 * 60 * 60 * 1000;
  const labCutoff = Date.now() - labRetentionDays * 24 * 60 * 60 * 1000;

  // P1-AUDIT-2 (ops): delegate to the SHARED sweep module (cloudflare/
  // retention.ts). FR-RR-01: the plane follows the deployment — a
  // LAB_MODE=false admin endpoint sweeps the PRODUCT schema only (its
  // statements never name lab_runs); the lab fixture sweeps the full schema.
  const plane = isLabMode(env) ? "lab" as const : "production" as const;
  const sweep = await runRetentionSweep(env.DB, cutoff, { unbounded: true, rawCutoff, reviewCutoff, labCutoff, plane });

  return json({
    ok: true,
    plane,
    retentionDays,
    rawRetentionDays,
    reviewRetentionDays,
    labRetentionDays,
    cutoff,
    rawCutoff,
    reviewCutoff,
    labCutoff,
    deleted: {
      telemetryBatches: sweep.telemetryBatches,
      canaryHits: sweep.canaryHits,
      verificationAttempts: sweep.verificationAttempts,
      sessionMetrics: sweep.sessionMetrics,
      orphanedSessionMetrics: sweep.orphanedSessionMetrics,
      evidenceRows: sweep.submissionEvidence,
      reviewCalibration: sweep.reviewCalibration,
      reviewQueue: sweep.reviewQueue,
      submissions: sweep.submissions,
      expiredLabRuns: sweep.expiredLabRuns,
      terminalLabRuns: sweep.labRuns,
      abandonedSessions: sweep.abandonedSessions,
      sessions: sweep.finalizedSessions,
    },
  });
}

// ─── Review-queue (product plane) ─────────────────────────────────────────
// READ endpoint: available in all modes. Reviewers read FireRaid's annotation
// in production to make decisions in their own system.

export async function adminReviewQueue(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);

  const url = new URL(req.url);
  // FR-P1-01: status is validated against the review_queue enum, never
  // asserted into the TypeScript union — `?status=garbage` is a 400, not a
  // live query with an impossible placeholder value.
  const rawStatus = url.searchParams.get("status");
  if (rawStatus !== null && rawStatus !== "pending" && rawStatus !== "reviewed") {
    return error(`invalid status: ${rawStatus} (expected "pending" or "reviewed")`, 400);
  }
  const status = rawStatus as "pending" | "reviewed" | null;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const sql =
    `SELECT session_id, public_id, created_at, risk_score, risk_tier, disposition, policy, reasons_json,
            status, reviewer_decision, reviewer_note, reviewed_at, reviewed_by
     FROM review_queue` +
    (status ? ` WHERE status = ?` : "") +
    ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;

  const stmt = env.DB.prepare(sql);
  // FR-P1-01: exactly as many bind values as placeholders. Without a status
  // filter the SQL has two placeholders (LIMIT, OFFSET) — the previous
  // `bind(status ?? null, limit, offset)` always supplied three and bound
  // garbage on the unfiltered path.
  const bound = status ? stmt.bind(status, limit, offset) : stmt.bind(limit, offset);

  const entries = await bound.all<{
      session_id: string;
      public_id: string;
      created_at: number;
      risk_score: number;
      risk_tier: string;
      disposition: string;
      policy: string;
      reasons_json: string;
      status: string;
      reviewer_decision: string | null;
      reviewer_note: string | null;
      reviewed_at: number | null;
      reviewed_by: string | null;
    }>();

  return json({
    entries: (entries.results ?? []).map((row) => ({
      sessionId: row.session_id,
      publicId: row.public_id,
      createdAt: row.created_at,
      riskScore: row.risk_score,
      riskTier: row.risk_tier,
      disposition: row.disposition,
      policy: row.policy,
      reasons: JSON.parse(row.reasons_json || "[]"),
      status: row.status,
      reviewerDecision: row.reviewer_decision ?? undefined,
      reviewerNote: row.reviewer_note ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      reviewedBy: row.reviewed_by ?? undefined,
    })),
    limit,
    offset,
  });
}

// ─── Review decision (evaluation plane) ───────────────────────────────────
// The review-decision WRITE moved to src/routes/admin-review-decision.ts
// (FR-P1-05). It imports src/eval/review-workflow.ts, so it must NOT be in
// this product module — the production Worker imports ONLY product-plane
// modules, and pulling the decision WRITE would drag the whole eval control
// plane into the production artifact. The lab Worker imports the decision
// write from the isolated module.
