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
import { createLabRun, getLabRun, ingestLabRuns, postLabRunOutcome, expireStaleLabRuns } from "./routes/lab.js";
import { error, html } from "./security/headers.js";
import { readAdminHtml } from "./core/static.js";
import { looksLikeTestSiteKey, looksLikeTestSecret } from "./turnstile/verify.js";
import { isLabMode, validateProfileVersionConfig } from "./env.js";
import { validateProfileKeyRing } from "./core/session.js";
import { runRetentionSweep, RAW_TELEMETRY_RETENTION_DAYS } from "./cloudflare/retention.js";

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

  // FR-R7-002: malformed key-ring configuration is a startup failure, not a
  // silent degradation. A session written today must still reconstruct after
  // rotation tomorrow — a silently-discarded PREVIOUS map (resolved by an
  // older resolveProfileKey) would corrupt historical sessions.
  const keyRingError = validateProfileKeyRing(env);
  if (keyRingError) return keyRingError;

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
  /**
   * FR-R7-025: Cloudflare scheduled handler — retention sweep.
   * Triggered by a cron expression in wrangler.jsonc (`triggers.crons`).
   * Runs the same SQL as the admin /cleanup endpoint but without admin
   * auth, on a tighter cutoff derived from the env-supplied retention
   * days. Manual /api/admin/cleanup remains available as a fallback.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // P1-AUDIT-2 (ops): the fetch handler validated config on first request,
    // but the cron path ran UNVALIDATED — a misconfigured deployment's cron
    // silently swept with whatever env it had. Validate here too; a config
    // error skips the sweep (deleting rows under an unvalidated key/secret
    // config is worse than deferring cleanup by one cron tick).
    const configProblem = validateConfig(env);
    if (configProblem) {
      console.error("fireraid cron skipped — config error:", configProblem);
      return;
    }
    // FR-R7-025: defer the work so the scheduled invocation returns even
    // on cold-start latency; failures show up in the worker logs.
    ctx.waitUntil((async () => {
      try {
        const retentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_RETENTION_DAYS ?? "30") || 30, 365)
        );
        // P1-10: raw keystroke-level telemetry expires on its own, shorter
        // window — it is the most sensitive data the store holds and has no
        // reader after the session TTL lapses.
        const rawRetentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_RAW_TELEMETRY_RETENTION_DAYS ?? String(RAW_TELEMETRY_RETENTION_DAYS)) || RAW_TELEMETRY_RETENTION_DAYS, retentionDays)
        );
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const rawCutoff = Date.now() - rawRetentionDays * 24 * 60 * 60 * 1000;
        const sweep = await runRetentionSweep(env.DB, cutoff, { rawCutoff });
        // FR-P0-15: the lab-run lifecycle sweep (PENDING→EXPIRED,
        // stale-BOUND→ABANDONED) runs in the SAME cron — one scheduled
        // invocation owns all background DB maintenance, so lab-run state
        // can't silently rot if an operator only schedules one trigger.
        const expiredLabRuns = await expireStaleLabRuns(env.DB, Date.now());
        console.log("fireraid retention sweep", { retentionDays, cutoff, ...sweep, expiredLabRuns });
      } catch (err) {
        console.error("fireraid retention sweep failed:", err);
      }
    })());
  },

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

