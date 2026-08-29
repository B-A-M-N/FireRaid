/**
 * Integration tests — full signup → canary → submit flow against running worker.
 * FIX: Uses Cloudflare test Turnstile token that always passes.
 */
import { describe, it, expect } from "vitest";

const BASE = process.env.FIRERAID_BASE_URL || "http://localhost:8787";
// Cloudflare test token that always passes Turnstile
const TURNSTILE_TEST_TOKEN = "1x00000000000000000000AA";

async function fetchSignup(): Promise<{ cookie: string; html: string }> {
  const resp = await fetch(`${BASE}/signup`);
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("__Host-fr_"))
    .join("; ");
  const html = await resp.text();
  return { cookie, html };
}

function extractCsrf(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error("CSRF not found");
  return m[1];
}

function extractCanaryToken(html: string): string | null {
  const m = html.match(/\/c\/([a-f0-9]+)/);
  return m ? m[1] : null;
}

describe("integration: signup flow", () => {
  it("GET /health returns ok", async () => {
    const resp = await fetch(`${BASE}/health`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; version: string };
    expect(json.ok).toBe(true);
  });

  it("GET /signup sets secure cookies and renders form", async () => {
    const { cookie, html } = await fetchSignup();
    expect(cookie).toContain("__Host-fr_sid=");
    expect(cookie).toContain("__Host-fr_csrf=");
    expect(html).toContain('id="signup-form"');
    expect(html).toContain("RESEARCH / TEST ENVIRONMENT");
  });

  it("signup page includes security headers", async () => {
    const resp = await fetch(`${BASE}/signup`);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
    expect(resp.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("POST /api/submit rejects missing CSRF", async () => {
    const { cookie } = await fetchSignup();
    const resp = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ form: {} }),
    });
    expect(resp.status).toBe(403);
  });

  it("POST /api/submit accepts valid submission (no canary)", async () => {
    const { cookie, html } = await fetchSignup();
    const csrf = extractCsrf(html);
    // If this profile has a canary, skip (we test that separately)
    if (extractCanaryToken(html)) {
      return;
    }
    const resp = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        csrf,
        turnstileToken: TURNSTILE_TEST_TOKEN,
        form: { name: "Casey Example", email: "casey@example.invalid" },
      }),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { status: string; disposition: string };
    expect(json.status).toBe("received");
  });

  it("canary endpoint returns 204 for valid token, 403 for wrong token", async () => {
    const { cookie, html } = await fetchSignup();
    const token = extractCanaryToken(html);
    if (!token) return; // profile without canary

    const ok = await fetch(`${BASE}/c/${token}`, { headers: { cookie } });
    expect(ok.status).toBe(204);

    const bad = await fetch(`${BASE}/c/wrongtoken123`, { headers: { cookie } });
    expect(bad.status).toBe(403);
  });

  it("full canary hit => QUARANTINE on submit", async () => {
    // Try up to 20 sessions to find one with a canary
    for (let i = 0; i < 20; i++) {
      const { cookie, html } = await fetchSignup();
      const token = extractCanaryToken(html);
      if (!token) continue;

      const csrf = extractCsrf(html);

      // Hit the canary
      const canaryResp = await fetch(`${BASE}/c/${token}`, { headers: { cookie } });
      expect(canaryResp.status).toBe(204);

      // Submit with valid Turnstile token
      const submitResp = await fetch(`${BASE}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          csrf,
          turnstileToken: TURNSTILE_TEST_TOKEN,
          form: { name: "Casey Example", email: "casey@example.invalid" },
        }),
      });
      const json = (await submitResp.json()) as { disposition: string };
      expect(json.disposition).toBe("QUARANTINE");
      return;
    }
    // If no canary found in 20 tries, skip (unlikely with 2-4 families)
  });
});
