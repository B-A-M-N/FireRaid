/**
 * Admin routes — summary, sessions, session detail, experiments, export, logout.
 * Protected by ADMIN_SECRET.
 */
import { json, error, withSecurityHeaders } from "../security/headers.js";
import { requireAdmin, createAdminToken, adminCookieHeader, verifyAdminSecret } from "../security/admin-auth.js";
import type { Env } from "../env.js";

// POST /api/admin/login — exchange ADMIN_SECRET for a session cookie
// FIX: Constant-time secret comparison to prevent timing attacks
export async function adminLogin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405);
  let body: { secret?: string };
  try {
    body = (await req.json()) as { secret?: string };
  } catch {
    return error("invalid JSON", 400);
  }
  if (!body.secret || !verifyAdminSecret(env, body.secret)) {
    return error("invalid secret", 403);
  }
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
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Number(url.searchParams.get("offset")) || 0;

  const rows = await env.DB.prepare(
    `SELECT id, created_at, profile_version, profile_id, submitted, final_score, final_disposition
     FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<{ id: string; created_at: number; profile_version: number; profile_id: string; submitted: number; final_score: number | null; final_disposition: string | null }>();

  return json({ sessions: rows.results, limit, offset });
}

// GET /api/admin/sessions/:id — single session detail
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

  return json({ session, events: events.results, canaryHits: canaryHits.results, submission });
}

// GET /api/admin/experiments — list experiments
export async function adminExperiments(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const rows = await env.DB.prepare(
    `SELECT id, name, created_at, status FROM experiments ORDER BY created_at DESC`
  ).all();
  return json({ experiments: rows.results });
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

  return error("unknown export type", 400);
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
