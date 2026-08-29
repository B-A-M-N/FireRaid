/**
 * Worker entry point — router. FR-INV-001: defense path uses no LLM.
 * FR-INV: refuse to start with known test credentials in production.
 * FIX: Don't expose config errors publicly (FR-030).
 * FIX: Log exceptions with observability (FR-031).
 * FIX: Initialize Turnstile test mode (FR-R2-001).
 */
import type { Env } from "./env.js";
import { health } from "./routes/health.js";
import { signup } from "./routes/signup.js";
import { submit } from "./routes/submit.js";
import { canary } from "./routes/canary.js";
import { events } from "./routes/telemetry.js";
import { adminLogin, adminSummary, adminSessions, adminSessionDetail, adminExperiments, adminExport, adminLogout } from "./routes/admin.js";
import { error } from "./security/headers.js";
import { readAdminHtml } from "./core/static.js";
import { looksLikeTestKey, initTestMode } from "./turnstile/verify.js";
import { isLabMode } from "./env.js";

/** Production safety: refuse to run with known test Turnstile keys. */
function validateConfig(env: Env): string | null {
  if (isLabMode(env)) return null; // lab mode allows test keys
  const siteKey = env.TURNSTILE_SECRET_KEY;
  if (siteKey && looksLikeTestKey(siteKey)) {
    return "Production LAB_MODE=false but TURNSTILE_SECRET_KEY looks like a test key";
  }
  // Also validate secrets are sufficiently long
  if (!env.FIRERAID_PROFILE_SECRET || env.FIRERAID_PROFILE_SECRET.length < 32) {
    return "FIRERAID_PROFILE_SECRET must be at least 32 characters";
  }
  if (!env.FIRERAID_CSRF_SECRET || env.FIRERAID_CSRF_SECRET.length < 32) {
    return "FIRERAID_CSRF_SECRET must be at least 32 characters";
  }
  return null;
}

let configError: string | null | undefined;
let testModeInitialized = false;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize test mode once
    if (!testModeInitialized) {
      initTestMode(env);
      testModeInitialized = true;
    }

    // Validate config once on first request
    if (configError === undefined) {
      configError = validateConfig(env);
    }
    if (configError) {
      // FIX: Don't expose config details publicly
      console.error("FireRaid config error:", configError);
      return error("Service unavailable", 503);
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // Public
      if (path === "/health" && req.method === "GET") return health(req, env);
      if (path === "/signup" && req.method === "GET") return signup(req, env, ctx);

      // API
      if (path === "/api/submit" && req.method === "POST") return submit(req, env);
      if (path === "/api/events" && req.method === "POST") return events(req, env);

      // Canary
      if (path.startsWith("/c/") && (req.method === "GET" || req.method === "POST")) {
        return canary(req, env);
      }

      // Admin API
      if (path === "/api/admin/login" && req.method === "POST") return adminLogin(req, env);
      if (path === "/api/admin/logout" && req.method === "POST") return adminLogout(req, env);
      if (path === "/api/admin/summary" && req.method === "GET") return adminSummary(req, env);
      if (path === "/api/admin/sessions" && req.method === "GET") return adminSessions(req, env);
      if (path === "/api/admin/experiments" && req.method === "GET") return adminExperiments(req, env);
      if (path === "/api/admin/export" && req.method === "GET") return adminExport(req, env);
      const sessionMatch = path.match(/^\/api\/admin\/sessions\/(.+)$/);
      if (sessionMatch && req.method === "GET") return adminSessionDetail(req, env, sessionMatch[1]);

      // Admin UI
      if (path === "/admin" || path === "/admin/") {
        const html = await readAdminHtml(env);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // Static asset fallback (admin.html, js, css)
      return env.ASSETS.fetch(req);
    } catch (err) {
      // FIX: Log exceptions with observability
      console.error("FireRaid error:", {
        path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return error("internal error", 500);
    }
  },
};
