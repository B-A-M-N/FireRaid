/**
 * Canary endpoint — GET /c/:token, POST /c/:token.
 * Resolves session, reconstructs profile, verifies expected token.
 * Returns 204 (no side effects) — FR-INV-007.
 * FIX: Uses session's stored profile version for reconstruction.
 * FIX: Hashes tokens in DB columns (FR-013).
 */
import { noContent, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  loadSession,
  isExpired,
  now,
} from "../core/session.js";
import { deriveProfile } from "../core/profile.js";

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

  // FIX: Use session's stored profile version
  const profile = await deriveProfile(env, sessionId, session.profileVersion);
  if (!profile.decoy) return error("no decoy for this session", 404);

  // Constant-time comparison (no early return on length mismatch)
  const expected = profile.decoy.endpointToken;
  if (!constantTimeTokenEqual(token, expected)) {
    return error("invalid token", 403);
  }

  // FIX: Store hashed tokens, not raw (FR-013)
  const expectedHash = await hashToken(expected);
  const observedHash = await hashToken(token);

  // Record verified causal hit (best-effort)
  try {
    await env.DB.prepare(
      `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES (?, ?, 'decoy-route', 'A', ?, ?, 1)`
    )
      .bind(sessionId, now(), expectedHash, observedHash)
      .run();
  } catch {
    // D1 insert failure must not block response
  }

  return noContent();
}
