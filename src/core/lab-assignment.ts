/**
 * P1-AUDIT-2: fail-closed lab treatment assignment resolution.
 *
 * Shared by submit.ts and canary.ts. A bound lab session's immutable
 * treatment (recipe + holdout + turnstile condition) is part of its hashed
 * variant identity and is RENDERED at signup. If the assignment cannot be
 * READ BACK, the session must not silently fall back to a random profile —
 * doing so produces a decoy claim that differs from the one rendered,
 * corrupting the causal signal (and in canary's case, 403ing every
 * legitimate REQUESTED→VERIFIED hit).
 *
 * Contract:
 *   - query SUCCEEDS, no lab_runs row  → Genuinely unbound → random (legit).
 *     Returns { ok:true, assignment:null }.
 *   - query THROWS / recipe_json corrupt → Infrastructure failure → the caller
 *     must FAIL THE REQUEST (500), never reconstruct a random profile.
 *     Returns { ok:false, code, detail }.
 */
import type { DefenseRecipe } from "./recipe-schema.js";

export interface LabAssignment {
  /** The bound recipe, when the run carries one (may be null for recipes
   *  with no JSON payload — e.g. an empty-CONTROL). */
  recipe?: DefenseRecipe | null;
  /** part of the treatment identity (FR-POST-R6-P5). */
  holdoutMode?: boolean;
  /** part of the treatment identity (FR-P0-17). */
  turnstileRequired?: boolean;
}

export type LabAssignmentRead =
  | { ok: true; assignment: LabAssignment | null }
  | { ok: false; code: "assignment_unreadable" | "assignment_corrupt"; detail: string };

/**
 * Minimal database interface for lab-assignment reads.
 *
 * Core modules must never depend on a concrete Cloudflare D1Database type.
 * Callers pass an object that implements this interface — for production code,
 * the D1Database instance satisfies it (via structural typing); for tests,
 * any stub matching the shape works.
 */
export interface LabDb {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

/**
 * Read + parse a session's bound lab assignment, failing closed as above.
 * Returns ok:false on ANY infrastructure error; the caller decides the HTTP
 * status (500 in both routes).
 */
export async function readLabAssignment(
  db: LabDb,
  sessionId: string
): Promise<LabAssignmentRead> {
  let row: { recipe_json: string | null; holdout_mode: number | null; turnstile_required: number | null } | null;
  try {
    row = await db
      .prepare(
        `SELECT recipe_json, holdout_mode, turnstile_required
           FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
      )
      .bind(sessionId)
      .first<{ recipe_json: string | null; holdout_mode: number | null; turnstile_required: number | null }>();
  } catch (err) {
    return {
      ok: false,
      code: "assignment_unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!row) {
    // Genuinely unbound — let the caller use the random (derived) profile.
    return { ok: true, assignment: null };
  }
  // P1-12: ONE parser for both readers — signup's bind read and the two
  // post-bind route reads can never disagree on parse/fail-closed rules.
  return parseAssignmentRow(row);
}

/**
 * P1-12: the BIND-TIME twin of readLabAssignment — same contract, keyed on
 * the lab RUN id (the session is not bound yet at signup). Before this
 * existed, signup.ts carried its own SELECT + JSON.parse + try/catch that
 * could drift from this module's fail-closed semantics (exactly the
 * divergence the audit flagged between the two POST routes). One module
 * now owns both reads; the row shape is identical so the parse logic is
 * literally shared below.
 */
export async function readLabAssignmentByRunId(
  db: LabDb,
  runId: string
): Promise<LabAssignmentRead> {
  let row: { recipe_json: string | null; holdout_mode: number | null; turnstile_required: number | null } | null;
  try {
    row = await db
      .prepare(
        `SELECT recipe_json, holdout_mode, turnstile_required FROM lab_runs WHERE id = ?`
      )
      .bind(runId)
      .first<{ recipe_json: string | null; holdout_mode: number | null; turnstile_required: number | null }>();
  } catch (err) {
    return {
      ok: false,
      code: "assignment_unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!row) {
    return {
      ok: false,
      code: "assignment_unreadable",
      detail: "lab run row vanished between bind-start and recipe read",
    };
  }
  return parseAssignmentRow(row);
}

/** Shared row → assignment parser for both readers (one parse = one drift). */
function parseAssignmentRow(row: {
  recipe_json: string | null;
  holdout_mode: number | null;
  turnstile_required: number | null;
}): LabAssignmentRead {
  const assignment: LabAssignment = {};
  const raw = row.recipe_json;
  if (raw != null && raw.length > 0) {
    try {
      assignment.recipe = JSON.parse(raw) as DefenseRecipe;
    } catch {
      return {
        ok: false,
        code: "assignment_corrupt",
        detail: raw.slice(0, 80),
      };
    }
  }
  if (row.holdout_mode !== null) assignment.holdoutMode = row.holdout_mode === 1;
  if (row.turnstile_required !== null) assignment.turnstileRequired = row.turnstile_required === 1;

  return { ok: true, assignment };
}