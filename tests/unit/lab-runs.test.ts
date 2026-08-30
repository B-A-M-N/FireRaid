/**
 * Unit tests for lab-run auth helpers (hashBindToken, constantTimeEqualStr, requireLabAuth).
 * No D1 — pure function tests.
 */
import { describe, it, expect } from "vitest";
import {
  hashBindToken,
  constantTimeEqualStr,
  requireLabAuth,
} from "../../src/routes/lab.js";
import type { Env } from "../../src/env.js";

describe("lab: hashBindToken", () => {
  it("deterministic for same input", async () => {
    const a = await hashBindToken("test-token-123");
    const b = await hashBindToken("test-token-123");
    expect(a).toBe(b);
  });

  it("produces exactly 64 hex characters (SHA-256)", async () => {
    const hash = await hashBindToken("anything");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", async () => {
    const a = await hashBindToken("token-a");
    const b = await hashBindToken("token-b");
    expect(a).not.toBe(b);
  });
});

describe("lab: constantTimeEqualStr", () => {
  it("true for identical strings", () => {
    expect(constantTimeEqualStr("abc", "abc")).toBe(true);
  });

  it("true for empty strings", () => {
    expect(constantTimeEqualStr("", "")).toBe(true);
  });

  it("false for same length, different content", () => {
    expect(constantTimeEqualStr("abc", "abd")).toBe(false);
  });

  it("false for different length", () => {
    expect(constantTimeEqualStr("abc", "ab")).toBe(false);
    expect(constantTimeEqualStr("abc", "abcd")).toBe(false);
  });

  it("false for one empty, one non-empty", () => {
    expect(constantTimeEqualStr("", "a")).toBe(false);
    expect(constantTimeEqualStr("a", "")).toBe(false);
  });

  it("true for long matching strings", () => {
    const s = "a".repeat(1000);
    expect(constantTimeEqualStr(s, s)).toBe(true);
  });
});

describe("lab: requireLabAuth", () => {
  const makeRequest = (auth: string | null): Request =>
    new Request("http://localhost/api/lab/runs", {
      headers: auth ? { authorization: auth } : {},
    });

  it("true with matching Bearer secret (>= 32 chars)", () => {
    const env = {
      FIRERAID_LAB_API_SECRET: "s".repeat(32),
    } as unknown as Env;
    const req = makeRequest("Bearer " + "s".repeat(32));
    expect(requireLabAuth(req, env)).toBe(true);
  });

  it("false when LAB_API_SECRET is unset", () => {
    const env = {} as unknown as Env;
    const req = makeRequest("Bearer anything");
    expect(requireLabAuth(req, env)).toBe(false);
  });

  it("false when LAB_API_SECRET is too short (< 32)", () => {
    const env = { FIRERAID_LAB_API_SECRET: "short" } as unknown as Env;
    const req = makeRequest("Bearer short");
    expect(requireLabAuth(req, env)).toBe(false);
  });

  it("false when Bearer secret is wrong", () => {
    const env = { FIRERAID_LAB_API_SECRET: "correct-secret-that-is-32-char!" } as unknown as Env;
    const req = makeRequest("Bearer wrong-secret-that-is-32-char!");
    expect(requireLabAuth(req, env)).toBe(false);
  });

  it("false when scheme is Basic (not Bearer)", () => {
    const env = { FIRERAID_LAB_API_SECRET: "correct-secret-that-is-32-char!" } as unknown as Env;
    const req = makeRequest("Basic d2hhdGV2ZXI=");
    expect(requireLabAuth(req, env)).toBe(false);
  });

  it("false when no authorization header at all", () => {
    const env = { FIRERAID_LAB_API_SECRET: "correct-secret-that-is-32-char!" } as unknown as Env;
    const req = makeRequest(null);
    expect(requireLabAuth(req, env)).toBe(false);
  });
});
