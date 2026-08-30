/**
 * Lab correlation API — FR-R4-025/026/028/029/030/031/033/035/036/037
 * + FR-R5-004/006/007/008/013/035/036/037
 *
 * Lab run lifecycle:
 *   PENDING ──(signup consumes bind token)──► BOUND ──(runner POSTs outcome)──► COMPLETE
 *   PENDING ──(expires 24h without binding)──► EXPIRED
 *   BOUND   ──(24h without outcome, no reconciled_at)──► ABANDONED
 *
 * Endpoints:
 *   POST /api/lab/runs            — create lab run (runner auth)
 *   GET  /api/lab/runs/:id        — get run state (runner auth)
 *   POST /api/lab/runs/:id/outcome — report outcome, transitions BOUND→COMPLETE (runner auth)
 *   POST /api/lab/runs/ingest     — bulk ingest harness results (runner auth)
 *
 * NOTE on /:id/outcome wiring (placed BEFORE the bare-id GET matcher):
 *   if (labOutcomeMatch && req.method === "POST")
 *     return postLabRunOutcome(req, env, labOutcomeMatch[1]);
 *   const labGetMatch = req.url.match(/^\/api\/lab\/runs\/([^/]+)$/);
 *   if (labGetMatch && req.method === "GET")
 *     return getLabRun(req, env, labGetMatch[1]);
 *
 * These routes are HARD-DISABLED outside lab mode.
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import { isLabMode } from "../env.js";
import { getSessionId, loadSession } from "../core/session.js";
import { deriveProfile } from "../core/profile.js";
import { ABLATION_RECIPES } from "../core/profile.js";
import type { DefenseRecipe } from "../core/profile.js";

// ─── Cryptographic helpers (exported for testing) ───────────────────────

/**
 * SHA-256 hash of a string, returned as hex.
 * Exported for unit-testing hashBindToken determinism.
 */
export async function hashBindToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Returns true if equal.
 * Exported for unit-testing timing-safe behavior.
 */
export function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the Bearer secret against env.FIRERAID_LAB_API_SECRET.
 * Returns true when the secret is set (>= 32 chars) and matches.
 * All three lab endpoints must call this first and return 401 on false.
 */
export function requireLabAuth(req: Request, env: Env): boolean {
  const secret = env.FIRERAID_LAB_API_SECRET;
  if (!secret || secret.length < 32) return false;

  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const provided = auth.slice(7);
  return constantTimeEqualStr(provided, secret);
}

// ─── FR-R5-037: Expiry helper ───────────────────────────────────────────

/**
 * Expire stale lab runs (FR-R5-037).
 *   - PENDING runs past 24h → EXPIRED (terminal_reason: 'expired_pending')
 *   - BOUND runs without reconciled_at past 24h → ABANDONED (terminal_reason: 'abandoned_bound')
 * Returns total changes across both UPDATEs. Best-effort — errors are swallowed.
 */
export async function expireStaleLabRuns(
  db: D1Database,
  now: number
): Promise<number> {
  const twentyFourHoursAgo = now - 86_400_000; // 24h in ms
  let total = 0;

  // PENDING runs past expiry → EXPIRED
  try {
    const r1 = await db
      .prepare(
        `UPDATE lab_runs SET status = 'EXPIRED', terminal_reason = 'expired_pending'
         WHERE status = 'PENDING' AND expires_at < ?`
      )
      .bind(twentyFourHoursAgo)
      .run();
    total += r1.meta.changes;
  } catch {
    // Best-effort: don't fail callers on expiry sweep
  }

  // BOUND runs without reconciled_at past 24h → ABANDONED
  try {
    const r2 = await db
      .prepare(
        `UPDATE lab_runs SET status = 'ABANDONED', terminal_reason = 'abandoned_bound'
         WHERE status = 'BOUND' AND reconciled_at IS NULL AND created_at < ?`
      )
      .bind(twentyFourHoursAgo)
      .run();
    total += r2.meta.changes;
  } catch {
    // Best-effort
  }

  return total;
}

// ─── FR-R5-035: Input validation helpers ────────────────────────────────

