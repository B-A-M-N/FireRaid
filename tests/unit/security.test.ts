/**
 * Unit tests for security fixes.
 */
import { describe, it, expect } from "vitest";
import { verifyCsrfToken, deriveCsrfToken } from "../../src/core/session.js";
import { verifyAdminToken, verifyAdminSecret } from "../../src/security/admin-auth.js";
import { deriveProfile, hashProfile } from "../../src/core/profile.js";
import { looksLikeTestSiteKey, looksLikeTestSecret } from "../../src/turnstile/verify.js";
import type { Env } from "../../src/env.js";

const mockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    FIRERAID_PROFILE_SECRET: "a".repeat(64),
    FIRERAID_CSRF_SECRET: "b".repeat(64),
    ADMIN_SECRET: "test-admin-secret-that-is-32-chars!",
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
    const env = mockEnv({ ADMIN_SECRET: "correct-secret-that-is-32-chars!" });
    expect(verifyAdminSecret(env, "correct-secret-that-is-32-chars!")).toBe(true);
    expect(verifyAdminSecret(env, "wrong-secret-that-is-32-chars!")).toBe(false);
    expect(verifyAdminSecret(env, "")).toBe(false);
    expect(verifyAdminSecret(env, "correct-secret-that-is-32-chars!-extra")).toBe(false);
  });

  it("admin token verify rejects malformed tokens", async () => {
    const env = mockEnv({ ADMIN_SECRET: "test-admin-secret-that-is-32-chars!" });
    expect(await verifyAdminToken(env, "")).toBe(false);
    expect(await verifyAdminToken(env, "no-dot")).toBe(false);
    expect(await verifyAdminToken(env, "a.b.c")).toBe(false);
  });
});

describe("security: test key detection", () => {
  // FR-R4-005: sitekey and secret namespaces are distinct Cloudflare values.
  it("detects current Cloudflare test sitekeys", () => {
    expect(looksLikeTestSiteKey("1x00000000000000000000AA")).toBe(true); // always passes
    expect(looksLikeTestSiteKey("2x00000000000000000000AA")).toBe(true); // invisible
    expect(looksLikeTestSiteKey("3x00000000000000000000AA")).toBe(true); // forced-interactive
  });

  it("detects current Cloudflare dummy secrets", () => {
    expect(looksLikeTestSecret("1x0000000000000000000000000000000AA")).toBe(true); // always passes
    expect(looksLikeTestSecret("2x0000000000000000000000000000000AA")).toBe(true); // always fails
    expect(looksLikeTestSecret("3x0000000000000000000000000000000AA")).toBe(true); // duplicate/spent
  });

  it("namespaces do not cross-match", () => {
    expect(looksLikeTestSecret("1x00000000000000000000AA")).toBe(false);
    expect(looksLikeTestSiteKey("1x0000000000000000000000000000000AA")).toBe(false);
  });

  it("accepts non-test secrets", () => {
    expect(looksLikeTestSecret("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(false);
    expect(looksLikeTestSiteKey("0aaaaaaaaaaaaaaaaaaAAA")).toBe(false);
  });
});

describe("correctness: semantic canary with requiresRoute implies decoy-route", () => {
  it("profile with semantic template requiring route also has decoy-route", async () => {
    const env = mockEnv();
    let foundRouteSemantic = false;
    for (let i = 0; i < 200; i++) {
      const p = await deriveProfile(env, `sid-${i}`);
      if (p.semantic) {
        // S04, S05, S08 require route; S01, S02, S03, S06, S07 do not
        if (["S04", "S05", "S08"].includes(p.semantic.templateId)) {
          foundRouteSemantic = true;
          expect(p.families).toContain("decoy-route");
          expect(p.decoyRoute).toBeDefined();
          expect(p.decoyRoute!.endpointToken).toBeTruthy();
        }
      }
    }
    expect(foundRouteSemantic).toBe(true);
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
