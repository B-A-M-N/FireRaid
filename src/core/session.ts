/**
 * Session system — cryptographically random IDs, secure cookies, expiration.
 *
 * FR-R6-092: this module is now PURE — no Cloudflare imports. D1-backed
 * session persistence moved to `src/cloudflare/session.ts` (D1SessionStore
 * plus the persistSession/loadSession/touchSession/markSessionSubmitted
 * delegates). Cookie/CSRF/ID helpers and the profile key ring stay here.
 *
 * FR-R5-029: Profile key-ring plumbing — persisted profile_key_id on sessions,
 * resolveProfileKey() to reconstruct the key ring from env vars.
 *
 *   Reconstruction contract (documented for the next agent pass):
 *   1. session.profile_key_id → ring lookup via resolveProfileKey(env)
 *      - known current key → derive profile with that key
 *      - known previous key → derive profile with that key
 *      - unknown id → hard error
 *   2. NULL id rows → fall back to current key (legacy rule)
 */
import { SESSION_COOKIE, SESSION_TTL_MS } from "../types/profile.js";
import { constantTimeTokenEqual, constantTimeEqualStr } from "./tokens.js";

// P1-AUDIT-2 (P1-7): re-exported so existing bearer-auth/bind-token importers
// keep working against the single shared implementation.
export { constantTimeEqualStr };

const enc = new TextEncoder();

// ─── Type exports ─────────────────────────────────────────────────────────

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
  return Date.now() - createdAt > ttl;
}

export function sessionCookieHeader(sessionId: string, maxAge = SESSION_TTL_MS / 1000): string {
  return `__Host-fr_sid=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function csrfCookieHeader(token: string, maxAge = SESSION_TTL_MS / 1000): string {
  return `__Host-fr_csrf=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

/**
 * Derive the CSRF token bound to a session: HMAC(secret, `${sessionId}:${purpose}`).
 * Keyed by the profile secret so a token is unforgeable without server state.
 */
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
  // P1-AUDIT-2 (P1-7): the ONE shared constant-time primitive.
  return constantTimeTokenEqual(token, expected);
}

/**
 * Constant-time string comparison. Returns true if equal.
 * Exported for reuse by bearer-auth and bind-token checks.
 */


/** Get the session ID from a request's cookie header. */
export function getSessionId(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("cookie"));
  return cookies.get(SESSION_COOKIE) ?? null;
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
 * FR-R7-002: fail-closed key-ring validation, called at Worker startup.
 * Catches malformed PREVIOUS JSON, duplicate IDs, current-vs-previous
 * conflicts, and secrets that fail the same minimum-length bar the
 * existing profile/CSRF secret checks enforce. Returns null when the ring
 * is OK, or a human-readable error string otherwise.
 *
 * The validator is strictly stricter than `resolveProfileKey` (which used
 * to silently discard malformed PREVIOUS JSON). New rows MUST end up with a
 * known, persisted key id; legacy rules for NULL-key rows still reconstruct
 * against the current key, but no NEW row should ever be created with a
 * NULL key id again (enforced by FR-R7-001 in persistSession / signup).
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MIN_KEY_SECRET_BYTES = 32;

export function validateProfileKeyRing(env: {
  FIRERAID_PROFILE_SECRET: string;
  FIRERAID_PROFILE_KEY_CURRENT_ID?: string;
  FIRERAID_PROFILE_KEY_PREVIOUS?: string;
}): string | null {
  // Current key id format
  const currentId = env.FIRERAID_PROFILE_KEY_CURRENT_ID ?? "default";
  if (!KEY_ID_PATTERN.test(currentId)) {
    return `FIRERAID_PROFILE_KEY_CURRENT_ID is malformed: "${currentId}"`;
  }
  // Current secret length (re-uses the same min bar as the existing startup check)
  if (new TextEncoder().encode(env.FIRERAID_PROFILE_SECRET).length < MIN_KEY_SECRET_BYTES) {
    return `FIRERAID_PROFILE_SECRET must be at least ${MIN_KEY_SECRET_BYTES} bytes`;
  }

  // PREVIOUS must be a JSON object of {id: secret}; not an array, not a scalar.
  if (env.FIRERAID_PROFILE_KEY_PREVIOUS !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.FIRERAID_PROFILE_KEY_PREVIOUS);
    } catch (err) {
      return `FIRERAID_PROFILE_KEY_PREVIOUS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "FIRERAID_PROFILE_KEY_PREVIOUS must be a JSON object of {id: secret}";
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      return "FIRERAID_PROFILE_KEY_PREVIOUS is empty (omit the variable or supply at least one entry)";
    }
    const seen = new Set<string>([currentId]);
    for (const [id, secret] of entries) {
      if (!KEY_ID_PATTERN.test(id)) {
        return `FIRERAID_PROFILE_KEY_PREVIOUS contains a malformed key id: "${id}"`;
      }
      if (typeof secret !== "string") {
        return `FIRERAID_PROFILE_KEY_PREVIOUS["${id}"] is not a string`;
      }
      if (new TextEncoder().encode(secret).length < MIN_KEY_SECRET_BYTES) {
        return `FIRERAID_PROFILE_KEY_PREVIOUS["${id}"] must be at least ${MIN_KEY_SECRET_BYTES} bytes`;
      }
      if (seen.has(id)) {
        return `FIRERAID_PROFILE_KEY_PREVIOUS contains a duplicate key id: "${id}"`;
      }
      seen.add(id);
    }
    // The current id must NOT also appear in previous: rotating a key moves
    // it FROM current TO previous; if both contain it, that key is
    // simultaneously active for two secrets, which corrupts every later
    // derivation (deterministic content of HMAC).
    if (Object.prototype.hasOwnProperty.call(parsed, currentId)) {
      return `FIRERAID_PROFILE_KEY_PREVIOUS must not contain the current key id ("${currentId}")`;
    }
  }

  return null;
}
