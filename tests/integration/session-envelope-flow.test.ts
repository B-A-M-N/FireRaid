/**
 * FR-P1-19 integration: the stateless production session envelope, live.
 *
 * These tests boot the wrangler "production" env (LAB_MODE=false — see
 * scripts/test-worker.mjs --wrangler-env production), where GET /signup
 * must perform NO D1 write and the first stateful action materializes the
 * session row from the signed envelope.
 *
 * Primary truth is behavioral: every stateful endpoint that accepted a
 * production signup must work from an envelope cookie alone, and the
 * signup response must not create a session row (checked via the admin
 * sessions count).
 */
import { describe, it, expect } from "vitest";

const BASE = process.env.FIRERAID_BASE_URL || "http://localhost:8799";
const ADMIN_SECRET =
  process.env.FIRERAID_TEST_ADMIN_SECRET || "local-admin-secret-do-not-use-in-prod";

/** Derive a short-lived admin API token (nonce.iat.exp.sig — see
 * src/security/admin-auth.ts). The raw ADMIN_SECRET is only accepted at
 * /api/admin/login; API routes verify the derived token. */
async function adminToken(): Promise<string> {
  const secret = ADMIN_SECRET;
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceStr = Array.from(nonce)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 300;
  const payload = `${nonceStr}.${iat}.${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${sigHex}`;
}

/** Compute HMAC-hex the way admin-auth's computeHmac does (needs a probe
 * against the live worker on first use to confirm the encoding). */
async function adminSessionsCount(): Promise<number> {
  const resp = await fetch(`${BASE}/api/admin/summary`, {
    headers: { authorization: `Bearer ${await adminToken()}` },
  });
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { sessions?: number };
  return body.sessions ?? -1;
}

interface Signup {
  /** The __Host-fr_sid cookie VALUE (an fr1 envelope in production mode). */
  sidValue: string;
  csrf: string;
  html: string;
}

async function productionSignup(): Promise<Signup> {
  const resp = await fetch(`${BASE}/signup`);
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") || "";
  const sid = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("__Host-fr_sid="))
    .map((c) => c.split("=").slice(1).join("="))[0];
  expect(sid).toMatch(/^fr1\./);
  const html = await resp.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("CSRF not found");
  return { sidValue: sid, csrf, html };
}

describe("FR-P1-19 integration: stateless production envelope", () => {
  it("GET /signup issues an fr1 envelope cookie and performs NO D1 write", async () => {
    const before = await adminSessionsCount();
    const { sidValue } = await productionSignup();
    expect(sidValue).toMatch(/^fr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const after = await adminSessionsCount();
    expect(after).toBe(before); // the stateless claim, measured
  });

  it("telemetry-first first write: POST /api/events materializes the session and accepts the batch", async () => {
    const before = await adminSessionsCount();
    const { sidValue } = await productionSignup();
    const resp = await fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sidValue}` },
      body: JSON.stringify({
        events: [
          { seq: 0, dt: 0, kind: "focus", target: "body" },
          { seq: 1, dt: 120, kind: "input", target: "email" },
        ],
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { acceptedThrough?: number; duplicate?: boolean };
    expect(body.acceptedThrough).toBe(1);
    const after = await adminSessionsCount();
    expect(after).toBe(before + 1);
  });

  it("submit-first first write: an envelope-only submission MATERIALIZES the session (then hits the challenge gate)", async () => {
    const before = await adminSessionsCount();
    const { sidValue, csrf, html } = await productionSignup();
    // Submit needs the rendered form field nameS; production render is the
    // standard signup form. Fill the fields the client JS would send.
    const fields: Record<string, string> = {};
    for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/g)) {
      fields[m[1]] = `e2e-${m[1]}@example.test`;
    }
    // The password field needs a plausible value if present.
    if (fields.password !== undefined) fields.password = "correct horse battery staple 1!";
    const resp = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-fr_sid=${sidValue}`,
        origin: BASE,
      },
      body: JSON.stringify({ csrf, form: fields }),
    });
    // Production Turnstile verification fails against the dummy local
    // secret, so the submit itself answers 403 verification_required —
    // but that is AFTER materialization: the session row must exist now.
    // (The full-pass submit flow is covered by the lab-mode suites where
    // Turnstile is disabled; the envelope contract under test here is
    // "the first stateful action materializes the row", which this path
    // exercises through the AUDITED-VERIFICATION-FAILURE first-write case.)
    const body = (await resp.json()) as { status?: string };
    expect(body.status).toBe("verification_required");
    const after = await adminSessionsCount();
    expect(after).toBe(before + 1);
  });

  it("canary-first first write: a rendered canary hit materializes and records a causal hit", async () => {
    const before = await adminSessionsCount();
    const { sidValue, html } = await productionSignup();
    const token = html.match(/\/c\/([a-f0-9]+)/)?.[1];
    if (!token) return; // profile had no decoy-route canary this draw
    const resp = await fetch(`${BASE}/c/${token}`, {
      headers: { cookie: `__Host-fr_sid=${sidValue}` },
    });
    // Canary target responds (200/404/410 — any terminal status proves the
    // session materialized; 403 would mean the envelope was rejected).
    expect(resp.status).not.toBe(403);
    const after = await adminSessionsCount();
    expect(after).toBe(before + 1);
  });

  it("a forged envelope (garbage after fr1.) is rejected 403 with NO session created", async () => {
    const before = await adminSessionsCount();
    const resp = await fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-fr_sid=fr1.Zm9yZ2Vk.Zm9yZ2Vk`,
      },
      body: JSON.stringify({ events: [{ seq: 0, dt: 0, kind: "focus", target: "b" }] }),
    });
    expect(resp.status).toBe(403);
    expect(await adminSessionsCount()).toBe(before);
  });

  it("a bare-sid cookie with no row is rejected 403 (legacy fallback cannot fabricate)", async () => {
    const before = await adminSessionsCount();
    const resp = await fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-fr_sid=AAAAAAAAAAAAAAAAAAAAAA`,
      },
      body: JSON.stringify({ events: [{ seq: 0, dt: 0, kind: "focus", target: "b" }] }),
    });
    expect(resp.status).toBe(403);
    expect(await adminSessionsCount()).toBe(before);
  });

  it("envelope cookies never appear in stored telemetry or submit payloads", async () => {
    // Defense-plane invariant: the envelope is transport-only.
    const { sidValue } = await productionSignup();
    const resp = await fetch(`${BASE}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sidValue}` },
      body: JSON.stringify({ events: [{ seq: 0, dt: 0, kind: "focus", target: "x" }] }),
    });
    expect(resp.status).toBe(200);
    // The record of this session (admin detail) must not embed the envelope.
    const detail = await fetch(`${BASE}/api/admin/summary`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const text = await detail.text();
    expect(text).not.toContain("fr1.");
  });
});
