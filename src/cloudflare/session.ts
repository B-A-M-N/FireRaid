/**
 * D1-backed session persistence (FR-R6-092).
 *
 * The pure session helpers (IDs, cookies, CSRF, key ring) live in
 * `core/session.ts`; this module is the Cloudflare adapter layer that owns
 * D1SessionStore and the per-operation delegates routes historically imported
 * from core. Route imports are re-pointed here; core no longer imports from
 * `cloudflare/`.
 *
 * FR-R5-030: D1SessionStore remains the single source of D1 SQL for session
 * CRUD.
 */
import {
  type SessionPayload,
} from "../core/session.js";
import { D1SessionStore } from "./session-store.js";

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a D1SessionStore bound to the given database.
 * Exported so tests and route code can share the same instance.
 */
export function createSessionStore(db: D1Database): D1SessionStore {
  return new D1SessionStore(db);
}

// ─── Delegates (kept for route compatibility, FR-R6-092) ─────────────────

/**
 * Persist a new session row (via D1SessionStore).
 *
 * FR-R7-001: profileKeyId is REQUIRED. A production session persisted
 * without a persisted key id would be reconstructed under the CURRENT key
 * after rotation, even when it was originally issued under a now-previous
 * key — silently mutating the defense profile that was issued to a real
 * user. The lab-bound path already supplied the key id directly; this
 * delegate now enforces it for every caller.
 */
export async function persistSession(
  db: D1Database,
  session: SessionPayload,
  profileId: string,
  profileHash: string,
  profileKeyId: string
): Promise<void> {
  if (typeof profileKeyId !== "string" || profileKeyId.length === 0) {
    throw new Error("FR-R7-001: persistSession requires a non-empty profileKeyId");
  }
  const store = new D1SessionStore(db);
  return store.create({
    id: session.id,
    createdAt: session.createdAt,
    profileVersion: session.profileVersion,
    profileId,
    profileHash,
    profileKeyId,
  });
}

/**
 * Load a session row, mapping the store's boolean `submitted` back to
 * SessionPayload's `submitted?: number`.
 *
 * FR-R7-018: returns the persisted profileKeyId alongside the payload so
 * the caller can call reconstructIssuedProfile directly without a second
 * SELECT.
 */
export interface LoadedSession extends SessionPayload {
  profileKeyId: string | null;
}

export async function loadSession(
  db: D1Database,
  sessionId: string
): Promise<LoadedSession | null> {
  const store = new D1SessionStore(db);
  const row = await store.load(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    profileVersion: row.profileVersion,
    submitted: row.submitted ? 1 : undefined,
    finalScore: row.finalScore,
    finalDisposition: row.finalDisposition,
    profileKeyId: row.profileKeyId,
  };
}

export async function touchSession(db: D1Database, sessionId: string): Promise<void> {
  const store = new D1SessionStore(db);
  return store.touch(sessionId);
}

export async function markSessionSubmitted(
  db: D1Database,
  sessionId: string,
  score: number,
  disposition: string
): Promise<void> {
  const store = new D1SessionStore(db);
  return store.markSubmitted(sessionId, score, disposition);
}