const KNOWN_FAMILIES = ["semantic", "decoy-field", "decoy-route", "interaction"];

function validateRecipeBody(recipe: unknown): string | null {
  if (typeof recipe !== "object" || recipe === null) return "recipe must be an object";

  const r = recipe as Record<string, unknown>;

  // families: array of known family strings
  if (r.families !== undefined) {
    if (!Array.isArray(r.families)) return "families must be an array";
    for (const f of r.families as unknown[]) {
      if (typeof f !== "string" || !KNOWN_FAMILIES.includes(f)) {
        return `unknown family: ${f}`;
      }
    }
  }

  // semanticTemplate, placementId, scoringPolicy, semanticMode: strings
  for (const key of ["semanticTemplate", "placementId", "scoringPolicy", "semanticMode"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") {
      return `${key} must be a string`;
    }
  }

  return null;
}

function validateCreateBody(raw: unknown): {
  recipe?: DefenseRecipe;
  recipe_id?: string;
  turnstile_required?: boolean;
  experiment_id?: string;
  trial_key?: string;
} | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;

  const result: {
    recipe?: DefenseRecipe;
    recipe_id?: string;
    turnstile_required?: boolean;
    experiment_id?: string;
    trial_key?: string;
  } = {};

  // recipe_id: optional string
  if (body.recipe_id !== undefined) {
    if (typeof body.recipe_id !== "string") return null;
    result.recipe_id = body.recipe_id;
  }

  // turnstile_required: optional boolean
  if (body.turnstile_required !== undefined) {
    if (typeof body.turnstile_required !== "boolean") return null;
    result.turnstile_required = body.turnstile_required;
  }

  // experiment_id: optional string ≤ 128 chars
  if (body.experiment_id !== undefined) {
    if (typeof body.experiment_id !== "string" || body.experiment_id.length > 128) return null;
    result.experiment_id = body.experiment_id;
  }

  // trial_key: optional string ≤ 256 chars
  if (body.trial_key !== undefined) {
    if (typeof body.trial_key !== "string" || body.trial_key.length > 256) return null;
    result.trial_key = body.trial_key;
  }

  // recipe: optional object — validate fields
  if (body.recipe !== undefined) {
    if (typeof body.recipe !== "object" || body.recipe === null || Array.isArray(body.recipe)) {
      return null;
    }
    const validationErr = validateRecipeBody(body.recipe);
    if (validationErr) return null;
    result.recipe = body.recipe as DefenseRecipe;
  }

  return result;
}

/**
 * Build the recipe JSON to persist: recipe_id takes priority;
 * if recipe is also provided it is stored as a refinement on top.
 */
function buildRecipeJson(recipe?: DefenseRecipe, recipeId?: string): string | null {
  if (recipeId !== undefined && ABLATION_RECIPES[recipeId]) {
    // recipe_id is authoritative; merge in body recipe overrides
    const base = { ...ABLATION_RECIPES[recipeId] };
    if (recipe) {
      // Merge body recipe fields on top (recipe_id is authoritative base)
      for (const k of Object.keys(recipe) as (keyof DefenseRecipe)[]) {
        (base as Record<string, unknown>)[k] = (recipe as Record<string, unknown>)[k];
      }
      return JSON.stringify(base);
    }
    return JSON.stringify(base);
  }
  if (recipe) return JSON.stringify(recipe);
  return null;
}

// ─── Route handlers ─────────────────────────────────────────────────────

/**
 * POST /api/lab/runs — create a new lab run record.
 * Requires runner bearer auth (FR-R4-030).
 * FR-R5-035: Zod-style input validation with size limits.
 * FR-R5-037: Sets expires_at = now + 24h.
 */
