/**
 * Admin routes — summary, sessions, session detail, experiments, export, logout.
 * Protected by ADMIN_SECRET.
 * FIX: HMAC token covers full payload (in admin-auth.ts, FR-R4-007).
 * FIX: Rate-limit source uses CF-Connecting-IP (FR-R4-068).
 * FIX: Experiment detail aligns with migrated harness_runs columns (FR-R4-069).
 * FIX: defense_families reconstructed from stored profile (FR-R4-071).
 * FIX: Abandoned sessions cleaned up (FR-R4-072).
 * FIX: Single-statement evidence deletion (FR-R4-074).
 */
import { json, error, withSecurityHeaders } from "../security/headers.js";
import { requireAdmin, createAdminToken, adminCookieHeader, verifyAdminSecret } from "../security/admin-auth.js";
import type { Env } from "../env.js";
import { reconstructFromSessionId } from "../core/reconstruct.js";

// POST /api/admin/login — exchange ADMIN_SECRET for a session cookie
// FIX: Constant-time secret comparison to prevent timing attacks
// FR-R3-069: Brute-force control via in-memory rate limiting
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export async function adminLogin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405);

  // FR-R3-069 + FR-R4-068: Rate limiting by client IP. On Cloudflare,
  // CF-Connecting-IP is set by the edge and cannot be spoofed by the client;
  // x-forwarded-for/x-real-ip are attacker-controlled request headers.
  // NOTE: this in-memory map is per-isolate and best-effort — platform-level
  // rate limiting (WAF rule / Access) is the authoritative control.
  const clientIp = req.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const attempts = loginAttempts.get(clientIp);
  
  if (attempts) {
    if (now - attempts.lastAttempt > LOGIN_WINDOW_MS) {
      // Reset window
      loginAttempts.delete(clientIp);
    } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
      return error("too many login attempts, try again later", 429);
    }
  }
  
  let body: { secret?: string };
  try {
    body = (await req.json()) as { secret?: string };
  } catch {
    return error("invalid JSON", 400);
  }
  if (!body.secret || !verifyAdminSecret(env, body.secret)) {
    // Record failed attempt
    const current = loginAttempts.get(clientIp) || { count: 0, lastAttempt: now };
    loginAttempts.set(clientIp, { count: current.count + 1, lastAttempt: now });
    return error("invalid secret", 403);
  }
  
  // Success — clear attempts
  loginAttempts.delete(clientIp);
  
  const token = await createAdminToken(env);
  const resp = json({ ok: true });
  resp.headers.append("set-cookie", adminCookieHeader(token));
  return resp;
}

// POST /api/admin/logout — clear admin session cookie
export async function adminLogout(_req: Request, _env: Env): Promise<Response> {
  const resp = json({ ok: true });
  // Clear the cookie by setting Max-Age=0
  resp.headers.append("set-cookie", [
    "__Host-fr_admin=deleted",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; "));
  return resp;
}

// GET /api/admin/summary — aggregate metrics
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
  const experiments = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM experiments`
  ).first<{ total: number }>();

  return json({
    sessions: sessions?.total ?? 0,
    submitted: submitted?.total ?? 0,
    quarantined: quarantined?.total ?? 0,
    causalHits: causalHits?.total ?? 0,
    experiments: experiments?.total ?? 0,
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

// GET /api/admin/sessions/:id — single session detail with decision chain (FR-R3-103)
export async function adminSessionDetail(req: Request, env: Env, sessionId: string): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);

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
  // Fetch the bound lab run's recipe_json for the session — include it so
  // reconstruction is fully recipe-aware (FR-R6-094).
  const defense_families: string[] = [];
  let reconstructionError: string | undefined;

  // Fetch recipe_json from lab_runs (BOUND or COMPLETE only)
  let recipeJson: string | null = null;
  // FR-P0-17: verification condition is part of the hashed variant id.
  let adminTurnstileRequired = false;
  try {
    const r = await env.DB.prepare(
      `SELECT recipe_json, turnstile_required FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
    )
      .bind(sessionId)
      .first<{ recipe_json: string | null; turnstile_required: number | null }>();
    recipeJson = r?.recipe_json ?? null;
    adminTurnstileRequired = r?.turnstile_required === 1;
  } catch {
    // lab_runs table may not exist; recipe stays null — reconstruction still works
  }

  const recipe = recipeJson
    ? (() => {
        try {
          return JSON.parse(recipeJson);
        } catch {
          // Unparseable recipe — reconstruction proceeds without it;
          // the caller will see reconstructionError below.
          return null;
        }
      })()
    : undefined;

  const result = await reconstructFromSessionId(env, sessionId, {
    profileVersion: (session as { profile_version: number }).profile_version,
    recipe: recipe ?? undefined,
    turnstileRequired: adminTurnstileRequired,
  });

  if (result.ok) {
    defense_families.push(...result.profile.families);
  } else {
    reconstructionError = `${result.code}: ${result.detail}`;
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

// GET /api/admin/experiments — list experiments
export async function adminExperiments(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const rows = await env.DB.prepare(
    `SELECT id, name, created_at, status FROM experiments ORDER BY created_at DESC`
  ).all();
  return json({ experiments: rows.results });
}

// GET /api/admin/experiments/:id — experiment detail with metrics (FR-R3-105)
export async function adminExperimentDetail(req: Request, env: Env, experimentId: string): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);

  const experiment = await env.DB
    .prepare(`SELECT * FROM experiments WHERE id = ?`)
    .bind(experimentId)
    .first();
  if (!experiment) return error("not found", 404);

  // Get harness runs for this experiment
  const runs = await env.DB
    .prepare(
      `SELECT * FROM harness_runs WHERE experiment_id = ? ORDER BY created_at`
    )
    .bind(experimentId)
    .all<{
      id: string;
      experiment_id: string;
      error_code?: string;
      outcome?: string;
      disposition?: string;
      canary_triggered?: number;
    }>();

  // Compute aggregate metrics
  const totalRuns = runs.results.length;
  const validRuns = runs.results.filter((r) => !r.error_code);
  const submitted = validRuns.filter((r) => r.outcome === "submitted");
  const quarantined = validRuns.filter((r) => r.disposition === "QUARANTINE");
  const canaryTriggered = validRuns.filter((r) => r.canary_triggered);

  return json({
    experiment,
    metrics: {
      totalRuns,
      validRuns: validRuns.length,
      submissionRate: validRuns.length > 0 ? submitted.length / validRuns.length : 0,
      quarantineRate: validRuns.length > 0 ? quarantined.length / validRuns.length : 0,
      canaryTriggerRate: validRuns.length > 0 ? canaryTriggered.length / validRuns.length : 0,
      errorRate: totalRuns > 0 ? (totalRuns - validRuns.length) / totalRuns : 0,
    },
    runs: runs.results,
  });
}

