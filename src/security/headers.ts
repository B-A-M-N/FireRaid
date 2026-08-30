/**
 * Security headers — applied to all Worker responses.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self' https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; " +
    "connect-src 'self' https://challenges.cloudflare.com; " +
    // FR-R6-046: all styles ship via /signup.css + admin.css — no inline
    // style injection, so 'unsafe-inline' is gone.
    "style-src 'self'; " +
    "img-src 'self' data:; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cache-Control": "no-store",
};

export function withSecurityHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export function json(data: unknown, status = 200): Response {
  const resp = Response.json(data, { status });
  return withSecurityHeaders(resp);
}

export function html(content: string, status = 200): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  return withSecurityHeaders(new Response(content, { status, headers }));
}

export function noContent(): Response {
  return withSecurityHeaders(new Response(null, { status: 204 }));
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}
