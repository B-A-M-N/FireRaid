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
  verifyEnvelopeOnly,
} from "../cloudflare/session-envelope.js";;
import { loadSession } from "../cloudflare/session.js";
import type { DefenseProfile } from "../types/profile.js";
import { deriveProductionProfileByVersion, hashProfileByVersion } from "../core/profile-versions.js";
import { reconstructIssuedProfile } from "../core/reconstruct.js";
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

  const rawCookieSid = getSessionId(req);
  if (!rawCookieSid) return error("no session", 403);

  // FR-P1-08: reconstruct the EXPECTED token and compare it BEFORE any D1
  // write — a wrong token (or forged/malformed envelope) must cause ZERO D1
  // mutations. Only a verified, token-matching request proceeds to materialize
  // the session row and persist the causal hit.
  //   - production: derive the exact issued profile from the VERIFIED envelope
  //     (HMAC — no D1). The envelope carries the secret key-id + version;
  //     derivation matches issuance byte-for-byte.
  //   - lab: the session row already exists (created at signup), so loading it
  //     is a READ; the bound recipe rides in from the D1 lab_runs read, exactly
  //     as submit.ts does, so the reconstructed token equals the RENDERED token.
  let profile: DefenseProfile;
  let derivedHash: string | null = null;
  if (!isLabMode(env)) {
    const envelope = await verifyEnvelopeOnly(env, rawCookieSid);
    if (!envelope.ok) return error("invalid session", 403);
    try {
      // FR-P0-04: production reconstruction goes through the VERSION
      // DISPATCH (the envelope's pv selects the frozen implementation) —
      // the same derivation materializeFromVerdict uses.
      profile = await deriveProductionProfileByVersion({
        secret: envelope.secret,
        version: envelope.pv,
        sessionId: envelope.sid,
      });
      // FR-P0-04: snapshot the derived hash so the post-materialize drift
      // check below detects any issuance/derivation divergence.
      derivedHash = await hashProfileByVersion(profile, envelope.pv);
    } catch (err) {
      console.error("canary production derivation failed:", err instanceof Error ? err.message : err);
      return error("profile reconstruction failed", 500);
    }
  } else {
    // Lab: read the EXISTING session row (no write) + the bound recipe.
    const existing = await loadSession(env.DB, rawCookieSid);
    if (!existing) return error("invalid session", 403);
    // P1-AUDIT-2: FAIL CLOSED on bound-assignment read/parse errors (shared
    // helper readLabAssignment, mirrors submit.ts). A bound session's token
    // derivation must never fall back to a random profile.
    const read = await readLabAssignment(env.DB, existing.id);
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
    // FR-POST-R6-P4 / R6-P5 / P0-17: recipe + holdout + turnstile condition
    // are part of the issued treatment identity.
    const reconstructed = await reconstructIssuedProfile(env, {
      id: existing.id,
      profileVersion: existing.profileVersion,
      profileKeyId: existing.profileKeyId ?? null,
      profileHash: existing.profileHash,
    }, read.assignment?.recipe ?? undefined, {
      holdoutMode: read.assignment?.holdoutMode,
      turnstileRequired: read.assignment?.turnstileRequired,
    });
    if (!reconstructed.ok) {
      console.error("canary reconstruction failed:", reconstructed.code, reconstructed.detail);
      return error("profile reconstruction failed", 500);
    }
    profile = reconstructed.profile;
    derivedHash = existing.profileHash ?? null;
  }

  // FR-R6-028: the route token lives ONLY in decoyRoute — a DECOY_FIELD_ONLY
  // session (no decoyRoute) must 404 here, not fall back to aggregate state.
  if (!profile.decoyRoute) return error("no decoy route for this session", 404);

  // Constant-time comparison (no early return on length mismatch) — a wrong
  // token returns here with ZERO D1 writes.
  const expected = profile.decoyRoute.endpointToken;
  if (!constantTimeTokenEqual(token, expected)) {
    return error("invalid token", 403);
  }

  // FR-P1-08: the request is valid — NOW materialize (production INSERT) or
  // load (lab READ) the session. The first D1 mutation on the request.
  const session = await ensureSessionRow(env, rawCookieSid);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);
  // FR-P1-19: canonical id — FK targets materialize under the envelope's
  // inner sid, never the envelope string.
  const sessionId = session.id;

  // FR-P0-04: drift detection — the derived hash must match the materialized
  // row's persisted hash. A mismatch (a deployment changed derivation for a
  // pinned version) is a hard operational failure, never a silent replay.
  if (derivedHash && session.profileHash && derivedHash !== session.profileHash) {
    console.error("canary profile-hash drift (failing closed):",
      `derived=${derivedHash.slice(0, 12)} stored=${session.profileHash.slice(0, 12)}`);
    return error("profile reconstruction failed", 500);
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