// GET /api/admin/export?type=sessions — CSV export
// FIX: Proper CSV escaping to prevent CSV injection and formula injection
export async function adminExport(req: Request, env: Env): Promise<Response> {
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

  // FR-R3-106: Export harness runs
  if (type === "runs") {
    const url2 = new URL(req.url);
    const experimentId = url2.searchParams.get("experiment");
    
    let query = `SELECT * FROM harness_runs`;
    const params: string[] = [];
    if (experimentId) {
      query += ` WHERE experiment_id = ?`;
      params.push(experimentId);
    }
    query += ` ORDER BY created_at DESC LIMIT 10000`;
    
    const rows = await env.DB.prepare(query).bind(...params).all();
    
    if (rows.results.length === 0) {
      return error("no runs found", 404);
    }
    
    const fields = Object.keys(rows.results[0]);
    const header = fields.join(",") + "\n";
    const lines = rows.results.map((r: Record<string, unknown>) =>
      fields.map((f) => escapeCsv(String(r[f] ?? ""))).join(",")
    );
    const csv = header + lines.join("\n");
    const resp = new Response(csv, {
      headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=runs.csv" },
    });
    return withSecurityHeaders(resp);
  }

  return error("unknown export type", 400);
}

// POST /api/admin/cleanup — retention/cleanup for old records (FR-R3-080)
// Deletes records older than the retention period
const DEFAULT_RETENTION_DAYS = 30;

export async function adminCleanup(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  if (req.method !== "POST") return error("method not allowed", 405);

  const url = new URL(req.url);
  const retentionDays = Math.max(1, Math.min(Number(url.searchParams.get("days")) || DEFAULT_RETENTION_DAYS, 365));
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Delete old telemetry batches
  const telemetryResult = await env.DB
    .prepare(`DELETE FROM event_batches WHERE created_at < ?`)
    .bind(cutoff)
    .run();

  // Delete old canary hits
  const canaryResult = await env.DB
    .prepare(`DELETE FROM canary_hits WHERE created_at < ?`)
    .bind(cutoff)
    .run();

  // Delete old verification attempts
  const verificationResult = await env.DB
    .prepare(`DELETE FROM verification_attempts WHERE created_at < ?`)
    .bind(cutoff)
    .run();

  // Delete old submissions and their evidence
  // FR-R4-074: single set-based statement instead of per-submission deletes.
  const evidenceResult = await env.DB
    .prepare(
      `DELETE FROM submission_evidence WHERE submission_id IN (
         SELECT id FROM submissions WHERE created_at < ?
       )`
    )
    .bind(cutoff)
    .run();

  const submissionsResult = await env.DB
    .prepare(`DELETE FROM submissions WHERE created_at < ?`)
    .bind(cutoff)
    .run();

  // FR-R4-072: abandoned (never-submitted) sessions are usually the largest
  // volume in a public lab — expire them too. Their child rows (telemetry,
  // canary hits, verification attempts) were already removed above by the
  // same cutoff.
  const abandonedSessionsResult = await env.DB
    .prepare(
      `DELETE FROM sessions WHERE created_at < ? AND submitted = 0 AND id NOT IN (
         SELECT session_id FROM submissions
       )`
    )
    .bind(cutoff)
    .run();

  const sessionsResult = await env.DB
    .prepare(`DELETE FROM sessions WHERE created_at < ? AND submitted = 1`)
    .bind(cutoff)
    .run();

  return json({
    ok: true,
    retentionDays,
    cutoff,
    deleted: {
      telemetryBatches: telemetryResult.meta.changes,
      canaryHits: canaryResult.meta.changes,
      verificationAttempts: verificationResult.meta.changes,
      evidenceRows: evidenceResult.meta.changes,
      submissions: submissionsResult.meta.changes,
      abandonedSessions: abandonedSessionsResult.meta.changes,
      sessions: sessionsResult.meta.changes,
    },
  });
}

/**
 * Escape a value for CSV output (RFC 4180).
 * Also prevents CSV/formula injection by prefixing dangerous characters.
 */
function escapeCsv(value: string): string {
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
