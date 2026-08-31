/**
 * Core token-comparison primitive — the ONE constant-time implementation
 * shared by the Worker canary route (routes/canary.ts) and the host-neutral
 * middleware (host-adapter/middleware.ts). A security-sensitive comparison
 * must never exist twice: duplication is how the two-renderers drift class
 * starts. Length difference is folded into the accumulator so timing does
 * not leak token length or match position.
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
