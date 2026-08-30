/**
 * Cookie utilities — separated from session core (FR-R3-084).
 */
export const SESSION_COOKIE = "__Host-fr_sid";
export const SESSION_TTL_MS = 30 * 60 * 1000;

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

export function now(): number {
  return Date.now();
}

export function isExpired(createdAt: number, ttl = SESSION_TTL_MS): boolean {
  return now() - createdAt > ttl;
}
