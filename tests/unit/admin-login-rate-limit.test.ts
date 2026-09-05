/**
 * FR-P1-07 — admin login rate limiting: the per-isolate map becomes bounded
 * and swept, and the deployment contract requires an authoritative edge
 * limiter.
 *
 * These tests pin the BEHAVIORAL rate-limit cap (a real brute-force sequence
 * goes 403 → 429 after MAX_LOGIN_ATTEMPTS on the same source IP) and the
 * bound/sweep budget constants. The intent is that an attacker rotating many
 * IPs cannot grow per-isolate memory without bound, and that a single
 * isolate is never the ONLY defense for /api/admin/login.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { adminLogin } from "../../src/routes/admin.js";
import {
  MAX_LOGIN_TRACKED_IPS,
  LOGIN_SWEEP_INTERVAL_MS,
} from "../../src/routes/admin.js";
import type { Env } from "../../src/env.js";

const ADMIN_SECRET = "s-secret".padEnd(32, "x");

function mockEnv(overrides: Partial<Env> = {}): Env {
  return ({
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    FIRERAID_PROFILE_SECRET: "a".repeat(64),
    FIRERAID_CSRF_SECRET: "b".repeat(64),
    ADMIN_SECRET,
    ...overrides,
  }) as unknown as Env;
}

/** POST /api/admin/login with the given secret from the given source IP. */
async function loginAttempt(env: Env, secret: string, ip: string): Promise<Response> {
  return adminLogin(
    new Request("http://admin.test/api/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({ secret }),
    }),
    env
  );
}

describe("FR-P1-07: admin login rate-limit cap (per-source-IP 403 → 429)", () => {
  let env: Env;

  beforeEach(() => {
    env = mockEnv();
  });

  it("wrong secret returns 403; the MAX_LOGIN_ATTEMPTS+1th fails 429", async () => {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await loginAttempt(env, "wrong-secret", ip)).status);
    }
    // 5 attempts are recorded as 403; the 6th is over the cap → 429.
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses[5]).toBe(429);
    expect(statuses[6]).toBe(429);
  });

  it("a correct secret on an over-cap IP is still refused (map is not reset by replying)", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < 6; i++) await loginAttempt(env, "wrong", ip);
    // Even a correct secret can't get in from that IP until the window lapses.
    const resp = await loginAttempt(env, ADMIN_SECRET, ip);
    expect(resp.status).toBe(429);
  });

  it("a different source IP is not affected by another IP's cap (correct secret succeeds)", async () => {
    const attackerIp = "203.0.113.77";
    for (let i = 0; i < 6; i++) await loginAttempt(env, "wrong", attackerIp);
    expect((await loginAttempt(env, "wrong", attackerIp)).status).toBe(429);
    // A clean IP logs in fine with the correct secret (produces 200 + cookies).
    const ok = await loginAttempt(env, ADMIN_SECRET, "198.51.100.1");
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-fr_admin=");
  });

  it("per-isolate map is BOUNDED: the tracked-IP cap is a fixed hashmap budget", () => {
    // The budget the map is allowed to grow to, per isolate. Bounding it is
    // what prevents a flood of distinct IPs from exhausting per-isolate
    // memory (the audit's FR-P1-07 concern).
    expect(MAX_LOGIN_TRACKED_IPS).toBeGreaterThan(0);
    expect(MAX_LOGIN_TRACKED_IPS).toBeLessThanOrEqual(50_000);
    // Sweep runs frequently enough to reclaim stale IPs without being a
    // per-request O(n) churn.
    expect(LOGIN_SWEEP_INTERVAL_MS).toBe(60_000);
  });
});