/**
 * Canonical profile reconstruction (FR-R6-004/050/094).
 *
 * ONE function resolves the profile that was ACTUALLY ISSUED to a session:
 *   profile version + profile key id + lab recipe (if bound) + mode + session id
 *
 * Every route that needs the issued profile — submit, canary, lab, admin —
 * calls reconstructIssuedProfile(). Route-local deriveProfile() calls with
 * ad-hoc arguments are how reconciliation drift happened (each route could
 * reconstruct a slightly different profile for the same session).
 *
 * Key rotation (FR-R6-043): the session's persisted profile_key_id selects
 * the secret from the ring. NULL id → current key (legacy rule). An unknown
 * historical id FAILS CLOSED.
 */
import type { Env } from "../env.js";
import { profileVersion, isLabMode } from "../env.js";
import { loadSessionKey } from "../cloudflare/session.js";
import {
  resolveProfileKey,
  type ProfileKeyRing,
} from "./session.js";
import { deriveProfilePure, type DeriveProfileOptions } from "./profile.js";
import type { DefenseRecipe } from "./recipe-schema.js";
import type { DefenseProfile } from "../types/profile.js";

/** Session row fields reconstruction needs (subset of SessionPayload + key id). */
export interface ReconstructableSession {
  id: string;
  profileVersion: number;
  profileKeyId?: string | null;
}

/** Result variants: ok, or a typed failure the caller must handle fail-closed. */
export type ReconstructionResult =
  | { ok: true; profile: DefenseProfile }
  | { ok: false; code: "UNKNOWN_PROFILE_KEY" | "INVALID_RECIPE" | "DERIVATION_FAILED"; detail: string };

/**
 * Reconstruct the issued profile for a session.
 *
 * @param env        Worker env (mode, key ring, current version fallback)
 * @param session    authoritative session record (id, version, key id)
 * @param recipe     the bound lab run's parsed recipe, when one is bound.
 *                   Callers fetch recipe_json themselves (they already hold
 *                   the lab-run row) and pass it here — this module never
 *                   guesses a condition.
 */
export async function reconstructIssuedProfile(
  env: Env,
  session: ReconstructableSession,
  recipe?: DefenseRecipe
): Promise<ReconstructionResult> {
  // 1. Resolve the key that derived this session's profile.
  let ring: ProfileKeyRing;
  try {
    ring = resolveProfileKey(env);
  } catch (err) {
    return {
      ok: false,
      code: "UNKNOWN_PROFILE_KEY",
      detail: err instanceof Error ? err.message : "key ring unreadable",
    };
  }

  const keyId = session.profileKeyId ?? null;
  let secret: string;
  if (keyId === null) {
    // Legacy rule: rows written before key persistence used the current key.
    secret = ring.current.secret;
  } else if (keyId === ring.current.id) {
    secret = ring.current.secret;
  } else if (ring.previous && keyId in ring.previous) {
    secret = ring.previous[keyId];
  } else {
    // Unknown historical key — fail closed, never derive with the wrong key.
    return {
      ok: false,
      code: "UNKNOWN_PROFILE_KEY",
      detail: `session references unknown profile key id: ${keyId}`,
    };
  }

  // 2. Resolve the version: the session's persisted version is authoritative
  //    for reconstruction; only fall back to env when absent (legacy rows).
  const version = session.profileVersion ?? profileVersion(env);

  // 3. Derive with the resolved secret + the bound recipe (if any).
  const opts: DeriveProfileOptions = {
    secret,
    version,
    sessionId: session.id,
    mode: isLabMode(env) ? "lab" : "production",
  };
  try {
    const profile = await deriveProfilePure(opts, recipe);
    return { ok: true, profile };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: detail.startsWith("INVALID_RECIPE") ? "INVALID_RECIPE" : "DERIVATION_FAILED",
      detail,
    };
  }
}

/**
 * Convenience wrapper: reconstruct from a session id, loading the key id
 * from D1. Used by routes that hold only the session id.
 */
export async function reconstructFromSessionId(
  env: Env,
  sessionId: string,
  opts?: { profileVersion?: number; recipe?: DefenseRecipe }
): Promise<ReconstructionResult> {
  const profileKeyId = await loadSessionKey(env.DB, sessionId);
  return reconstructIssuedProfile(
    env,
    {
      id: sessionId,
      profileVersion: opts?.profileVersion ?? profileVersion(env),
      profileKeyId,
    },
    opts?.recipe
  );
}
