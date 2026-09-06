/**
 * FR-RR-01: EVALUATION-PLANE admin routes — authenticated read-only analytics
 * over the evaluation control plane's tables (experiments, harness_runs) and
 * the lab-aware session-detail variant.
 *
 * The production Worker (src/worker-production.ts) must NEVER import this
 * module: every function here reads a lab-only table, so bundling it would
 * make /readyz's product schema contract lie about the artifact's real
 * persistence dependencies. The lab Worker (src/index.ts) imports it.
 *
 * Import direction is legal: evaluation → product (this file imports
 * ./product.ts for the shared detail builder and CSV escaping).
 */
import { json, error, withSecurityHeaders } from "../../security/headers.js";
import { requireAdmin } from "../../security/admin-auth.js";
import { experimentMetrics } from "../../analytics/run-metrics.js";
import { readLabAssignment } from "../../core/lab-assignment.js";
import type { DefenseRecipe } from "../../core/recipe-schema.js";
import type { Env } from "../../env.js";
import { buildSessionDetail, escapeCsv } from "./product.js";

// GET /api/admin/experiments — list experiments
export async function adminExperiments(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const rows = await env.DB.prepare(
    `SELECT id, name, created_at, status FROM experiments ORDER BY created_at DESC`
  ).all();
  return json({ experiments: rows.results });
}

// GET /api/admin/experiments/:id — experiment detail with metrics (FR-R3-105)
// FIX: Experiment detail aligns with migrated harness_runs columns (FR-R4-069).
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
    .all();

  // P1-AUDIT-2 (P1-28): metrics come from the ONE canonical module — the
  // same validity / submission-truth / canary-column definitions the
  // official analyzer implements (analyze.py cites this file). The prior
  // ad-hoc block computed "valid" as `no error_code`, submission from the
  // agent's outcome string, and canary signals from the retired
  // `canary_triggered` column — admin numbers that disagreed with the
  // analysis numbers.
  const metrics = experimentMetrics(runs.results as Parameters<typeof experimentMetrics>[0]);

  return json({
    experiment,
    metrics,
    runs: runs.results,
  });
}

// GET /api/admin/export?type=runs — harness-run CSV export (EVALUATION plane)
// FIX: Proper CSV escaping to prevent CSV injection and formula injection.
// FR-RR-01: split from the product export — this type reads harness_runs,
// so it must not be reachable from the production artifact.
export async function adminExportRuns(req: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "runs";
  if (type !== "runs") return error("unknown export type", 400);

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

/**
 * GET /api/admin/sessions/:id — LAB-AWARE session detail (the lab Worker's
 * variant). FR-RR-01: reading the bound lab assignment queries lab_runs, so
 * this handler is evaluation-plane by construction; the product variant in
 * ./product.ts performs the identical detail assembly WITHOUT the lab read.
 *
 * P1-AUDIT-2 (P1-29): the SHARED lab-assignment resolver — a hand-rolled
 * read that dropped holdout_mode reconstructed a DIFFERENT semantic
 * treatment for display, and a D1 read failure silently fell back to the
 * random profile. readLabAssignment carries all three fields and fails
 * closed; the error is surfaced to the admin, never silently randomized.
 */
export async function adminLabSessionDetail(req: Request, env: Env, sessionId: string): Promise<Response> {
  if (!(await requireAdmin(req, env))) return error("unauthorized", 401);

  let labRecipe: DefenseRecipe | undefined;
  let holdoutMode: boolean | undefined;
  // FR-P0-17: verification condition is part of the hashed variant id.
  let adminTurnstileRequired: boolean | undefined;
  let labReadError: string | undefined;

  const assignmentRead = await readLabAssignment(env.DB, sessionId);
  if (!assignmentRead.ok) {
    console.error(
      "admin session detail: lab assignment unreadable (failing closed):",
      `${assignmentRead.code}: ${assignmentRead.detail}`
    );
    labReadError = `${assignmentRead.code}: ${assignmentRead.detail}`;
  } else if (assignmentRead.assignment) {
    labRecipe = assignmentRead.assignment.recipe ?? undefined;
    holdoutMode = assignmentRead.assignment.holdoutMode;
    adminTurnstileRequired = assignmentRead.assignment.turnstileRequired;
  }

  if (labReadError !== undefined) {
    // Fail closed on an unreadable assignment: surface the lab read error
    // as the reconstruction error — never silently derive the random
    // profile for a bound session.
    return buildSessionDetail(env, sessionId, {}, labReadError);
  }

  return buildSessionDetail(env, sessionId, {
    recipe: labRecipe,
    holdoutMode,
    turnstileRequired: adminTurnstileRequired,
  });
}
