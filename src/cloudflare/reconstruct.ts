/**
 * Cloudflare-specific session reconstruction — loads from D1, resolves key
 * ring, delegates to the pure path.
 *
 * The pure reconstruction logic (reconstructIssuedProfile) lives in
 * `core/reconstruct.ts`. This module wraps it with D1 session loading
 * so routes can call reconstructFromSessionId(env, sessionId) without
 * manually performing the SELECT + key resolution dance.
 *
 * This function belongs in the adapter layer (not core) because it:
 *  - dynamically imports from ./session.js (Cloudflare session adapter)
 *  - delegates to loadSession (D1-backed)
 */
import type { DefenseRecipe } from "../core/recipe-schema.js";
import type { ReconstructionResult } from "../core/reconstruct.js";
import type { Env } from "../env.js";

/**
 * Cloudflare-specific reconstruction: loads session from D1, resolves secret,
 * then delegates to reconstructIssuedProfile.
 *
 * Used by admin and lab routes that already hold a session id but not the
 * full ReconstructableSession object. Routes that already call loadSession
 * SHOULD pass the loaded profileKeyId directly to reconstructIssuedProfile
 * to avoid the duplicate SELECT.
 */
export async function reconstructFromSessionId(
  env: Env,
  sessionId: string,
  opts?: {
    profileVersion?: number;
    recipe?: DefenseRecipe;
    /** FR-POST-R6-P5: the bound run's persisted holdout_mode. */
    holdoutMode?: boolean;
    /** FR-P0-17: the bound run's persisted verification condition. */
    turnstileRequired?: boolean;
  }
): Promise<ReconstructionResult> {
  // Lazily import to avoid a circular module-graph edge between core and
  // the Cloudflare session adapter (the adapter already imports core types).
  const { loadSession } = await import("./session.js");
  const { reconstructIssuedProfile: reconstruct } = await import("../core/reconstruct.js");
  const loaded = await loadSession(env.DB, sessionId);
  if (!loaded) {
    return { ok: false, code: "DERIVATION_FAILED", detail: "session not found" };
  }
  return reconstruct(
    env,
    {
      id: sessionId,
      profileVersion: opts?.profileVersion ?? loaded.profileVersion,
      profileKeyId: loaded.profileKeyId ?? null,
    },
    opts?.recipe,
    { holdoutMode: opts?.holdoutMode, turnstileRequired: opts?.turnstileRequired }
  );
}
