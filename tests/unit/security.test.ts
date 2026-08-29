/**
 * Unit tests for security fixes.
 */
import { describe, it, expect } from "vitest";
import { verifyCsrfToken, deriveCsrfToken } from "../../src/core/session.js";
import { verifyAdminToken, verifyAdminSecret } from "../../src/security/admin-auth.js";
import { deriveProfile, hashProfile } from "../../src/core/profile.js";
import { looksLikeTestKey } from "../../src/turnstile/verify.js";
import type { Env } from "../../src/env.js";

const mockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    FIRERAID_PROFILE_SECRET: "a".repeat(64),
    FIRERAID_CSRF_SECRET: "b".repeat(64),
    ADMIN_SECRET: "test-admin-secret",
    ...overrides,
  }) as unknown as Env;

describe("security: timing-safe comparisons", () => {
  it("CSRF verify is constant-time (no early return on length)", async () => {
    const token = await deriveCsrfToken("secret", "sid", "purpose");
    // Same length, wrong content
    const wrongSameLength = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
    expect(await verifyCsrfToken("secret", "sid", "purpose", wrongSameLength)).toBe(false);
    // Different length
    expect(await verifyCsrfToken("secret", "sid", "purpose", token + "extra")).toBe(false);
    expect(await verifyCsrfToken("secret", "sid", "purpose", "short")).toBe(false);
    // Correct
    expect(await verifyCsrfToken("secret", "sid", "purpose", token)).toBe(true);
  });

  it("admin secret verify is constant-time", () => {
    const env = mockEnv({ ADMIN_SECRET: "correct-secret" });
    expect(verifyAdminSecret(env, "correct-secret")).toBe(true);
    expect(verifyAdminSecret(env, "wrong-secret")).toBe(false);
    expect(verifyAdminSecret(env, "")).toBe(false);
    expect(verifyAdminSecret(env, "correct-secret-extra")).toBe(false);
  });

  it("admin token verify rejects malformed tokens", async () => {
    const env = mockEnv({ ADMIN_SECRET: "test" });
    expect(await verifyAdminToken(env, "")).toBe(false);
    expect(await verifyAdminToken(env, "no-dot")).toBe(false);
    expect(await verifyAdminToken(env, "a.b.c")).toBe(false);
  });
});

describe("security: test key detection", () => {
  it("detects known test secrets", () => {
    expect(looksLikeTestKey("1x00000000000000000000000000000000AA")).toBe(true);
    expect(looksLikeTestKey("1x00000000000000000000000000000000BB")).toBe(true);
    expect(looksLikeTestKey("1x00000000000000000000000000000000CC")).toBe(true);
  });

  it("accepts non-test secrets", () => {
    expect(looksLikeTestKey("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(false);
  });
});

describe("correctness: semantic canary implies decoy-route", () => {
  it("profile with semantic family also has decoy-route", async () => {
    const env = mockEnv();
    // Test many sessions — some will get semantic
    let foundSemantic = false;
    for (let i = 0; i < 200; i++) {
      const p = await deriveProfile(env, `sid-${i}`);
      if (p.semantic) {
        foundSemantic = true;
        expect(p.families).toContain("decoy-route");
        expect(p.decoy).toBeDefined();
        expect(p.decoy!.endpointToken).toBeTruthy();
      }
    }
    expect(foundSemantic).toBe(true); // statistical certainty
  });

  it("hashProfile is deterministic", async () => {
    const env = mockEnv();
    const p = await deriveProfile(env, "sid");
    const h1 = await hashProfile(p);
    const h2 = await hashProfile(p);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});
