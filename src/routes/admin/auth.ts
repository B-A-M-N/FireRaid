/**
 * Admin AUTH routes — login/logout and the per-isolate login-attempt guard.
 * Protected by ADMIN_SECRET.
 * FIX: HMAC token covers full payload (in admin-auth.ts, FR-R4-007).
 * FIX: Rate-limit source uses CF-Connecting-IP (FR-R4-068).
 *
 * FR-RR-01: this module is the PRODUCT-PLANE part of the former monolithic
 * admin.ts — the production Worker (src/worker-production.ts) imports from
 * src/routes/admin/ pieces that never reach the evaluation control plane
 * (experiments / harness_runs / lab_runs). This module touches no tables at
 * all, so both planes import it.
 */
import { json, error } from "../../security/headers.js";
import { readJsonBody } from "../../security/body-limits.js";
import { requireAdminMutation, createAdminToken, adminCookieHeader, adminCsrfCookieHeader, createAdminCsrfValue, verifyAdminSecret } from "../../security/admin-auth.js";
import type { Env } from "../../env.js";

// POST /api/admin/login — exchange ADMIN_SECRET for a session cookie
// FIX: Constant-time secret comparison to prevent timing attacks
// FR-R3-069: Brute-force control via in-memory rate limiting
//
// FR-P1-07: the in-memory map is a SECONDARY, best-effort guard that sits
// INSIDE a single isolate. It is NOT the authoritative control — the
// deployment contract requires an authoritative edge limiter (Cloudflare WAF
// rate-limit rule / Access / the ratelimit binding) for /api/admin/login.
// FIRERAID_RATE_LIMIT_LOGIN is an OPERATOR ATTESTATION of that limiter: its
// value names the rule/plan, and its presence is REQUIRED for production by
// config verification (worker-common) and the predeploy gate — but FireRaid
// cannot remotely verify the edge rule exists or fires; the operator who
// sets the variable asserts it. The map here is bounded on EVERY new-key
// insertion (closure 7) and swept, so a flood of distinct client IPs cannot
// grow per-isolate memory without bound (a DoS in its own right).
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
/** FR-P1-07: hard cap on distinct tracked IPs so per-isolate memory is bounded. */
export const MAX_LOGIN_TRACKED_IPS = 5_000;
/** FR-P1-07: sweep expired entries at most this often (bounded cost per call). */
export const LOGIN_SWEEP_INTERVAL_MS = 60_000;
let lastLoginSweep = 0;

/**
 * FR-RR-06 regression seam (tests/unit/admin-login-rate-limit.test.ts):
 * the ONLY way a test observes the private tracker's size. Not part of the
 * route contract; exported for the cap invariant
 * `size <= MAX_LOGIN_TRACKED_IPS` — a test title asserting "stays at the
 * cap" must actually OBSERVE the size.
 */
export function loginAttemptTrackerSizeForTest(): number {
  return loginAttempts.size;
}

/**
 * FR-P1-07: bound + sweep the fallback login map.
 *
 * Removes entries older than the window (so an idle IP never pins a row
 * forever), then, if the map is at its capacity cap, evicts down so one more
 * NEW key can be inserted. This keeps the number of tracked IPs bounded no
 * matter how many distinct source IPs hit the login endpoint.
 */
export function pruneLoginAttempts(now: number): void {
  if (now - lastLoginSweep < LOGIN_SWEEP_INTERVAL_MS) return;
  lastLoginSweep = now;
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.lastAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
  evictForInsertion();
}

/**
 * Closure 7 (FR-P1-07) / FR-RR-06: enforce the capacity cap INDEPENDENTLY of
 * the sweep throttle, with INSERTION semantics: evict while there is no room
 * for one more NEW key. The prior `if (size <= MAX) return` guard oscillated
 * at MAX+1 — a call at exactly the cap returned without evicting, and the
 * caller's subsequent set() grew the map to MAX+1 permanently. The throttle
 * stays only on the EXPIRY scan inside pruneLoginAttempts (per-request O(n)
 * churn); cap enforcement runs on every new-key insertion.
 */
