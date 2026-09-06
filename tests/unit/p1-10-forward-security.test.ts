/**
 * FR-P1-10 — the upstream-forward security boundary.
 *
 * Two trust failures closed:
 *   1. upstreamRegisterUrl was forwarded verbatim, so a bad URL could POST
 *      the applicant's personal data to an arbitrary host. validateUpstreamUrl
 *      accepts ONLY an absolute http(s) URL with no embedded credentials.
 *   2. the client's ENTIRE cookie header was forwarded, handing the origin
 *      FireRaid's own `__Host-fr_*` cookies plus every other cookie the client
 *      carried. buildForwardCookieHeader forwards ONLY an explicit allowlist,
 *      and hard-excludes the `__Host-fr_*` namespace regardless of the list.
 */
import { describe, it, expect } from "vitest";
import {
  validateUpstreamUrl,
  buildForwardCookieHeader,
  FIRERAID_COOKIE_NAMESPACE,
} from "../../src/host-adapter/forward-security.js";

describe("FR-P1-10: validateUpstreamUrl", () => {
  it("accepts an absolute http URL", () => {
    const r = validateUpstreamUrl("http://localhost:5051/api/register");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toMatch(/^http:\/\/localhost:5051\/api\/register$/);
  });

  it("accepts an absolute https URL and normalizes default ports", () => {
    const r1 = validateUpstreamUrl("https://accounts.example.org/api/register");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.url).toBe("https://accounts.example.org/api/register");
    const r2 = validateUpstreamUrl("https://accounts.example.org:443/api/register");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.url).toBe("https://accounts.example.org/api/register");
  });

  it("rejects empty / missing / garbage", () => {
    expect(validateUpstreamUrl("")).toEqual({ ok: false, error: expect.stringMatching(/non-empty/) });
    expect(validateUpstreamUrl(undefined)).toEqual({ ok: false, error: expect.stringMatching(/non-empty/) });
    expect(validateUpstreamUrl(null)).toEqual({ ok: false, error: expect.stringMatching(/non-empty/) });
    expect(validateUpstreamUrl("not a url")).toEqual({ ok: false, error: expect.stringMatching(/not a valid absolute URL/) });
  });

  it("rejects non-http(s) protocols and embedded credentials", () => {
    expect(validateUpstreamUrl("ftp://example.org/x")).toEqual({ ok: false, error: expect.stringMatching(/http\(s\)/) });
    expect(validateUpstreamUrl("file:///tmp/x")).toEqual({ ok: false, error: expect.stringMatching(/http\(s\)/) });
    expect(validateUpstreamUrl("https://user:pass@example.org/register")).toEqual({ ok: false, error: expect.stringMatching(/must not embed credentials/) });
  });

  it("rejects fragment-bearing submit targets", () => {
    expect(validateUpstreamUrl("https://example.org/register#admin")).toEqual({ ok: false, error: expect.stringMatching(/must not contain a fragment/) });
  });

  it("accepts https for any host and http ONLY for loopback", () => {
    expect(validateUpstreamUrl("https://upstream.example.org/register").ok).toBe(true);
    for (const loopback of ["http://127.0.0.1:5051/api/register", "http://localhost:5051/api/register", "http://[::1]:5051/api/register"]) {
      expect(validateUpstreamUrl(loopback).ok).toBe(true);
    }
  });

  it("rejects plaintext http to any non-loopback host (the forward carries personal data)", () => {
    for (const raw of [
      "http://upstream.example.org/register",
      "http://10.0.0.5/register",
      "http://internal.svc.cluster.local/register",
      "http://localhost.evil.example.org/register", // suffix games are not loopback
    ]) {
      const r = validateUpstreamUrl(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must use https/);
    }
  });
});

describe("FR-P1-10: buildForwardCookieHeader", () => {
  const spec = { allowlist: ["host_session"] };

  it("default (empty allowlist) forwards NOTHING", () => {
    const raw = "host_session=abc123; __Host-fr_sid=fr1.xyz.zzz; theme=dark";
    expect(buildForwardCookieHeader(raw, { allowlist: [] })).toBe("");
  });

  it("forwards only allowlisted names, dropping everything else", () => {
    const raw = "host_session=abc123; theme=dark; other=zzz";
    const out = buildForwardCookieHeader(raw, spec);
    expect(out).toBe("host_session=abc123");
  });

  it("never forwards FireRaid cookies even when allowlisted (defense namespace)", () => {
    const raw = `${FIRERAID_COOKIE_NAMESPACE}sid=fr1.xyz.zzz; host_session=abc`;
    // An operator mistakenly allowlists the FireRaid session cookie too.
    const out = buildForwardCookieHeader(raw, { allowlist: ["host_session", "__Host-fr_sid"] });
    expect(out).not.toContain("fr1.xyz.zzz");
    expect(out).toContain("host_session=abc");
  });

  it("matches case-insensitively, trims whitespace, and preserves the ORIGINAL name spelling on forward", () => {
    const raw = " Host_Session=abc ; theme=dark ";
    // Allowlist matching is case-insensitive; the forwarded name keeps the
    // client's spelling (an upstream may treat cookie names case-sensitively).
    expect(buildForwardCookieHeader(raw, spec)).toBe("Host_Session=abc");
  });

  it("returns '' for absent/empty headers", () => {
    expect(buildForwardCookieHeader(null, spec)).toBe("");
    expect(buildForwardCookieHeader(undefined, spec)).toBe("");
    expect(buildForwardCookieHeader("", spec)).toBe("");
  });
});