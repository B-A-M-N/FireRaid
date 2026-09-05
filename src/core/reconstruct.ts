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
import {
  resolveProfileKey,
  type ProfileKeyRing,
} from "./session.js";
import { deriveEvaluationProfileByVersion } from "./profile-versions.js";
import { hashProfile } from "./profile.js";
import type { DefenseRecipe } from "./recipe-schema.js";
import type { DefenseProfile } from "../types/profile.js";

/** Session row fields reconstruction needs (subset of SessionPayload + key id). */
export interface ReconstructableSession {
  id: string;
  profileVersion: number;
  profileKeyId?: string | null;
  /**
   * FR-P0-04: the profile hash AS ISSUED (persisted at issuance). When
   * present, the reconstructed profile is compared against it and a
   * mismatch FAILS CLOSED — derivation ran but produced something other
   * than what the session was shown.
   */
  profileHash?: string | null;
}

/** Result variants: ok, or a typed failure the caller must handle fail-closed. */
export type ReconstructionResult =
  | { ok: true; profile: DefenseProfile }
  | {
      ok: false;
      code:
        | "UNKNOWN_PROFILE_KEY"
        | "INVALID_RECIPE"
        | "DERIVATION_FAILED"
        | "UNSUPPORTED_PROFILE_VERSION"
        | "PROFILE_HASH_MISMATCH";
      detail: string;
    };

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
  recipe?: DefenseRecipe,
  options?: {
    holdoutMode?: boolean;
    /**
     * FR-P0-17: the run's assigned verification condition. Part of the
     * hashed treatment identity (buildVariantId) — reconstruction without
     * it derives a DIFFERENT variant id than issuance whenever the run
     * required verification. Callers read the persisted lab_runs column.
     */
    turnstileRequired?: boolean;
  }
): Promise<ReconstructionResult> {
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
  // FR-POST-R6-P5: holdoutMode is part of the issued treatment identity —
  // it changes the random template pool, so reconstruction MUST see the
  // same value the issuing render saw or a holdout session reconstructs a
  // different profile (the same drift class the canary.ts recipe fix
  // addressed). Persisted per lab run; callers pass what the run stored.
  const opts = {
    secret,
    version,
    sessionId: session.id,
    mode: isLabMode(env) ? ("lab" as const) : ("production" as const),
    holdoutMode: options?.holdoutMode === true,
    // FR-P0-17: same condition issuance hashed in.
    turnstileRequired: options?.turnstileRequired === true,
  };
  try {
    // FR-P0-04: reconstruction dispatches by the session's PERSISTED version
    // to the frozen implementation for that version. An unknown historical
    // version fails closed (UNSUPPORTED_PROFILE_VERSION) — it never runs
    // current code under an old number, which is exactly how a profile
    // silently drifts from the treatment that was issued.
    const profile = await deriveEvaluationProfileByVersion(opts, recipe);
    // FR-P0-04 drift detection: when the session persisted the profile hash
    // at issuance, the re-derived profile must match it. A mismatch means
    // the derivation produced something other than the treatment the
    // session was actually shown — hard failure, never "close enough".
    if (session.profileHash) {
      const recomputed = await hashProfile(profile);
      if (recomputed !== session.profileHash) {
        return {
          ok: false,
          code: "PROFILE_HASH_MISMATCH",
          detail:
            `reconstructed profile hash differs from the hash persisted at ` +
            `issuance (expected ${session.profileHash.slice(0, 12)}…, got ${recomputed.slice(0, 12)}…) — ` +
            `the derivation no longer reproduces the issued treatment`,
        };
      }
    }
    return { ok: true, profile };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: detail.startsWith("INVALID_RECIPE")
        ? "INVALID_RECIPE"
        : detail.startsWith("UNSUPPORTED_PROFILE_VERSION")
          ? "UNSUPPORTED_PROFILE_VERSION"
          : "DERIVATION_FAILED",
      detail,
    };
  }
}

/**
 * Convenience wrapper: reconstruct from a session id, loading the key id
 * from D1. Used by routes that hold only the session id.
 *
 * FR-R7-018: this path is kept only for callers that already hold a
 * session id but not a `ReconstructableSession`. Routes that already call
 * `loadSession` MUST pass the loaded `profileKeyId` to
 * `reconstructIssuedProfile` directly — the duplicate SELECT was removed.
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
  const { loadSession } = await import("../cloudflare/session.js");
  const loaded = await loadSession(env.DB, sessionId);
  return reconstructIssuedProfile(
    env,
    {
      id: sessionId,
      profileVersion: opts?.profileVersion ?? loaded?.profileVersion ?? profileVersion(env),
      profileKeyId: loaded?.profileKeyId ?? null,
    },
    opts?.recipe,
    { holdoutMode: opts?.holdoutMode, turnstileRequired: opts?.turnstileRequired }
  );
}
