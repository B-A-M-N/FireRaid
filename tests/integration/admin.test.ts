/**
 * Integration tests — admin routes.
 */
import { describe, it, expect } from "vitest";

const BASE = process.env.FIRERAID_BASE_URL || "http://localhost:8787";
const ADMIN_SECRET = process.env.FIRERAID_ADMIN_SECRET || "local-admin-secret-do-not-use-in-prod";

async function login(): Promise<string> {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: ADMIN_SECRET }),
  });
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") || "";
  return setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
}

describe("integration: admin", () => {
  it("login rejects wrong secret", async () => {
    const resp = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "wrong" }),
    });
    expect(resp.status).toBe(403);
  });

  it("login succeeds with correct secret", async () => {
    const cookie = await login();
    expect(cookie).toContain("__Host-fr_admin=");
  });

  it("summary requires auth", async () => {
    const resp = await fetch(`${BASE}/api/admin/summary`);
    expect(resp.status).toBe(401);
  });

  it("summary returns counts", async () => {
    const cookie = await login();
    const resp = await fetch(`${BASE}/api/admin/summary`, { headers: { cookie } });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { sessions: number; submitted: number };
    expect(json.sessions).toBeGreaterThan(0);
  });

  it("sessions list returns array", async () => {
    const cookie = await login();
    const resp = await fetch(`${BASE}/api/admin/sessions?limit=5`, { headers: { cookie } });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { sessions: unknown[] };
    expect(Array.isArray(json.sessions)).toBe(true);
  });

  it("session detail returns evidence", async () => {
    const cookie = await login();
    // Get a session that was submitted
    const listResp = await fetch(`${BASE}/api/admin/sessions?limit=50`, { headers: { cookie } });
    const list = (await listResp.json()) as { sessions: Array<{ id: string; submitted: number }> };
    const submitted = list.sessions.find((s) => s.submitted);
    if (!submitted) return; // skip if none

    const resp = await fetch(`${BASE}/api/admin/sessions/${submitted.id}`, { headers: { cookie } });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { session: { id: string }; canaryHits: unknown[] };
    expect(json.session.id).toBe(submitted.id);
  });

  it("export returns CSV", async () => {
    const cookie = await login();
    const resp = await fetch(`${BASE}/api/admin/export?type=sessions`, { headers: { cookie } });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("id,created_at,profile_version");
  });

  it("logout clears cookie", async () => {
    const cookie = await login();
    const resp = await fetch(`${BASE}/api/admin/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(resp.status).toBe(200);
    const setCookie = resp.headers.get("set-cookie") || "";
    expect(setCookie).toContain("Max-Age=0");
  });
});
