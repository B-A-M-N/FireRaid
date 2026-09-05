/**
 * Keyed CSRF token mint/verify (extracted from middleware.ts).
 */
/**
 * P1-AUDIT-2: KEYED CSRF token. The prior `makeCsrf(sessionId)` was an unkeyed
 * SHA-256 of the PUBLIC sid — anyone who saw the cookie could forge the token.
 * Now it's HMAC-SHA-256 keyed with the deployment secret, so the token is
 * unforgeable without the secret and is bound to the session.
 */
export async function makeCsrf(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`csrf:${sessionId}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a keyed CSRF token against a session (constant-time compare). */
export async function verifyCsrf(
  secret: string,
  sessionId: string,
  token: string
): Promise<boolean> {
  const expected = await makeCsrf(secret, sessionId);
  // Constant-time compare with length folded in (no early return — mirrors
  // constantTimeTokenEqual; an early length-check would leak token length).
  const len = Math.max(expected.length, token.length);
  let diff = expected.length ^ token.length;
  for (let i = 0; i < len; i++) {
    const x = i < expected.length ? expected.charCodeAt(i) : 0;
    const y = i < token.length ? token.charCodeAt(i) : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}
