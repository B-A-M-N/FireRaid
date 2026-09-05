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
// FR-P1-06: the admin CSRF cookie is separate from the session cookie and is
// NOT HttpOnly — the admin page JS must READ it to echo it back in the
// X-Fireraid-CSRF header (double-submit). `__Host-` prefix means a cross-site
// origin cannot set it, and SameSite=Strict means the browser won't send it
// on a cross-site request anyway. A cross-site attacker therefore cannot
// produce the matching header+cookie pair.
const ADMIN_CSRF_COOKIE = "__Host-fr_admin_csrf";
export const ADMIN_CSRF_HEADER = "X-Fireraid-CSRF";

// P1-AUDIT-2 (P1-7): the single shared constant-time primitive.
import { constantTimeTokenEqual as constantTimeEqual } from "../core/tokens.js";

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
    // FR-P1-06: the admin interface has no real cross-site flow (it is a
    // same-origin dashboard), so SameSite=Strict is safe and defence-in-depth
    // on top of the explicit origin+CSRF gate for cookie mutations. A strict
    // cookie is not sent on ANY cross-site request — not even top-level POST
    // navigations that would usually slip by Lax.
    "SameSite=Strict",
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL / 1000)}`,
  ].join("; ");
}

/** FR-P1-06: a random, unguessable CSRF value for double-submit. */
export function createAdminCsrfValue(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** FR-P1-06: the CSRF double-submit cookie — readable by page JS (no
 * HttpOnly) so the dashboard can echo it back in the header. */
export function adminCsrfCookieHeader(value: string): string {
  return [
    `${ADMIN_CSRF_COOKIE}=${value}`,
    "Path=/",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL / 1000)}`,
  ].join("; ");
}

/** FR-P1-06: read the CSRF cookie value, if present. */
export function getAdminCsrf(req: Request): string | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies.get(ADMIN_CSRF_COOKIE) ?? null;
}

/**
 * FR-P1-06: exact-origin check for cookie-authenticated mutations.
 *
 * A cross-site request from a browser carries an Origin equal to the
 * ATTACKER's origin, which cannot equal the request Host (the victim's
 * origin). Requiring Origin === Host therefore rejects cross-site POSTs. A
 * cookie-authenticated mutation with NO Origin header is also rejected — a
 * same-origin browser POST always sends Origin, so its absence on a cookie
 * call is anomalous and safest to refuse (Bearer API callers bypass this
 * entirely).
 */
function sameSiteOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = req.headers.get("host");
  if (!host) return false;
  return u.host === host;
}

/**
 * FR-P1-06: admin mutation gate — explicit auth contract.
 *
 *   Bearer API caller  → authorization token; NO CSRF requirement (the token
 *                        is the credential, and cross-origin thieves cannot
 *                        read it to forge the header).
 *   Browser cookie     → session cookie AND exact expected Origin AND admin
 *                        CSRF double-submit (header echoes the CSRF cookie).
 *
 * Returns "bearer" | "cookie" on success (callers may want to know which path
 * authenticated), or null when the request is not permitted to mutate.
 */
export async function requireAdminMutation(req: Request, env: Env): Promise<"bearer" | "cookie" | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    if (!(await verifyAdminToken(env, auth.slice(7)))) return null;
    return "bearer";
  }
  // Browser cookie caller.
  const token = getAdminToken(req);
  if (!token) return null;
  if (!(await verifyAdminToken(env, token))) return null;
  if (!sameSiteOrigin(req)) return null;
  // Double-submit: the header must exactly match the CSRF cookie. Without
  // this, a CSRF token stolen/propagated across tools (or a cookie that
  // leaked in a non-HttpOnly form) would pass the origin check alone.
  const csrf = getAdminCsrf(req);
  if (!csrf) return null;
  if (req.headers.get(ADMIN_CSRF_HEADER) !== csrf) return null;
  return "cookie";
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
