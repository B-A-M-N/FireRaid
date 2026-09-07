/**
 * FR-P1-07 — production config gate requires the authoritative edge
 * rate-limiter for /api/admin/login.
 *
 * The in-isolate login map is a secondary, per-isolate guard. A real
 * production deployment must ALSO declare an authoritative edge limiter
 * (WAF rate-limit rule / Access / ratelimit binding) via
 * FIRERAID_RATE_LIMIT_LOGIN; the shared config gate refuses a production
 * deployment that has not declared it.
 *
 * The production-test env (TURNSTILE_MODE=disabled-test) is excluded from
 * this requirement so CI can run the production-SHAPE tier without real
 * edge infra — only a REAL production (non-disabled-test) deploy needs it.
 */
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/worker-common.js";
import type { Env } from "../../src/env.js";

/** A production-shaped env (LAB_MODE=false, real Turnstile credentials). */
function productionEnv(overrides: Partial<Env> = {}): Env {
  return ({
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    FIRERAID_PROFILE_SECRET: "a".repeat(64),
    FIRERAID_CSRF_SECRET: "b".repeat(64),
    TURNSTILE_SITE_KEY: "0xAAAAAA...",          // not a known test key
    TURNSTILE_SECRET_KEY: "0xBBBBBB...",        // not a known test secret
    TURNSTILE_EXPECTED_HOSTNAME: "admin.example.org",
    ...overrides,
  }) as unknown as Env;
}

describe("FR-P1-07: production requires an authoritative login limiter", () => {
  it("a real production env WITHOUT FIRERAID_RATE_LIMIT_LOGIN fails config", () => {
    const probe = productionEnv();
    const problem = validateConfig(probe);
    expect(problem).toMatch(/FIRERAID_RATE_LIMIT_LOGIN/);
  });

  it("the tracked placeholder value is rejected (a deploy must set the real name)", () => {
    const probe = productionEnv({ FIRERAID_RATE_LIMIT_LOGIN: "REPLACE_WITH_EDGE_LIMITER_NAME" });
    expect(validateConfig(probe)).toMatch(/FIRERAID_RATE_LIMIT_LOGIN/);
  });

  it("the explicit demo showcase override permits the tracked placeholder", () => {
    const probe = productionEnv({
      FIRERAID_RATE_LIMIT_LOGIN: "REPLACE_WITH_EDGE_LIMITER_NAME",
      FIRERAID_DEMO_MODE: "true",
    });
    expect(validateConfig(probe)).toBeNull();
  });

  it("a real production env WITH a declared limiter passes config", () => {
    const probe = productionEnv({ FIRERAID_RATE_LIMIT_LOGIN: "fireraid-admin-login-waf-rule" });
    expect(validateConfig(probe)).toBeNull();
  });

  it("the production-SHAPE test env (disabled-test) is NOT forced to declare a limiter", () => {
    // CI's production-test tier runs without real edge infra; it must not be
    // blocked here (the runtime guards still protect it).
    const probe = productionEnv({ TURNSTILE_MODE: "disabled-test", TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined });
    expect(validateConfig(probe)).toBeNull();
  });
});
