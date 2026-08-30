/**
 * Unit tests for Turnstile verification (FR-R3-053).
 * Tests pass, fail, duplicate, wrong action, wrong hostname, network failure.
 *
 * These tests mock fetch() to avoid calling Cloudflare in unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyTurnstile, looksLikeTestSiteKey, looksLikeTestSecret } from "../../src/turnstile/verify.js";

describe("FR-R3-053: Turnstile verification", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pass token with valid secret => success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        hostname: "localhost",
        action: "fireraid_signup",
      }),
    });

    const result = await verifyTurnstile({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      secret: "1x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
      expectedHostname: "localhost",
    });

    expect(result.ok).toBe(true);
    expect(result.hostname).toBe("localhost");
    expect(result.action).toBe("fireraid_signup");
  });

  it("fail token => failure with error-codes", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        "error-codes": ["invalid_input_response"],
      }),
    });

    const result = await verifyTurnstile({
      token: "invalid-token",
      secret: "2x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("invalid_input_response");
  });

  it("duplicate token => failure with timeout-or-duplicate", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        "error-codes": ["timeout-or-duplicate"],
      }),
    });

    const result = await verifyTurnstile({
      token: "duplicate-token",
      secret: "3x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("timeout-or-duplicate");
  });

  it("wrong action => failure with wrong_action", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        hostname: "localhost",
        action: "wrong-action",
      }),
    });

    const result = await verifyTurnstile({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      secret: "1x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
      expectedHostname: "localhost",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("wrong_action");
  });

  it("wrong hostname => failure with wrong_hostname", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        hostname: "evil.example.com",
        action: "fireraid_signup",
      }),
    });

    const result = await verifyTurnstile({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      secret: "1x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
      expectedHostname: "localhost",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("wrong_hostname");
  });

  it("network failure => failure with fetch_error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await verifyTurnstile({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      secret: "1x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("fetch_error");
  });

  it("malformed response (HTTP error) => failure with http status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await verifyTurnstile({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      secret: "1x0000000000000000000000000000000AA",
      expectedAction: "fireraid_signup",
    });

    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("http_500");
  });

  it("no runtime mock mode exists", () => {
    // Verify the function doesn't have a runtime test mode
    const source = verifyTurnstile.toString();
    expect(source).not.toContain("TURNSTILE_TEST_MODE");
    expect(source).not.toContain("mockVerify");
  });
});

describe("FR-R3-053: looksLikeTestSiteKey detects test sitekeys", () => {
  it("detects Cloudflare's documented test sitekeys", () => {
    expect(looksLikeTestSiteKey("1x00000000000000000000AA")).toBe(true);
    expect(looksLikeTestSiteKey("2x00000000000000000000AA")).toBe(true);
    expect(looksLikeTestSiteKey("3x00000000000000000000AA")).toBe(true);
  });

  it("detects legacy test sitekey format via regex", () => {
    expect(looksLikeTestSiteKey("1x0000000000000000000000AA")).toBe(true);
    expect(looksLikeTestSiteKey("2x0000000000000000000000AA")).toBe(true);
    expect(looksLikeTestSiteKey("3x0000000000000000000000AA")).toBe(true);
  });

  it("does not flag random sitekeys", () => {
    expect(looksLikeTestSiteKey("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(false);
    expect(looksLikeTestSiteKey("sk-proj-1234567890abcdef")).toBe(false);
  });
});

describe("FR-R3-053: looksLikeTestSecret detects test secrets", () => {
  it("detects Cloudflare's documented test secrets", () => {
    expect(looksLikeTestSecret("1x0000000000000000000000000000000AA")).toBe(true);
    expect(looksLikeTestSecret("2x0000000000000000000000000000000AA")).toBe(true);
    expect(looksLikeTestSecret("3x0000000000000000000000000000000AA")).toBe(true);
  });

  it("does not flag sitekey-format strings as secrets (namespace separation)", () => {
    expect(looksLikeTestSecret("1x00000000000000000000AA")).toBe(false);
    expect(looksLikeTestSecret("2x00000000000000000000AA")).toBe(false);
    expect(looksLikeTestSecret("3x00000000000000000000AA")).toBe(false);
  });

  it("does not flag long secret-format strings as sitekeys (namespace separation)", () => {
    expect(looksLikeTestSiteKey("1x0000000000000000000000000000000AA")).toBe(false);
    expect(looksLikeTestSiteKey("2x0000000000000000000000000000000AA")).toBe(false);
    expect(looksLikeTestSiteKey("3x0000000000000000000000000000000AA")).toBe(false);
  });

  it("does not flag random secrets", () => {
    expect(looksLikeTestSecret("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")).toBe(false);
    expect(looksLikeTestSecret("sk-proj-1234567890abcdef")).toBe(false);
  });
});
