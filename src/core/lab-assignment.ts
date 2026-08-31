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
 * Read + parse a session's bound lab assignment, failing closed as above.
 * Returns ok:false on ANY infrastructure error; the caller decides the HTTP
 * status (500 in both routes).
 */
export async function readLabAssignment(
  db: D1Database,
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

  const assignment: LabAssignment = {};
  const raw = row.recipe_json;
  if (raw != null && raw.length > 0) {
    try {
      assignment.recipe = JSON.parse(raw) as DefenseRecipe;
    } catch {
      // A bound run whose recipe cannot be parsed is corruption, not evidence
      // of an unbound session. Fail closed.
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