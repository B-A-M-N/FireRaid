/**
 * Unit tests for admin-auth module.
 * Covers FR-R4-007 (HMAC covers nonce+iat+exp) and FR-R4-067 (iat/exp full validation).
 */
import { describe, it, expect } from "vitest";
import {
  createAdminToken,
  verifyAdminToken,
  verifyAdminSecret,
  ADMIN_SESSION_TTL,
} from "../../src/security/admin-auth.js";
import type { Env } from "../../src/env.js";

const ADMIN_SECRET = "s".repeat(32);

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

function mockEnvWithSecret(secret: string): Env {
  return mockEnv({ ADMIN_SECRET: secret });
}

/**
 * Helper: construct a valid token by signing a known payload with the given secret.
 * Returns "nonce.iat.exp.signature" (4 parts).
 */
async function buildToken(
  secret: string,
  nonceStr: string,
  iat: number,
  exp: number
): Promise<string> {
  const payload = `${nonceStr}.${iat}.${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigStr = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${sigStr}`;
}

const FIXED_NONCE = "000102030405060708090a0b0c0d0e0f"; // 16 bytes hex

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("admin-auth: round-trip", () => {
  it("createAdminToken then verifyAdminToken succeeds", async () => {
    const env = mockEnv();
    const token = await createAdminToken(env);
    expect(await verifyAdminToken(env, token)).toBe(true);
  });
});

describe("admin-auth: tampering — FR-R4-007", () => {
  it("tampered exp (increment digits) is rejected", async () => {
    const env = mockEnv();
    const token = await createAdminToken(env);
    // Split into 4 parts, tamper with exp (part index 2)
    const parts = token.split(".");
    expect(parts.length).toBe(4);
    const oldExp = parts[2];
    // Increment last digit
    parts[2] = String(Number(oldExp) + 1);
    const tampered = parts.join(".");
    expect(await verifyAdminToken(env, tampered)).toBe(false);
  });

  it("tampered iat is rejected", async () => {
    const env = mockEnv();
    const token = await createAdminToken(env);
    const parts = token.split(".");
    parts[1] = String(Number(parts[1]) + 100);
    const tampered = parts.join(".");
    expect(await verifyAdminToken(env, tampered)).toBe(false);
  });

  it("tampered nonce is rejected", async () => {
    const env = mockEnv();
    const token = await createAdminToken(env);
    const parts = token.split(".");
    // Flip one character in the nonce
    const chars = parts[0].split("");
    chars[0] = chars[0] === "0" ? "1" : "0";
    parts[0] = chars.join("");
    const tampered = parts.join(".");
    expect(await verifyAdminToken(env, tampered)).toBe(false);
  });

  it("tampered signature is rejected", async () => {
    const env = mockEnv();
    const token = await createAdminToken(env);
    const parts = token.split(".");
    // Flip one character in the signature
    const sigChars = parts[3].split("");
    sigChars[0] = sigChars[0] === "0" ? "1" : "0";
    parts[3] = sigChars.join("");
    const tampered = parts.join(".");
    expect(await verifyAdminToken(env, tampered)).toBe(false);
  });
});

describe("admin-auth: expiration — FR-R4-067", () => {
  it("expired token (exp in the past) is rejected", async () => {
    const past = nowSec() - ADMIN_SESSION_TTL / 1000 - 10;
    const exp = past;
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, past, exp);
    expect(await verifyAdminToken(mockEnv(), token)).toBe(false);
  });

  it("token with exp - iat exceeding TTL is rejected", async () => {
    // iat in the recent past, exp far in the future
    const iat = nowSec() - 60;
    const exp = iat + ADMIN_SESSION_TTL / 1000 + 3600; // 1 hour over the TTL
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, iat, exp);
    expect(await verifyAdminToken(mockEnv(), token)).toBe(false);
  });

  it("future iat beyond 60s skew is rejected", async () => {
    const iat = nowSec() + 120; // 120s in the future, beyond 60s skew
    const exp = iat + Math.floor(ADMIN_SESSION_TTL / 1000);
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, iat, exp);
    expect(await verifyAdminToken(mockEnv(), token)).toBe(false);
  });

  it("token just within TTL bound is accepted", async () => {
    const iat = nowSec() - 10;
    const exp = iat + Math.floor(ADMIN_SESSION_TTL / 1000);
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, iat, exp);
    expect(await verifyAdminToken(mockEnv(), token)).toBe(true);
  });
});

describe("admin-auth: malformed tokens", () => {
  it("3-part token is rejected", async () => {
    expect(await verifyAdminToken(mockEnv(), "a.b.c")).toBe(false);
  });

  it("5-part token is rejected", async () => {
    expect(await verifyAdminToken(mockEnv(), "a.b.c.d.e")).toBe(false);
  });

  it("single part token is rejected", async () => {
    expect(await verifyAdminToken(mockEnv(), "abc")).toBe(false);
  });

  it("empty string is rejected", async () => {
    expect(await verifyAdminToken(mockEnv(), "")).toBe(false);
  });

  it("non-numeric iat is rejected", async () => {
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, nowSec(), nowSec() + 3600);
    const parts = token.split(".");
    parts[1] = "notanumber";
    expect(await verifyAdminToken(mockEnv(), parts.join("."))).toBe(false);
  });

  it("non-numeric exp is rejected", async () => {
    const token = await buildToken(ADMIN_SECRET, FIXED_NONCE, nowSec(), nowSec() + 3600);
    const parts = token.split(".");
    parts[2] = "expired";
    expect(await verifyAdminToken(mockEnv(), parts.join("."))).toBe(false);
  });

  it("non-integer iat (float string) is rejected", async () => {
    const env = mockEnv();
    const payload = `${FIXED_NONCE}.1234.5678`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ADMIN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const sigStr = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const token = `${payload}.${sigStr}`;
    // Replace iat with a float string
    const parts = token.split(".");
    parts[1] = "1234.5";
    expect(await verifyAdminToken(env, parts.join("."))).toBe(false);
  });
});

describe("admin-auth: verifyAdminSecret", () => {
  it("correct secret returns true", () => {
    const env = mockEnvWithSecret(ADMIN_SECRET);
    expect(verifyAdminSecret(env, ADMIN_SECRET)).toBe(true);
  });

  it("wrong secret returns false", () => {
    const env = mockEnvWithSecret(ADMIN_SECRET);
    expect(verifyAdminSecret(env, "wrong-secret-used-here")).toBe(false);
  });

  it("missing ADMIN_SECRET env → both verify functions return false", async () => {
    const env = mockEnv({ ADMIN_SECRET: undefined });
    expect(verifyAdminSecret(env, ADMIN_SECRET)).toBe(false);
    expect(await verifyAdminToken(env, "any-token")).toBe(false);
  });

  it("short ADMIN_SECRET (less than 32 chars) → false for both", async () => {
    const env = mockEnvWithSecret("short");
    expect(verifyAdminSecret(env, "any")).toBe(false);
    expect(await verifyAdminToken(env, "any-token")).toBe(false);
  });
});
