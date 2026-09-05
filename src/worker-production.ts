/**
 * PRODUCTION Worker entry point — product surface only.
 *
 * FR-P1-05: this is the entrypoint a real FireRaid production deployment
 * MUST bind (wrangler overrides `main` for the `production` and
 * `production-test` environments). Its import graph intentionally contains
 * NO path into:
 *
 *   - src/eval/            (evaluation control plane; review-workflow)
 *   - src/routes/lab.ts    (lab-run create/ingest/outcome lifecycle)
 *   - src/routes/admin-review-decision.ts  (reviewer-decision WRITE)
 *   - expireStaleLabRuns   (lab lifecycle mutation in the cron)
 *
 * A production FireRaid deployment gets the attack surface FireRaid actually
 * ships for: the enrollment page, submission, telemetry, canaries, the
 * admin review-queue READ (reviewers read FireRaid's annotation), and the
 * retention sweep. The evaluation control plane does not exist — this
 * artifact cannot be asked to create a lab run, finalize a review, or touch
 * lab lifecycle at runtime, because the handler is not in the bundle.
 *
 * Runtime defense-in-depth LAB_MODE guards remain where a handler is shared
 * with the lab plane; the stronger property here is structural absence.
 *
 * The gate (config validation with the 503-on-misconfig failure posture) is
 * the SAME one the lab worker runs, so the two planes cannot diverge on what
 * a runnable configuration is.
 *
 * FR-INV-001: defense path uses no LLM.
 */
import type { Env } from "./env.js";
import { health } from "./routes/health.js";
import { signup } from "./routes/signup.js";
import { submit } from "./routes/submit.js";
import { canary } from "./routes/canary.js";
import { events } from "./routes/telemetry.js";
import { adminLogin, adminSummary, adminSessions, adminSessionDetail, adminExperiments, adminExperimentDetail, adminExport, adminLogout, adminCleanup, adminReviewQueue } from "./routes/admin.js";
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
   * FR-R7-025: scheduled retention sweep. PRODUCTION runs the data-lifecycle
   * sweep ONLY — deliberately NOT expireStaleLabRuns (FR-P1-05: the lab-run
   * lifecycle sweep is evaluation-plane; a production deployment has no lab
   * runs, and importing it would drag the lab plane into the artifact).
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // A config error skips the sweep (deleting rows under an unvalidated
    // key/secret config is worse than deferring cleanup by one cron tick).
    const configProblem = checkConfig(env);
    if (configProblem) {
      console.error("fireraid cron skipped — config error:", configProblem);
      return;
    }
    ctx.waitUntil((async () => {
      try {
        const retentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_RETENTION_DAYS ?? "30") || 30, 365)
        );
        const rawRetentionDays = Math.max(
          1,
          Math.min(Number(env.FIRERAID_RAW_TELEMETRY_RETENTION_DAYS ?? String(RAW_TELEMETRY_RETENTION_DAYS)) || RAW_TELEMETRY_RETENTION_DAYS, retentionDays)
        );
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
        console.log("fireraid production retention sweep", { retentionDays, cutoff, ...sweep });
      } catch (err) {
        console.error("fireraid production retention sweep failed:", err);
      }
    })());
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const configProblem = checkConfig(env);
    if (configProblem) {
      console.error("FireRaid config error:", configProblem);
      return error("Service unavailable", 503);
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── PRODUCT SURFACE ────────────────────────────────────────────────
      // The complete surface a FireRaid production deployment serves. There
      // is deliberately NO lab-run, review-decision, or evaluation route
      // here — those handlers are not in this artifact.
      if (path === "/health" && req.method === "GET") return health(req, env);

      if (path === "/signup" && req.method === "GET") return signup(req, env, ctx);

      if (path === "/api/submit" && req.method === "POST") return submit(req, env);

      if (path === "/api/events" && req.method === "POST") return events(req, env);

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

      // Authenticated read-only analytics
      if (path === "/api/admin/experiments" && req.method === "GET") return adminExperiments(req, env);
      const experimentMatch = path.match(/^\/api\/admin\/experiments\/(.+)$/);
      if (experimentMatch && req.method === "GET") return adminExperimentDetail(req, env, experimentMatch[1]);
      if (path === "/api/admin/export" && req.method === "GET") return adminExport(req, env);

      // Review-queue READ — reviewers read FireRaid's annotation.
      // (The review-queue WRITE, /api/admin/review-queue/:id POST, is a
      // decision write and lives ONLY in the lab Worker.)
      if (path === "/api/admin/review-queue" && req.method === "GET") {
        return adminReviewQueue(req, env);
      }

      // Admin UI — reviewers read annotations in production
      if (path === "/admin" || path === "/admin/") {
        const adminHtml = await readAdminHtml(env);
        return html(adminHtml);
      }

      // Static asset fallback
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error("FireRaid error:", {
        path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return error("internal error", 500);
    }
  },
};