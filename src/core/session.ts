/**
 * Session system — cryptographically random IDs, secure cookies, expiration.
 *
 * FR-R5-030: D1 SQL bodies moved to D1SessionStore (cloudflare/session-store.ts).
 * This module re-exports/delegates to keep route imports compiling.
 *
 * FR-R5-029: Profile key-ring plumbing — persisted profile_key_id on sessions,
 * resolveProfileKey() to reconstruct the key ring from env vars, and
 * loadSessionKey(db, sessionId) to read a session's key id from D1.
 *
 *   Reconstruction contract (documented for the next agent pass):
 *   1. session.profile_key_id → ring lookup via resolveProfileKey(env)
 *      - known current key → derive profile with that key
 *      - known previous key → derive profile with that key
 *      - unknown id → hard error
 *   2. NULL id rows → fall back to current key (legacy rule)
 */
import { SESSION_COOKIE, SESSION_TTL_MS, CSRF_COOKIE } from "../types/profile.js";
import { D1SessionStore } from "../cloudflare/session-store.js";

const enc = new TextEncoder();

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a D1SessionStore bound to the given database.
 * Exported so tests and route code can share the same instance.
 */
export function createSessionStore(db: D1Database): D1SessionStore {
  return new D1SessionStore(db);
}

// ─── Type exports (kept for route compatibility) ──────────────────────────

export interface SessionPayload {
  id: string;
  createdAt: number;
  profileVersion: number;
  submitted?: number;
  finalScore?: number | null;
  finalDisposition?: string | null;
}

/**
 * FR-R5-029: Profile key ring for rotation support.
 * - current: the active key id + secret.
 * - previous: optional map of old key ids → their secrets (one slot).
 */
export type ProfileKeyRing = {
  current: { id: string; secret: string };
  previous?: Record<string, string>;
};

// ─── Helpers (pure) ───────────────────────────────────────────────────────

/** Generate an opaque 128-bit session ID (URL-safe base64). */
export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function now(): number {
  return Date.now();
}

export function isExpired(createdAt: number, ttl = SESSION_TTL_MS): boolean {
  return now() - createdAt > ttl;
}

export function sessionCookieHeader(sessionId: string, maxAge = SESSION_TTL_MS / 1000): string {
  return [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAge)}`,
  ].join("; ");
}

export function csrfCookieHeader(token: string, maxAge = SESSION_TTL_MS / 1000): string {
  return [
    `${CSRF_COOKIE}=${token}`,
    "Path=/",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAge)}`,
  ].join("; ");
}

export function parseCookies(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map.set(k, v);
  }
  return map;
}

// ─── CSRFs ────────────────────────────────────────────────────────────────

export async function deriveCsrfToken(
  secret: string,
  sessionId: string,
  purpose: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${sessionId}:${purpose}`)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
}

export async function verifyCsrfToken(
  secret: string,
  sessionId: string,
  purpose: string,
  token: string
): Promise<boolean> {
  const expected = await deriveCsrfToken(secret, sessionId, purpose);
  // Constant-time comparison (no early return on length mismatch)
  const len = Math.max(token.length, expected.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const a = i < token.length ? token.charCodeAt(i) : 0;
    const b = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  diff |= (token.length ^ expected.length);
  return diff === 0;
}

// ─── D1 delegation (FR-R5-030) ────────────────────────────────────────────

/**
 * Get the session ID from a request's cookie header.
 */
export function getSessionId(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("cookie"));
  return cookies.get(SESSION_COOKIE) ?? null;
}

/**
 * FR-R5-030: Delegate to D1SessionStore.
 * Returns SessionPayload-compatible shape (submitted as number|undefined).
 */
export async function persistSession(
  db: D1Database,
  session: SessionPayload,
  profileId: string,
  profileHash: string
): Promise<void> {
  const store = new D1SessionStore(db);
  return store.create({
    id: session.id,
    createdAt: session.createdAt,
    profileVersion: session.profileVersion,
    profileId,
    profileHash,
  });
}

/**
 * FR-R5-030: Delegate to D1SessionStore.
 * Maps store's boolean `submitted` to SessionPayload's `submitted?: number`.
 */
export async function loadSession(
  db: D1Database,
  sessionId: string
): Promise<SessionPayload | null> {
  const store = new D1SessionStore(db);
  const row = await store.load(sessionId);
  if (!row) return null;
  // Convert boolean -> SessionPayload shape: submitted = number | undefined
  return {
    id: row.id,
    createdAt: row.createdAt,
    profileVersion: row.profileVersion,
    submitted: row.submitted ? 1 : undefined,
    finalScore: row.finalScore,
    finalDisposition: row.finalDisposition,
  };
}

/**
 * FR-R5-030: Delegate to D1SessionStore.
 */
export async function touchSession(db: D1Database, sessionId: string): Promise<void> {
  const store = new D1SessionStore(db);
  return store.touch(sessionId);
}

/**
 * FR-R5-030: Delegate to D1SessionStore.
 */
export async function markSessionSubmitted(
  db: D1Database,
  sessionId: string,
  score: number,
  disposition: string
): Promise<void> {
  const store = new D1SessionStore(db);
  return store.markSubmitted(sessionId, score, disposition);
}

// ─── FR-R5-029: Profile key-ring plumbing ─────────────────────────────────

/**
 * Resolve the profile key ring from env vars.
 *
 * - FIRERAID_PROFILE_KEY_CURRENT_ID (optional): id string for the active key.
 * - FIRERAID_PROFILE_KEY_PREVIOUS (optional): JSON string {"<id>":"<secret>",...}.
 * - FIRERAID_PROFILE_SECRET: always used as the current key's secret.
 *
 * Defensive: invalid JSON for PREVIOUS → previous map omitted.
 */
export function resolveProfileKey(
  env: {
    FIRERAID_PROFILE_SECRET: string;
    FIRERAID_PROFILE_KEY_CURRENT_ID?: string;
    FIRERAID_PROFILE_KEY_PREVIOUS?: string;
  }
): ProfileKeyRing {
  const previous: Record<string, string> | undefined =
    env.FIRERAID_PROFILE_KEY_PREVIOUS !== undefined
      ? (() => {
          try {
            const parsed = JSON.parse(env.FIRERAID_PROFILE_KEY_PREVIOUS);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
            const result: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof k === "string" && typeof v === "string") result[k] = v;
            }
            return Object.keys(result).length > 0 ? result : undefined;
          } catch {
            // Invalid JSON → ignore previous
            return undefined;
          }
        })()
      : undefined;

  return {
    current: {
      id: env.FIRERAID_PROFILE_KEY_CURRENT_ID ?? "default",
      secret: env.FIRERAID_PROFILE_SECRET,
    },
    previous,
  };
}

/**
 * Load the profile_key_id for a session from D1.
 * Returns NULL if the session doesn't exist or has no key.
 */
export async function loadSessionKey(
  db: D1Database,
  sessionId: string
): Promise<string | null> {
  const store = new D1SessionStore(db);
  const row = await store.load(sessionId);
  return row?.profileKeyId ?? null;
}
