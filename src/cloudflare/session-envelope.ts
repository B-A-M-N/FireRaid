/**
 * FR-P1-19: envelope → D1 session materialization (R7-024 first write).
 *
 * `ensureSessionRow` is the ONE function every stateful route calls instead
 * of a bare `loadSession` on the production path. It:
 *
 *   1. envelope path (P1-AUDIT-2 Phase E reorder): VERIFY the envelope
 *      first (HMAC — no D1), then SELECT the session row by the VERIFIED
 *      bare sid — present → return it (the overwhelming case after the
 *      first write; ONE D1 read, the fast path always used to miss).
 *   2. materialization: verified envelope + no row → derive the SAME
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
  // ── Fast path: envelope VERIFY FIRST, then SELECT by the bare sid. ─────
  // P1-AUDIT-2 Phase E: the prior fast path ran loadSession(cookieValue) —
  // keyed on the ENVELOPE STRING, while materialized rows are keyed by the
  // bare sid — so it missed on EVERY stateful request and every one paid
  // verify + re-derive + INSERT OR IGNORE + re-SELECT (≈5 ops where 1
  // suffices; the budget harness's normal-signup read counts showed it).
  // The fixed order verifies the envelope FIRST (HMAC — CPU-cheap, no D1)
  // and then SELECTs by the VERIFIED payload sid. That order is not an
  // optimization detail: looking a row up by an UNVERIFIED sid would let an
  // attacker name a victim's sid in a forged envelope and have the fast
  // path load the VICTIM's session row (session confusion). Verify gates
  // the lookup; the lookup cannot be reached with an unauthenticated id.
  if (isEnvelopeCookie(cookieValue)) {
    // Envelope path. Lab is ALWAYS stateful — envelopes are production-only.
    if (!isLabMode(env)) {
      const ring = resolveProfileKey(env);
      const verdict = await verifySessionEnvelope(ring, cookieValue, Date.now());
      if (verdict.ok) {
        const existing = await loadSession(env.DB, verdict.payload.sid);
        if (existing) return existing;
        // No row yet: fall through to materialization with the verdict in
        // hand (the verify work is not repeated below).
        return materializeFromVerdict(env, verdict);
      }
      // Malformed/tampered/expired envelope → fail closed. (An envelope-
      // shaped cookie never reaches the legacy branch: a forged envelope
      // must not degrade into a bare-sid lookup.)
      return null;
    }
    // Lab never issued envelopes; an envelope-shaped cookie in lab is junk.
    return null;
  }

  // ── Legacy fallback: bare sid, no row → reject. ────────────────────────
  // (Pre-envelope sessions persist only through their 30-min TTL, which has
  // long elapsed by the time this ships; the branch exists so a mixed
  // fleet during rotation is not a hard cutover.)
  const existing = await loadSession(env.DB, cookieValue);
  if (existing) return existing;
  return null;
}

/**
 * Insert the session row for a VERIFIED envelope and return the canonical
 * row. Derivation mirrors issuance exactly (production mode, the envelope's
 * pv, the envelope kid's secret — rotation-safe because resolveProfileKey()
 * selects by the same kid the derivation uses). INSERT OR IGNORE + re-SELECT
 * makes concurrent first-writers order-independent (deterministic columns).
 */
async function materializeFromVerdict(
  env: Env,
  verdict: Extract<Awaited<ReturnType<typeof verifySessionEnvelope>>, { ok: true }>
): Promise<(LoadedSession & { materialized?: boolean }) | null> {
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
