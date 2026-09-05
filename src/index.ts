/**
 * LAB / EVALUATION Worker entry point — router for the FULL surface.
 *
 * FR-P1-05: this is the lab/evaluation-plane Worker. It serves the product
 * surface (signup/submit/telemetry/canary/admin-review-READ) AND the eval
 * control plane (lab runs, review-decision writes, lab lifecycle). A
 * PRODUCTION deployment must NOT use this entrypoint — it must use
 * src/worker-production.ts, whose import graph excludes src/eval/, the lab
 * routes, and the review-decision write (the handler does not exist in the
 * production artifact at all, not merely runtime-guarded).
 *
 * wrangler binds this as the top-level `main` and for the dev/test/public-lab
 * (LAB_MODE=true) environments. The production and production-test environ-
 * ments override `main` to the production-only entrypoint.
 *
 * FR-INV-001: defense path uses no LLM.
 * FR-INV: refuse to start with known test credentials in production.
 */
import type { Env } from "./env.js";
import { health } from "./routes/health.js";
import { signup } from "./routes/signup.js";
import { submit } from "./routes/submit.js";
import { canary } from "./routes/canary.js";
import { events } from "./routes/telemetry.js";
import { adminLogin, adminSummary, adminSessions, adminSessionDetail, adminExperiments, adminExperimentDetail, adminExport, adminLogout, adminCleanup, adminReviewQueue } from "./routes/admin.js";
import { adminReviewDecision } from "./routes/admin-review-decision.js";
import { createLabRun, getLabRun, ingestLabRuns, postLabRunOutcome, expireStaleLabRuns } from "./routes/lab.js";
import { error, html } from "./security/headers.js";
import { readAdminHtml } from "./core/static.js";
import { makeConfigGate } from "./worker-common.js";
import {
  runRetentionSweep,
  RAW_TELEMETRY_RETENTION_DAYS,
  REVIEW_RETENTION_DAYS,
  LAB_RETENTION_DAYS,
} from "./cloudflare/retention.js";