function evictForInsertion(): void {
  // Evict the oldest tracker(s) until one insert fits. Logins are
  // low-frequency, so a linear scan to find the oldest is acceptable and
  // only runs when the cap is breached.
  while (loginAttempts.size >= MAX_LOGIN_TRACKED_IPS) {
    let oldestIp: string | null = null;
    let oldestAt = Infinity;
    for (const [ip, entry] of loginAttempts) {
      if (entry.lastAttempt < oldestAt) {
        oldestAt = entry.lastAttempt;
        oldestIp = ip;
      }
    }
    if (oldestIp === null) break; // empty — cannot happen past this guard
    loginAttempts.delete(oldestIp);
  }
}

/**
 * Closure 7 / FR-RR-06: record a failed attempt with the cap enforced at
 * EVERY new-key insertion (not just on the throttled sweep).
 */
function recordLoginFailure(ip: string, now: number): void {
  const current = loginAttempts.get(ip);
  if (current) {
    current.count += 1;
    current.lastAttempt = now;
    return;
  }
  // New key: make room FIRST (evict-while-full), THEN insert — the map can
  // never exceed MAX_LOGIN_TRACKED_IPS, not even transiently.
  evictForInsertion();
  loginAttempts.set(ip, { count: 1, lastAttempt: now });
}

export async function adminLogin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405);

  // FR-R3-069 + FR-R4-068: Rate limiting by client IP. On Cloudflare,
  // CF-Connecting-IP is set by the edge and cannot be spoofed by the client;
  // x-forwarded-for/x-real-ip are attacker-controlled request headers.
  // NOTE: this in-memory map is per-isolate and best-effort — platform-level
  // rate limiting (WAF rule / Access) is the authoritative control.
  const now = Date.now();
  pruneLoginAttempts(now); // FR-P1-07: bound + sweep the per-isolate fallback
  const clientIp = req.headers.get("cf-connecting-ip") || "unknown";
  const attempts = loginAttempts.get(clientIp);

  if (attempts) {
    if (now - attempts.lastAttempt > LOGIN_WINDOW_MS) {
      // Reset window
      loginAttempts.delete(clientIp);
    } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
      return error("too many login attempts, try again later", 429);
    }
  }

  // FR-P1-02 closure: a bounded streaming read — the login body is tiny, so
  // an unbounded req.json() here was a free unauthenticated allocation.
  const MAX_LOGIN_BODY_BYTES = 4_096;
  const bodyRead = await readJsonBody(req, MAX_LOGIN_BODY_BYTES);
  if (!bodyRead.ok) {
    return error(
      bodyRead.reason === "OVERSIZE" ? "payload too large" : "invalid JSON",
      bodyRead.reason === "OVERSIZE" ? 413 : 400
    );
  }
  const body = bodyRead.data as { secret?: string };
  if (!body.secret || !verifyAdminSecret(env, body.secret)) {
    // Record failed attempt — the cap is enforced on this EVERY insertion
    // (closure 7), not only when the throttled sweep happens to run.
    recordLoginFailure(clientIp, now);
    return error("invalid secret", 403);
  }

  // Success — clear attempts
  loginAttempts.delete(clientIp);

  const token = await createAdminToken(env);
  // FR-P1-06: issue the session cookie AND the CSRF double-submit cookie
  // together. The page JS reads the (non-HttpOnly) CSRF cookie to echo it
  // back on mutations; the session cookie stays HttpOnly.
  const csrf = createAdminCsrfValue();
  const resp = json({ ok: true });
  resp.headers.append("set-cookie", adminCookieHeader(token));
  resp.headers.append("set-cookie", adminCsrfCookieHeader(csrf));
  return resp;
}

// POST /api/admin/logout — clear admin session cookie.
// FR-P1-06: logout is a cookie mutation and is gated the same way (same-site
// origin for a browser caller). Bearer callers may log out without CSRF.
export async function adminLogout(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdminMutation(req, env))) return error("unauthorized", 401);
  const resp = json({ ok: true });
  // Clear the cookies by setting Max-Age=0 (both the session and the CSRF
  // double-submit cookie, SameSite policy mirrored).
  resp.headers.append("set-cookie", [
    "__Host-fr_admin=deleted",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; "));
  resp.headers.append("set-cookie", [
    "__Host-fr_admin_csrf=deleted",
    "Path=/",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; "));
  return resp;
}