export async function createLabRun(req: Request, env: Env): Promise<Response> {
  if (!isLabMode(env)) return error("lab API disabled in production", 404);
  if (req.method !== "POST") return error("method not allowed", 405);

  if (!requireLabAuth(req, env)) return error("unauthorized", 401);

  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 4096) return error("request body too large", 413);
    raw = JSON.parse(text);
  } catch {
    return error("invalid JSON", 400);
  }

  const validated = validateCreateBody(raw);
  if (validated === null) return error("invalid request body", 400);

  // If recipe_id present, validate it exists in ABLATION_RECIPES
  if (validated.recipe_id !== undefined) {
    if (!(validated.recipe_id in ABLATION_RECIPES)) {
      return error(`unknown recipe_id: ${validated.recipe_id}`, 400);
    }
  }

  // Best-effort expiry sweep (FR-R5-037)
  try {
    await expireStaleLabRuns(env.DB, Date.now());
  } catch {
    // Non-critical — don't block creation
  }

  const runId = "lab-" + generateHex(24);
  const createdAt = Date.now();
  const expiresAt = createdAt + 86_400_000; // 24h
  const recipeJson = buildRecipeJson(validated.recipe, validated.recipe_id);
  const turnstileRequired = validated.turnstile_required ? 1 : 0;

  // Generate one-time bind token and store only its SHA-256 hash
  const bindToken = generateHex(16);
  const bindTokenHash = await hashBindToken(bindToken);

  try {
    await env.DB.prepare(
      `INSERT INTO lab_runs (id, bind_token_hash, session_id, recipe_json, turnstile_required, status, created_at, expires_at, experiment_id, trial_key, recipe_id)
       VALUES (?, ?, NULL, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`
    )
      .bind(
        runId,
        bindTokenHash,
        recipeJson,
        turnstileRequired,
        createdAt,
        expiresAt,
        validated.experiment_id ?? null,
        validated.trial_key ?? null,
        validated.recipe_id ?? null
      )
      .run();
  } catch (e) {
    console.error("D1 insert failed in createLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  return json({ run_id: runId, bind_token: bindToken, status: "PENDING" });
}

/**
 * GET /api/lab/runs/:id — get authoritative server truth for a run.
 * Requires runner bearer auth (FR-R4-030).
 * FR-R5-004: If no session → pending-state response.
 *            If session exists (BOUND or COMPLETE): load session+submission+evidence+canary,
 *            include recipe_id, experiment_id, outcome, status.
 *            Emit status "COMPLETE" (not "RECONCILED").
 *            Remove auto-RECONCILED-on-GET behavior.
 */
export async function getLabRun(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isLabMode(env)) return error("lab API disabled in production", 404);
  if (req.method !== "GET") return error("method not allowed", 405);

  if (!requireLabAuth(req, env)) return error("unauthorized", 401);

  // Best-effort expiry sweep (FR-R5-037)
  try {
    await expireStaleLabRuns(env.DB, Date.now());
  } catch {
    // Non-critical
  }

  let record: {
    id: string;
    session_id: string | null;
    recipe_json: string | null;
    turnstile_required: number | null;
    status: string;
    created_at: number;
    reconciled_at: number | null;
    experiment_id: string | null;
    trial_key: string | null;
    recipe_id: string | null;
    outcome: string | null;
    expires_at: number | null;
    terminal_reason: string | null;
  } | null;

  try {
    record = await env.DB.prepare(
      `SELECT id, session_id, recipe_json, turnstile_required, status, created_at, reconciled_at,
              experiment_id, trial_key, recipe_id, outcome, expires_at, terminal_reason
       FROM lab_runs WHERE id = ?`
    )
      .bind(runId)
      .first();
  } catch (e) {
    console.error("D1 select failed in getLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  if (!record) return error("run not found", 404);

  // FR-R5-004: If no session → pending-state response
  if (!record.session_id) {
    return json({
      run_id: record.id,
      status: record.status,
      submitted: false,
      experiment_id: record.experiment_id,
      recipe_id: record.recipe_id,
      outcome: record.outcome,
      expires_at: record.expires_at,
      terminal_reason: record.terminal_reason,
    });
  }

  // Session exists — load full server truth (same as today but status = "COMPLETE" when outcome set)
  let session: Awaited<ReturnType<typeof loadSession>>;

  try {
    session = await loadSession(env.DB, record.session_id);
  } catch (e) {
    console.error("D1 loadSession failed in getLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  // Reconstruct profile to get defense families + variant ID
  let profile;
  try {
    profile = await deriveProfile(env, record.session_id, session?.profileVersion);
  } catch {
    return error("internal server error", 500);
  }

  // Get submission record
  let submission: {
    id: number;
    disposition: string;
    risk_score: number;
    policy: string;
    reasons_json: string;
    causal_hits: number;
    strong_hits: number;
    weak_hits: number;
  } | null;

  try {
    submission = await env.DB.prepare(
      `SELECT id, disposition, risk_score, policy, reasons_json, causal_hits, strong_hits, weak_hits
       FROM submissions WHERE session_id = ?`
    )
      .bind(record.session_id)
      .first();
  } catch (e) {
    console.error("D1 submissions select failed in getLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  // Get evidence
  let evidenceRows: { results: {
    evidence_class: string;
    source: string;
    weight: number;
    verified: number;
    metadata_json: string;
  }[] } | { results: [] };

  try {
    evidenceRows = submission
      ? await env.DB.prepare(
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
        }>()
      : { results: [] };
  } catch (e) {
    console.error("D1 evidence select failed in getLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  // Get canary hits
  let canaryHits: { count: number } | null;
  try {
    canaryHits = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM canary_hits WHERE session_id = ? AND verified = 1`
    )
      .bind(record.session_id)
      .first();
  } catch (e) {
    console.error("D1 canary_hits select failed in getLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  // FR-R4-031: canary_issued — server truth (harness recorder decides actual exposure)
  const canary_issued = profile.semantic ? true : false;
  const canary_verified_server = (canaryHits?.count ?? 0) > 0;
  const submitted = session?.submitted === 1;

  // NO auto-RECONCILED update — status only changes via explicit outcome POST (FR-R5-004)

  return json({
    run_id: record.id,
    session_id: record.session_id,
    submitted,
    disposition: session?.finalDisposition,
    score: session?.finalScore,
    profile_id: profile.profileId,
    profile_version: session?.profileVersion,
    profile_variant_id: profile.profileVariantId,
    defense_families: profile.families,
    semantic_template: profile.semantic?.templateId ?? null,
    placement: profile.semantic?.placementId ?? null,
    turnstile_required: record.turnstile_required ?? 0,
    canary_issued,
    canary_verified_server,
    experiment_id: record.experiment_id,
    recipe_id: record.recipe_id,
    outcome: record.outcome,
    status: record.outcome ? "COMPLETE" : record.status,
    submission: submission
      ? {
          disposition: submission.disposition,
          score: submission.risk_score,
          policy: submission.policy,
          reasons: JSON.parse(submission.reasons_json || "[]"),
          causal_hits: submission.causal_hits,
          strong_hits: submission.strong_hits,
          weak_hits: submission.weak_hits,
          evidence: evidenceRows.results.map((e) => ({
            class: e.evidence_class,
            source: e.source,
            weight: e.weight,
            verified: e.verified === 1,
            metadata: JSON.parse(e.metadata_json || "{}"),
          })),
        }
      : null,
  });
}

/**
 * POST /api/lab/runs/:id/outcome — runner reports outcome.
 * FR-R5-006/013-style runner auth. Transitions BOUND → COMPLETE.
 */
export async function postLabRunOutcome(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isLabMode(env)) return error("lab API disabled in production", 404);
  if (req.method !== "POST") return error("method not allowed", 405);

  if (!requireLabAuth(req, env)) return error("unauthorized", 401);

  // Validate outcome enum
  const VALID_OUTCOMES = ["submitted", "stopped", "handoff", "timeout", "error"];

  let body: { outcome: string; error_code?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return error("invalid JSON", 400);
  }

  if (!body.outcome || !VALID_OUTCOMES.includes(body.outcome)) {
    return error(`invalid outcome: must be one of ${VALID_OUTCOMES.join(", ")}`, 400);
  }

  // Look up the run
  let record: {
    id: string;
    status: string;
    bind_token_hash: string | null;
  } | null;

  try {
    record = await env.DB.prepare(
      `SELECT id, status, bind_token_hash FROM lab_runs WHERE id = ?`
    )
      .bind(runId)
      .first();
  } catch (e) {
    console.error("D1 select failed in postLabRunOutcome", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  if (!record) return error("run not found", 404);

  // Must be BOUND to accept an outcome
  if (record.status !== "BOUND") {
    return error(`cannot set outcome on run with status ${record.status}`, 409);
  }

  const terminalReason = body.error_code ?? body.outcome;

  try {
    await env.DB.prepare(
      `UPDATE lab_runs SET outcome = ?, terminal_reason = ?, status = 'COMPLETE' WHERE id = ?`
    )
      .bind(body.outcome, terminalReason, runId)
      .run();
  } catch (e) {
    console.error("D1 update failed in postLabRunOutcome", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  return json({ run_id: runId, status: "COMPLETE", outcome: body.outcome });
}

/**
 * POST /api/lab/runs/:id/associate — browser bind, one-time capability.
 * Uses bind token (not runner bearer secret) — the browser agent's context.
 */
export async function associateLabRun(req: Request, env: Env, runId: string): Promise<Response> {
  if (!isLabMode(env)) return error("lab API disabled in production", 404);
  if (req.method !== "POST") return error("method not allowed", 405);

  // Look up the run
  let record: {
    id: string;
    session_id: string | null;
    bind_token_hash: string | null;
    status: string;
  } | null;

  try {
    record = await env.DB.prepare(
      `SELECT id, session_id, bind_token_hash, status FROM lab_runs WHERE id = ?`
    )
      .bind(runId)
      .first();
  } catch (e) {
    console.error("D1 select failed in associateLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  if (!record) return error("run not found", 404);

  // Accept bind_token from JSON body or query parameter
  const url = new URL(req.url);
  const queryBind = url.searchParams.get("bind_token");

  let bindTokenValue: string | null = null;
  if (queryBind) {
    bindTokenValue = queryBind;
  } else {
    let body: { bind_token?: string };
    try {
      body = (await req.json()) as typeof body;
      bindTokenValue = body.bind_token ?? null;
    } catch {
      return error("invalid JSON", 400);
    }
  }

  if (!bindTokenValue) return error("bind_token required", 400);

  // If bind_token_hash is NULL → already bound or never issued
  if (record.bind_token_hash === null) return error("bind token not available", 400);

  // Compute SHA-256 of provided token and constant-time compare
  const providedHash = await hashBindToken(bindTokenValue);
  if (!constantTimeEqualStr(providedHash, record.bind_token_hash)) {
    return error("forbidden", 403);
  }

  // Get session from cookie
  const sessionId = getSessionId(req);
  if (!sessionId) return error("session required", 401);

  // One-time use: NULL the hash, set session_id, mark BOUND
  try {
    await env.DB.prepare(
      `UPDATE lab_runs SET session_id = ?, bind_token_hash = NULL, status = 'BOUND'
       WHERE id = ? AND bind_token_hash = ?`
    )
      .bind(sessionId, runId, record.bind_token_hash)
      .run();
  } catch (e) {
    console.error("D1 update failed in associateLabRun", { error: e instanceof Error ? e.message : String(e) });
    return error("internal server error", 500);
  }

  return json({ run_id: record.id, session_id: sessionId, status: "BOUND" });
}

/**
 * POST /api/lab/runs/ingest — publish harness RunRecordV1 results to the D1
 * run index (FR-R4-070). Full artifacts stay local to the runner; this stores
 * the compact run metadata that admin experiment pages query.
 * Requires runner bearer auth. Must be routed BEFORE the /:id GET matcher.
 */
export async function ingestLabRuns(req: Request, env: Env): Promise<Response> {
  if (!isLabMode(env)) return error("lab API disabled in production", 404);
  if (req.method !== "POST") return error("method not allowed", 405);
  if (!requireLabAuth(req, env)) return error("unauthorized", 401);

  let body: { runs?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return error("invalid JSON", 400);
  }
  if (!Array.isArray(body.runs) || body.runs.length === 0) {
    return error("runs array required", 400);
  }
  if (body.runs.length > 1000) {
    return error("too many runs per batch", 413);
  }

  const stmts: D1PreparedStatement[] = [];
  const ensuredExperiments = new Set<string>();
  let ingested = 0;
  const rejected: { run_id?: string; reason: string }[] = [];

  for (const raw of body.runs) {
    // Minimal shape gate — full validation is the runner's job (RunRecordV1
    // schema). We store a summary subset, not the whole record (FR-R4-070).
    const r = raw as Record<string, unknown>;
    const runId = typeof r.run_id === "string" ? r.run_id : null;
    const experimentId = typeof r.experiment_id === "string" ? r.experiment_id : null;
    if (!runId || !experimentId) {
      rejected.push({ run_id: runId ?? undefined, reason: "missing run_id or experiment_id" });
      continue;
    }
    const agent = typeof r.agent === "string" ? r.agent : "unknown";
    const model = typeof r.model === "string" ? r.model : "unknown";
    const promptVariant = typeof r.prompt_variant === "string" ? r.prompt_variant : "unknown";
    const outcome = typeof r.outcome === "string" ? r.outcome : null;
    const errorCode = typeof r.error_code === "string" ? r.error_code : null;
    const submitted = r.submitted === true ? 1 : 0;
    const serverReconciled = r.server_reconciled === true ? 1 : 0;
    const disposition = typeof r.disposition === "string" ? r.disposition : null;
    const recipeId = typeof r.recipe_id === "string" ? r.recipe_id : null;
    const profileVariantId = typeof r.profile_variant_id === "string" ? r.profile_variant_id : null;
    const canaryVerified = r.canary_verified_server === true ? 1 : 0;
    const canaryReferenced = r.canary_referenced === true ? 1 : 0;
    const elapsedMs = typeof r.elapsed_ms === "number" && Number.isFinite(r.elapsed_ms) ? Math.round(r.elapsed_ms) : null;
    const actionCount = typeof r.action_count === "number" && Number.isSafeInteger(r.action_count) ? r.action_count : null;
    const createdAt = typeof r.completed_at === "number" && Number.isSafeInteger(r.completed_at) ? r.completed_at : Date.now();
    const sessionId = typeof r.session_id === "string" ? r.session_id : null;

    // Ensure the parent experiment row exists (experiments table is the FK target)
    if (!ensuredExperiments.has(experimentId)) {
      ensuredExperiments.add(experimentId);
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO experiments (id, name, created_at, config_json, status)
           VALUES (?, ?, ?, '{}', 'INGESTED')`
        ).bind(experimentId, experimentId, createdAt)
      );
    }

    // Idempotent upsert keyed by run_id
    stmts.push(
      env.DB.prepare(
        `INSERT INTO harness_runs
           (id, run_id, experiment_id, session_id, created_at, agent, model, prompt_variant,
            outcome, submitted, disposition, recipe_id, profile_variant_id, canary_referenced,
            canary_verified, elapsed_ms, action_count, error_code, server_reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           outcome = excluded.outcome,
           submitted = excluded.submitted,
           disposition = excluded.disposition,
           recipe_id = excluded.recipe_id,
           profile_variant_id = excluded.profile_variant_id,
           canary_referenced = excluded.canary_referenced,
           canary_verified = excluded.canary_verified,
           elapsed_ms = excluded.elapsed_ms,
           action_count = excluded.action_count,
           error_code = excluded.error_code,
           server_reconciled = excluded.server_reconciled`
      ).bind(
        runId, runId, experimentId, sessionId, createdAt, agent, model, promptVariant,
        outcome, submitted, disposition, recipeId, profileVariantId, canaryReferenced,
        canaryVerified, elapsedMs, actionCount, errorCode, serverReconciled
      )
    );
    ingested++;
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error("FireRaid lab ingest D1 failure:", {
        error: e instanceof Error ? e.message : String(e),
      });
      return error("ingest failed", 500);
    }
  }

  return json({ ingested, rejected });
}

// ─── Utility ────────────────────────────────────────────────────────────

/**
 * Generate a hex string of the given byte length.
 * Uses crypto.getRandomValues for CSPRNG.
 */
function generateHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
