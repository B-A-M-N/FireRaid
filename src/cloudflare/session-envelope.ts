/**
 * FR-P1-19: envelope → D1 session materialization (R7-024 first write).
 *
 * `ensureSessionRow` is the ONE function every stateful route calls instead
 * of a bare `loadSession` on the production path. It:
 *
 *   1. fast-path: SELECT the session row — present → return it (normal
 *      stateful behavior; the overwhelming case after the first write).
 *   2. envelope path: no row + envelope cookie → verify, derive the SAME
 *      profile issuance derived (deterministic from secret+sid+version+mode),
 *      and INSERT OR IGNORE the row. A concurrent first-writer inserted the
 *      identical row already → re-SELECT and return that.
 *
 * Fail-closed: any envelope problem returns null (routes already treat
 * null as 403) — the caller cannot distinguish "no session" from "forged
 * envelope", which is exactly what an attacker should see.
 *
 * The legacy fallback (audit item: "temporary legacy DB-session fallback")
 * is the bare-sid cookie shape: while the rollout window is open a bare sid
 * that EXISTS in D1 still loads (pre-deploy sessions survive), but a bare
 * sid with NO row is rejected — an attacker cannot fabricate session rows
 * by omitting the envelope, and signup no longer creates them to find.
 */
import type { Env } from "../env.js";
import { isLabMode } from "../env.js";
import { resolveProfileKey } from "../core/session.js";
import {
  verifySessionEnvelope,
  isEnvelopeCookie,
  type SessionEnvelope,
} from "../core/session-envelope.js";
import { deriveProfile, hashProfile } from "../core/profile.js";
import { loadSession, type LoadedSession } from "./session.js";

/**
 * Load-or-materialize the session for a stateful production request.
 *
 * @param cookieValue the raw __Host-fr_sid cookie value
 * @returns the session payload, or null when the request must 403.
 *          `materialized: true` marks the request that performed the
 *          INSERT (observability / tests).
 */
export async function ensureSessionRow(
  env: Env,
  cookieValue: string
): Promise<(LoadedSession & { materialized?: boolean }) | null> {
  // ── Fast path: row already exists (any cookie shape). ──────────────────
  const existing = await loadSession(env.DB, cookieValue);
  if (existing) return existing;

  // ── Legacy fallback: bare sid, no row → reject. ────────────────────────
  // (Pre-envelope sessions persist only through their 30-min TTL, which has
  // long elapsed by the time this ships; the branch exists so a mixed
  // fleet during rotation is not a hard cutover.)
  if (!isEnvelopeCookie(cookieValue)) return null;

  // ── Envelope path. Lab is ALWAYS stateful — envelopes are production-only. ─
  if (isLabMode(env)) return null;

  const ring = resolveProfileKey(env);
  const verdict = await verifySessionEnvelope(ring, cookieValue, Date.now());
  if (!verdict.ok) return null;

  const payload: SessionEnvelope = verdict.payload;

  // Re-derive exactly what issuance derived. Production mode, the
  // envelope's pv, and the envelope kid's secret — rotation-safe because
  // resolveProfileKey() selects by the same kid the derivation will use.
  let profileId: string;
  let profileHash: string;
  try {
    const secret = verdict.secret;
    const profile = await deriveProfile(
      { ...env, FIRERAID_PROFILE_SECRET: secret } as Env,
      payload.sid,
      payload.pv
    );
    profileId = profile.profileId;
    profileHash = await hashProfile(profile);
  } catch {
    return null;
  }

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(payload.sid, payload.iat, Date.now(), payload.pv, payload.kid, profileId, profileHash)
    .run();

  if ((inserted.meta?.changes ?? 0) === 1) {
    // We materialized it — return the canonical row.
    return { ...(await loadSession(env.DB, payload.sid))!, materialized: true };
  }

  // Lost a race: a concurrent first-writer inserted first. The row is
  // authoritative (and identical, by determinism) — load and return it.
  return loadSession(env.DB, payload.sid);
}
