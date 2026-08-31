/**
 * Core token-comparison primitive — the ONE constant-time implementation
 * shared by the Worker canary route (routes/canary.ts), the host-neutral
 * middleware (host-adapter/middleware.ts), CSRF verification, the lab API
 * bearer check, admin auth, and envelope signature verification
 * (P1-AUDIT-2 P1-7: every private/leaky copy is gone — a security-sensitive
 * comparison must never exist twice; duplication is how the two-renderers
 * drift class starts). Length difference is folded into the accumulator so
 * timing does not leak token length or match position.
 */
export function constantTimeTokenEqual(token: string, expected: string): boolean {
  const len = Math.max(token.length, expected.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const x = i < token.length ? token.charCodeAt(i) : 0;
    const y = i < expected.length ? expected.charCodeAt(i) : 0;
    diff |= x ^ y;
  }
  diff |= token.length ^ expected.length;
  return diff === 0;
}

/**
 * P1-AUDIT-2 (P1-7): the SAME primitive under the name the bearer-auth and
 * bind-token call sites use. The prior per-module copies (session.ts,
 * routes/lab.ts, security/admin-auth.ts, session-envelope.ts) each drifted —
 * two of them early-returned on length mismatch, leaking token length.
 */
export const constantTimeEqualStr: (a: string, b: string) => boolean =
  constantTimeTokenEqual;
