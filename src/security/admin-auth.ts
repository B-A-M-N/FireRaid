/**
 * Admin authentication — session-based, ADMIN_SECRET bound.
 * FIX: No fallback to "default" — fails closed.
 */
import { parseCookies } from "../core/session.js";
import type { Env } from "../env.js";

const ADMIN_COOKIE = "__Host-fr_admin";
const ADMIN_SESSION_TTL = 60 * 60 * 1000; // 1 hour

/** Constant-time string comparison. Returns true if equal. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getAdminSecret(env: Env): string | null {
  const secret = env.ADMIN_SECRET;
  if (!secret || secret.length < 8) return null;
  return secret;
}

export async function createAdminToken(env: Env): Promise<string> {
  const secret = getAdminSecret(env);
  if (!secret) throw new Error("ADMIN_SECRET not configured");

  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceStr = Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonceStr));
  const sigStr = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${nonceStr}.${sigStr}`;
}

export async function verifyAdminToken(env: Env, token: string): Promise<boolean> {
  const secret = getAdminSecret(env);
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [nonce, sig] = parts;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce));
  const expectedStr = Array.from(new Uint8Array(expected)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(sig, expectedStr);
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
