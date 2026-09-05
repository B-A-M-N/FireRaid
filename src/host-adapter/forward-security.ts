/**
 * FR-P1-10 — the upstream-forward security boundary.
 *
 * Two trust failures this module closes, both on the irreversible forward to
 * the upstream origin:
 *
 *   1. VALIDATE THE TARGET URL. `MiddlewareDeps.upstreamRegisterUrl` was
 *      forwarded verbatim with no shape check. A misconfigured (or reloaded,
 *      or attacker-influenced) URL could POST the registration — the client's
 *      form payload, which includes personal data — to an arbitrary host.
 *      validateUpstreamUrl() rejects anything but an absolute http(s) URL
 *      with no embedded credentials, so a forward can never silently leave
 *      the intended origin.
 *
 *   2. NEVER FORWARD Cookie-cARRYING SECURITY STATE BLINDLY. The middleware
 *      passed the ENTIRE request `cookie` header through to the upstream.
 *      That gave the origin FireRaid's own `__Host-fr_*` session/admin
 *      cookies (the envelope) plus every other cookie the client carries,
 *      regardless of whether the upstream has any right to them. The fix is
 *      an EXPLICIT ALLOWLIST (opt-in, default NONE) AND a hard exclusion of
 *      FireRaid's own cookie namespace regardless of the allowlist — so an
 *      operator who wants the upstream to see a host-session cookie must
 *      name it, and can never enable the FireRaid envelope leaking.
 *
 * Fail-closed on both axes:
 *   - an unvalidatable URL is a config/forward error, never a wildcard send;
 *   - a cookie not on the allowlist is dropped, never carried along with a
 *     best-effort approximation.
 */

/** Every FireRaid-issued cookie lives under this prefix. Never forwarded. */
export const FIRERAID_COOKIE_NAMESPACE = "__Host-fr_";

export type UpstreamUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validate an upstream registration URL for forwarding.
 *
 * Discriminated result so a caller can never mistake the normalized SUCCESS
 * URL (a string) for an error message (also a string). Fail-closed: an
 * invalid URL yields { ok:false, error }, never a degraded-but-usable value.
 */
export function validateUpstreamUrl(raw: string | undefined | null): UpstreamUrlValidation {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "upstreamRegisterUrl must be a non-empty absolute http(s) URL" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `upstreamRegisterUrl is not a valid absolute URL: "${raw}"` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `upstreamRegisterUrl must be http(s), got "${parsed.protocol}"` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "upstreamRegisterUrl must not embed credentials (userinfo) in the URL" };
  }
  if (parsed.hostname.length === 0) {
    return { ok: false, error: "upstreamRegisterUrl has no hostname" };
  }
  // No fragment — a POST target with a fragment is almost certainly a
  // misconfiguration, not an intentional submit endpoint.
  if (parsed.hash !== "") {
    return { ok: false, error: "upstreamRegisterUrl must not contain a fragment" };
  }
  // Normalize away default ports so compare/audit reads the canonical form.
  parsed.port = parsed.port === "443" && parsed.protocol === "https:" ? "" : parsed.port === "80" && parsed.protocol === "http:" ? "" : parsed.port;
  return { ok: true, url: parsed.toString() };
}

export interface ForwardCookieSpec {
  /** Lowercase cookie names the host explicitly allows reaching the upstream. */
  allowlist: readonly string[];
}

/**
 * Build the `cookie` header value to forward, from the client's raw header.
 *
 * ONLY cookies whose name is on the allowlist AND not in the FireRaid
 * namespace are forwarded. FireRaid's own cookies are excluded even if an
 * operator (mistakenly) names one — the envelope is defense-plane state and
 * the upstream origin's view of the applicant must never include it.
 *
 * @param rawHeader the client's raw `cookie` header (may be "" / null).
 * @returns the re-serialized allowlisted cookie string ("" when nothing is
 *          allowed or present).
 */
export function buildForwardCookieHeader(
  rawHeader: string | null | undefined,
  spec: ForwardCookieSpec
): string {
  if (!rawHeader) return "";
  const allow = new Set(spec.allowlist.map((n) => n.toLowerCase()));
  const allowed: string[] = [];
  for (const pair of rawHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue; // empty name is not a valid cookie
    const name = pair.slice(0, eq).trim().toLowerCase();
    // Hard namespace exclusion, before and independent of the allowlist.
    if (name.startsWith(FIRERAID_COOKIE_NAMESPACE.toLowerCase())) continue;
    if (!allow.has(name)) continue;
    allowed.push(`${name}=${pair.slice(eq + 1).trim()}`);
  }
  return allowed.join("; ");
}