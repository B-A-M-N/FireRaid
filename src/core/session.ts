/**
 * Session system — cryptographically random IDs, secure cookies, expiration.
 */
import { SESSION_COOKIE, SESSION_TTL_MS, CSRF_COOKIE } from "../types/profile.js";

const enc = new TextEncoder();

/** Generate an opaque 128-bit session ID (URL-safe base64). */
export function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface SessionPayload {
  id: string;
  createdAt: number;
  profileVersion: number;
  submitted?: number;
  finalScore?: number | null;
  finalDisposition?: string | null;
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

export function getSessionId(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("cookie"));
  return cookies.get(SESSION_COOKIE) ?? null;
}

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

/** Persist a session row to D1. */
export async function persistSession(
  db: D1Database,
  session: SessionPayload,
  profileId: string,
  profileHash: string
): Promise<void> {
  // Plain INSERT — session IDs are 128-bit random, collisions should fail hard
  await db
    .prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      session.id,
      session.createdAt,
      now(),
      session.profileVersion,
      profileId,
      profileHash
    )
    .run();
}

export async function loadSession(
  db: D1Database,
  sessionId: string
): Promise<SessionPayload | null> {
  const row = await db
    .prepare(
      `SELECT id, created_at, profile_version, submitted, final_score, final_disposition FROM sessions WHERE id = ?`
    )
    .bind(sessionId)
    .first<{ id: string; created_at: number; profile_version: number; submitted: number; final_score: number | null; final_disposition: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    profileVersion: row.profile_version,
    submitted: row.submitted,
    finalScore: row.final_score,
    finalDisposition: row.final_disposition,
  };
}

export async function touchSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(now(), sessionId).run();
}

export async function markSessionSubmitted(
  db: D1Database,
  sessionId: string,
  score: number,
  disposition: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET submitted = 1, final_score = ?, final_disposition = ? WHERE id = ?`
    )
    .bind(score, disposition, sessionId)
    .run();
}
