/**
 * Admin authentication — session-based, ADMIN_SECRET bound.
 * FIX: No fallback to "default" — fails closed.
 * FIX: Tokens include iat/exp for cryptographic expiration (FR-R3-067).
 * FIX: HMAC covers nonce+iat+exp (FR-R4-007).
 * FIX: iat/exp fully validated incl. TTL bound (FR-R4-067).
 */
import { parseCookies } from "../core/session.js";
import type { Env } from "../env.js";

export const ADMIN_SESSION_TTL = 60 * 60 * 1000; // 1 hour
const ADMIN_COOKIE = "__Host-fr_admin";

/** Constant-time string comparison. Returns true if equal. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getAdminSecret(env: Env): string | null {
  const secret = env.ADMIN_SECRET;
  if (!secret || secret.length < 32) return null;
  return secret;
}

/**
 * Strict parse of a numeric string: must match /^[0-9]+$/ and be a safe integer.
 */
function parseStrictInt(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || !Number.isFinite(v)) return null;
  return v;
}

async function computeHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createAdminToken(env: Env): Promise<string> {
  const secret = getAdminSecret(env);
  if (!secret) throw new Error("ADMIN_SECRET not configured");

  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceStr = Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join("");

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(ADMIN_SESSION_TTL / 1000);

  // Canonical payload = nonce.iat.exp; signature covers the full payload
  const payload = `${nonceStr}.${iat}.${exp}`;
  const sig = await computeHmac(secret, payload);

  return `${payload}.${sig}`; // nonce.iat.exp.signature
}

export async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
  const secret = getAdminSecret(env);
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [nonceStr, iatStr, expStr, sig] = parts;

  // Strict numeric parsing of iat and exp
  const iat = parseStrictInt(iatStr);
  if (iat === null) return false;
  const exp = parseStrictInt(expStr);
  if (exp === null) return false;

  const now = Math.floor(Date.now() / 1000);

  // Timestamp validation (after signature verify — order: parse → sign check → timestamps)
  const payload = `${nonceStr}.${iat}.${exp}`;
  const expectedSig = await computeHmac(secret, payload);
  if (!constantTimeEqual(sig, expectedSig)) return false;

  // FR-R4-067: iat must be <= now + 60s (clock skew allowance)
  if (iat > now + 60) return false;
  // FR-R4-007: exp must be strictly in the future
  if (exp <= now) return false;
  // exp - iat must not exceed the session TTL in seconds
  if (exp - iat > ADMIN_SESSION_TTL / 1000) return false;

  return true;
}

export function adminCookieHeader(token: string): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL / 1000)}`,
  ].join("; ");
}

export function getAdminToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies.get(ADMIN_COOKIE) ?? null;
}

export async function requireAdmin(req: Request, env: Env): Promise<boolean> {
  // Check bearer token (for API) or cookie (for browser)
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return verifyAdminToken(env, auth.slice(7));
  }
  const token = getAdminToken(req);
  if (token) return verifyAdminToken(env, token);
  return false;
}

/** Constant-time secret comparison for login. */
export function verifyAdminSecret(env: Env, provided: string): boolean {
  const expected = getAdminSecret(env);
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}