const checkConfig = makeConfigGate();

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
    const configProblem = checkConfig(env);
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
        // FR-P0-01: the review and lab datasets keep their own (longer)
        // explicit windows — never silently immortal, never swept by
        // surprise at the 30-day derived cutoff.
        const reviewRetentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_REVIEW_RETENTION_DAYS ?? String(REVIEW_RETENTION_DAYS)) || REVIEW_RETENTION_DAYS, 365)
        );
        const labRetentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_LAB_RETENTION_DAYS ?? String(LAB_RETENTION_DAYS)) || LAB_RETENTION_DAYS, 365)
        );
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const rawCutoff = Date.now() - rawRetentionDays * 24 * 60 * 60 * 1000;
        const reviewCutoff = Date.now() - reviewRetentionDays * 24 * 60 * 60 * 1000;
        const labCutoff = Date.now() - labRetentionDays * 24 * 60 * 60 * 1000;
        const sweep = await runRetentionSweep(env.DB, cutoff, { rawCutoff, reviewCutoff, labCutoff });
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
    const configProblem = checkConfig(env);
    if (configProblem) {
      // FIX: Don't expose config details publicly
      console.error("FireRaid config error:", configProblem);
      return error("Service unavailable", 503);
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ═══════════════════════════════════════════════════════════════════
      // PRODUCT SURFACE
      // What a real FireRaid deployment (origin middleware) serves:
      //   /health GET         — health probe
      //   /signup GET         — enrollment page (injects lab bind token when lab-mode)
      //   /api/submit POST    — user submission (evaluate via profile/recipe)
      //   /api/events POST    — telemetry
      //   /c/* GET/POST       — canary hit endpoint
      //   /admin review READ  — admin review-queue READ (read annotations in production)
      //
      // A production FireRaid deployment uses the middleware factory
      // (createFireRaidMiddleware from src/host-adapter/) as its entry.
      // This Cloudflare Worker IS the evaluation fixture, but these routes
      // constitute the product surface shared with origin deployments.
      // ═══════════════════════════════════════════════════════════════════

      // Health
      if (path === "/health" && req.method === "GET") return health(req, env);

      // Signup
      if (path === "/signup" && req.method === "GET") return signup(req, env, ctx);

      // Submit
      if (path === "/api/submit" && req.method === "POST") return submit(req, env);

      // Telemetry
      if (path === "/api/events" && req.method === "POST") return events(req, env);

      // Canary
      if (path.startsWith("/c/") && (req.method === "GET" || req.method === "POST")) {
        return canary(req, env);
      }

      // Admin auth (product-agnostic — needed for review-queue reads below)
      if (path === "/api/admin/login" && req.method === "POST") return adminLogin(req, env);
      if (path === "/api/admin/logout" && req.method === "POST") return adminLogout(req, env);

      // Admin summary / sessions (product read surfaces)
      if (path === "/api/admin/summary" && req.method === "GET") return adminSummary(req, env);
      if (path === "/api/admin/sessions" && req.method === "GET") return adminSessions(req, env);
      const sessionMatch = path.match(/^\/api\/admin\/sessions\/(.+)$/);
      if (sessionMatch && req.method === "GET") return adminSessionDetail(req, env, sessionMatch[1]);

      // Admin maintenance
      if (path === "/api/admin/cleanup" && req.method === "POST") return adminCleanup(req, env);

      // ═══════════════════════════════════════════════════════════════════
      // EVALUATION CONTROL PLANE
      // ┌─────────────────────────────────────────────────────────────────┐
      // │ The Cloudflare Worker IS the evaluation fixture.               │
      // │ A production FireRaid deployment (origin middleware) serves     │
      // │ ONLY the product surface above.                                 │
      // │                                                                 │
      // │ Evaluation routes below require LAB_MODE=true (enforced via     │
      // │ isEvaluationDeployment guard or per-handler guards).            │
      // │ Authenticated read-only analytics (/api/admin/experiments*,     │
      // │ /api/admin/export) are available regardless of lab mode.        │
      // └─────────────────────────────────────────────────────────────────┘
      // ═══════════════════════════════════════════════════════════════════

      // Admin experiments list — authenticated read, available in any mode
      if (path === "/api/admin/experiments" && req.method === "GET") return adminExperiments(req, env);

      // Admin experiment detail — authenticated read, available in any mode
      const experimentMatch = path.match(/^\/api\/admin\/experiments\/(.+)$/);
      if (experimentMatch && req.method === "GET") return adminExperimentDetail(req, env, experimentMatch[1]);

      // Admin export — authenticated read, available in any mode
      if (path === "/api/admin/export" && req.method === "GET") return adminExport(req, env);

      // Lab correlation API (EVALUATION-ONLY — disabled outside lab mode)
      // Each handler self-guards with isLabMode(env) → 404 when not lab.
      if (path === "/api/lab/runs" && req.method === "POST") return createLabRun(req, env);
      // FR-R4-070: run-index ingest — must precede the /:id matchers
      if (path === "/api/lab/runs/ingest" && req.method === "POST") return ingestLabRuns(req, env);
      // FR-R5-004: explicit outcome transition (BOUND → COMPLETE) — before /:id GET
      const labOutcomeMatch = path.match(/^\/api\/lab\/runs\/([^/]+)\/outcome$/);
      if (labOutcomeMatch && req.method === "POST") return postLabRunOutcome(req, env, labOutcomeMatch[1]);
      const labRunMatch = path.match(/^\/api\/lab\/runs\/([^/]+)$/);
      if (labRunMatch && req.method === "GET") return getLabRun(req, env, labRunMatch[1]);

      // Review decision — EVALUATION-ONLY WRITE (enforced inside admin.ts)
      const reviewDecisionMatch = path.match(/^\/api\/admin\/review-queue\/([^/]+)$/);
      if (reviewDecisionMatch && req.method === "POST") return adminReviewDecision(req, env);

      // Review-queue READ — product surface (reviewers read FireRaid's annotation)
      if (path === "/api/admin/review-queue" && req.method === "GET") {
        return adminReviewQueue(req, env);
      }

      // Admin UI — served in any mode; the fixture uses it for review reads
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

