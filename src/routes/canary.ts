/**
 * Canary endpoint — GET /c/:token, POST /c/:token.
 * Resolves session, reconstructs profile, verifies expected token.
 * Returns 204 (no side effects) — FR-INV-007.
 * FIX: Uses session's stored profile version for reconstruction.
 * FIX: Hashes tokens in DB columns (FR-013).
 */
import { noContent, error } from "../security/headers.js";
import type { Env } from "../env.js";
import { isLabMode } from "../env.js";
import {
  getSessionId,
  isExpired,
  now,
} from "../core/session.js";
import {
  loadSession,
} from "../cloudflare/session.js";;
import { reconstructIssuedProfile } from "../core/reconstruct.js";
import type { DefenseRecipe } from "../core/recipe-schema.js";

/** Hash a token for storage (SHA-256 hex). */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Length difference is folded into the
 * accumulator so timing does not leak token length or match position.
 */
export function constantTimeTokenEqual(token: string, expected: string): boolean {
  const len = Math.max(token.length, expected.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const x = i < token.length ? token.charCodeAt(i) : 0;
    const y = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= x ^ y;
  }
  diff |= token.length ^ expected.length;
  return diff === 0;
}

export async function canary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.pathname.replace(/^\/c\//, "");
  if (!token) return error("missing token", 400);

  const sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  const session = await loadSession(env.DB, sessionId);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);

  // FR-R6-050: canonical reconstruction (recipe + key-id aware), never a
  // route-local deriveProfile with ad-hoc arguments.
  // FR-POST-R6-P4: a lab-BOUND session's profile is recipe-derived — the
  // reconstruction MUST load the bound recipe the same way submit.ts does,
  // or the reconstructed decoyRoute token differs from the RENDERED token
  // and every legitimate REQUESTED→VERIFIED causal hit 403s. Found by the
  // Phase 4 perception-chain integration test (render/reconstruct drift).
  // FR-R7-019: production has no bound research runs; the lab_runs query
  // is gated behind isLabMode(env) so a production /c/ is one session
  // SELECT + one reconstruction, not three D1 round-trips.
  let recipe: DefenseRecipe | undefined;
  let holdoutMode: boolean | undefined;
  // FR-P0-17: verification condition — hashed into the issued variant id.
  let turnstileRequired: boolean | undefined;
  if (isLabMode(env)) {
    try {
      const row = await env.DB.prepare(
        `SELECT recipe_json, holdout_mode, turnstile_required FROM lab_runs WHERE session_id = ? AND status IN ('BOUND','COMPLETE') LIMIT 1`
      )
        .bind(sessionId)
        .first<{ recipe_json: string | null; holdout_mode: number | null; turnstile_required: number | null }>();
      const raw = row?.recipe_json;
      if (typeof raw === "string" && raw.length > 0) {
        recipe = JSON.parse(raw) as DefenseRecipe;
      }
      // FR-POST-R6-P5: holdout flag is part of the treatment identity.
      if (row && row.holdout_mode !== null) holdoutMode = row.holdout_mode === 1;
      // FR-P0-17: verification condition likewise.
      if (row && row.turnstile_required !== null) turnstileRequired = row.turnstile_required === 1;
    } catch {
      recipe = undefined; // unbound session — random lab/production profile
    }
  }
  // FR-R7-018: pass the already-loaded session's key id straight into the
  // canonical reconstructor — no second session SELECT.
  const reconstructed = await reconstructIssuedProfile(env, {
    id: sessionId,
    profileVersion: session.profileVersion,
    profileKeyId: session.profileKeyId ?? null,
  }, recipe, { holdoutMode, turnstileRequired });
  if (!reconstructed.ok) {
    console.error("canary reconstruction failed:", reconstructed.code, reconstructed.detail);
    return error("profile reconstruction failed", 500);
  }
  const profile = reconstructed.profile;

  // FR-R6-028: the route token lives ONLY in decoyRoute — a DECOY_FIELD_ONLY
  // session (no decoyRoute) must 404 here, not fall back to aggregate state.
  if (!profile.decoyRoute) return error("no decoy route for this session", 404);

  // Constant-time comparison (no early return on length mismatch)
  const expected = profile.decoyRoute.endpointToken;
  if (!constantTimeTokenEqual(token, expected)) {
    return error("invalid token", 403);
  }

  // FIX: Store hashed tokens, not raw (FR-013)
  const expectedHash = await hashToken(expected);
  const observedHash = await hashToken(token);

  // Record verified causal hit (best-effort).
  // FR-R6-051: INSERT OR IGNORE against idx_canary_unique_verified — replayed
  // hits are idempotent, and real storage errors are logged, not swallowed.
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES (?, ?, 'decoy-route', 'A', ?, ?, 1)`
    )
      .bind(sessionId, now(), expectedHash, observedHash)
      .run();
  } catch (err) {
    console.error("canary hit persistence failed:", err);
  }

  return noContent();
}
