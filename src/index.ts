/**
 * Worker entry point — router. FR-INV-001: defense path uses no LLM.
 * FR-INV: refuse to start with known test credentials in production.
 * FIX: Don't expose config errors publicly (FR-030).
 * FIX: Log exceptions with observability (FR-031).
 */
import type { Env } from "./env.js";
import { health } from "./routes/health.js";
import { signup } from "./routes/signup.js";
import { submit } from "./routes/submit.js";
import { canary } from "./routes/canary.js";
import { events } from "./routes/telemetry.js";
import { adminLogin, adminSummary, adminSessions, adminSessionDetail, adminExperiments, adminExperimentDetail, adminExport, adminLogout, adminCleanup } from "./routes/admin.js";
import { createLabRun, getLabRun, associateLabRun, ingestLabRuns, postLabRunOutcome } from "./routes/lab.js";
import { error, html } from "./security/headers.js";
import { readAdminHtml } from "./core/static.js";
import { looksLikeTestSiteKey, looksLikeTestSecret } from "./turnstile/verify.js";
import { isLabMode, validateProfileVersionConfig } from "./env.js";

/**
 * Validate configuration at startup.
 * Production safety: refuse to run with known test Turnstile keys
 * and require properly paired sitekey+secret.
 */
function validateConfig(env: Env): string | null {
  // Always validate cryptographic secrets first
  if (!env.FIRERAID_PROFILE_SECRET || env.FIRERAID_PROFILE_SECRET.length < 32) {
    return "FIRERAID_PROFILE_SECRET must be at least 32 characters";
  }
  if (!env.FIRERAID_CSRF_SECRET || env.FIRERAID_CSRF_SECRET.length < 32) {
    return "FIRERAID_CSRF_SECRET must be at least 32 characters";
  }

  // FR-R5-044: PROFILE_VERSION must be valid at startup, not first derivation
  const versionError = validateProfileVersionConfig(env);
  if (versionError) return versionError;

  // Production-specific restrictions
  if (!isLabMode(env)) {
    // Production: reject known test sitekeys
    if (env.TURNSTILE_SITE_KEY && looksLikeTestSiteKey(env.TURNSTILE_SITE_KEY)) {
      return "Production LAB_MODE=false but TURNSTILE_SITE_KEY looks like a test key";
    }

    // Production: reject known test secrets
    if (env.TURNSTILE_SECRET_KEY && looksLikeTestSecret(env.TURNSTILE_SECRET_KEY)) {
      return "Production LAB_MODE=false but TURNSTILE_SECRET_KEY looks like a test secret";
    }

    // Production: require TURNSTILE_EXPECTED_HOSTNAME
    if (!env.TURNSTILE_EXPECTED_HOSTNAME) {
      return "Production requires TURNSTILE_EXPECTED_HOSTNAME";
    }

    // Production: require Turnstile to be enabled
    if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
      return "Production requires both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY";
    }
  }

  // Validate Turnstile sitekey/secret pairing (all environments)
  if (env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY) {
    return "TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is missing";
  }
  if (env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY) {
    return "TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is missing";
  }

  return null;
}

let configError: string | null | undefined;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

      // Admin experiment detail (FR-R3-105)
      const experimentMatch = path.match(/^\/api\/admin\/experiments\/(.+)$/);
      if (experimentMatch && req.method === "GET") return adminExperimentDetail(req, env, experimentMatch[1]);

      // Admin maintenance
      if (path === "/api/admin/cleanup" && req.method === "POST") return adminCleanup(req, env);

      // Lab correlation API (disabled in production)
      if (path === "/api/lab/runs" && req.method === "POST") return createLabRun(req, env);
      // FR-R4-070: run-index ingest — must precede the /:id matchers
      if (path === "/api/lab/runs/ingest" && req.method === "POST") return ingestLabRuns(req, env);
      // FR-R5-004: explicit outcome transition (BOUND → COMPLETE) — before /:id GET
      const labOutcomeMatch = path.match(/^\/api\/lab\/runs\/([^/]+)\/outcome$/);
      if (labOutcomeMatch && req.method === "POST") return postLabRunOutcome(req, env, labOutcomeMatch[1]);
      const labRunMatch = path.match(/^\/api\/lab\/runs\/([^/]+)$/);
      if (labRunMatch && req.method === "GET") return getLabRun(req, env, labRunMatch[1]);
      const labAssociateMatch = path.match(/^\/api\/lab\/runs\/([^/]+)\/associate$/);
      if (labAssociateMatch && req.method === "POST") return associateLabRun(req, env, labAssociateMatch[1]);

      // Admin UI (FR-R3-070: use html() helper for security headers)
      if (path === "/admin" || path === "/admin/") {
        const adminHtml = await readAdminHtml(env);
        return html(adminHtml);
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
