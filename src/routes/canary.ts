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
  ensureSessionRow,
} from "../cloudflare/session-envelope.js";;
import { reconstructIssuedProfile } from "../core/reconstruct.js";
import type { DefenseRecipe } from "../core/recipe-schema.js";
import { readLabAssignment } from "../core/lab-assignment.js";

/** Hash a token for storage (SHA-256 hex). */
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time token comparison — the CORE primitive (core/tokens.ts),
 * re-exported for the Worker route's callers. One definition serves both
 * planes (Worker + host middleware).
 */
export { constantTimeTokenEqual } from "../core/tokens.js";
import { constantTimeTokenEqual } from "../core/tokens.js";

/**
 * P1-AUDIT-2: record a verified canary hit, FAILING CLOSED on persistence
 * errors. Returns true when the hit was recorded (or was an idempotent
 * replay), false when a real storage error occurred — the caller must then
 * fail the request (500) rather than report attacker success. INSERT OR
 * IGNORE keeps genuine replays idempotent (unique violation is swallowed);
 * only a REAL storage failure surfaces as an error here.
 */
export async function persistVerifiedHit(
  db: D1Database,
  sessionId: string,
  token: string,
  expected: string,
  nowMs: number
): Promise<boolean> {
  const expectedHash = await hashToken(expected);
  const observedHash = await hashToken(token);
  try {
    // P1-9: the hit insert AND the compact session flag land in ONE batch —
    // the flag can never disagree with the hit log, and submit reads the
    // flag from the session row it loads anyway instead of COUNT-ing
    // canary_hits per submission.
    await db.batch([
      db.prepare(
        `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
         VALUES (?, ?, 'decoy-route', 'A', ?, ?, 1)
         ON CONFLICT (session_id, family, expected_hash) DO NOTHING`
      ).bind(sessionId, nowMs, expectedHash, observedHash),
      db.prepare(
        `UPDATE sessions SET causal_route_hit = 1 WHERE id = ?`
      ).bind(sessionId),
    ]);
    return true;
  } catch (err) {
    console.error("canary hit persistence failed (failing closed):", err);
    return false;
  }
}

export async function canary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = url.pathname.replace(/^\/c\//, "");
  if (!token) return error("missing token", 400);

  // FR-P1-19: let — reassigned to the canonical (envelope-unwrapped) id
  // after ensureSessionRow.
  let sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  // FR-P1-19: a canary hit is a stateful first action — materializes the
  // stateless production session row from the signed envelope.
  const session = await ensureSessionRow(env, sessionId);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);
  // FR-P1-19: canonical id — FK targets materialize under the envelope's
  // inner sid, never the envelope string.
  sessionId = session.id;

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
    // P1-AUDIT-2: FAIL CLOSED on bound-assignment read/parse errors (shared
    // helper readLabAssignment, mirrors submit.ts). A bound session's token
    // derivation must never fall back to a random profile on a D1 read
    // failure — that would yield a decoyRoute token DIFFERENT from the one
    // rendered, breaking every legitimate REQUESTED→VERIFIED hit and
    // corrupting the causal signal.
    const read = await readLabAssignment(env.DB, sessionId);
    if (!read.ok) {
      console.error(
        "canary lab-assignment read failed (failing closed):",
        `${read.code}: ${read.detail}`
      );
      return error(
        read.code === "assignment_corrupt" ? "session assignment corrupt" : "session assignment unreadable",
        500
      );
    }
    if (read.assignment?.recipe != null) recipe = read.assignment.recipe;
    // FR-POST-R6-P5: holdout flag is part of the treatment identity.
    holdoutMode = read.assignment?.holdoutMode;
    // FR-P0-17: verification condition likewise.
    turnstileRequired = read.assignment?.turnstileRequired;
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

  // Record verified causal hit — FAIL CLOSED (P1-AUDIT-2). A verified canary
  // hit is the experiment's core observable: losing it while returning 204
  // (attacker success) silently corrupts the causal signal and the ledger-
  // proof join. persistVerifiedHit returns false only on a REAL storage
  // failure (replays are idempotent via targeted ON CONFLICT DO NOTHING),
  // which must fail the request, never be swallowed.
  if (!(await persistVerifiedHit(env.DB, sessionId, token, expected, now()))) {
    return error("canary persistence failed", 500);
  }

  return noContent();
}
