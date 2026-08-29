/**
 * Unit tests for the deterministic profile engine.
 * FR-INV-002: same secret + same SID + same version => identical profile.
 */
import { describe, it, expect } from "vitest";
import { deriveProfile } from "../../src/core/profile.js";
import { deriveSeed, SeedStream, sampleWithoutReplacement } from "../../src/core/prng.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS, lintAllCanaries } from "../../src/core/catalog.js";
import { correlate } from "../../src/core/correlation.js";
import { decide, score } from "../../src/core/decision.js";
import { generateSessionId, deriveCsrfToken, verifyCsrfToken } from "../../src/core/session.js";
import type { Env } from "../../src/env.js";

const mockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    FIRERAID_PROFILE_SECRET: "a".repeat(64),
    FIRERAID_CSRF_SECRET: "b".repeat(64),
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x00000000000000000000000000000000AA",
    ADMIN_SECRET: "admin",
    ...overrides,
  }) as unknown as Env;

describe("prng", () => {
  it("derives deterministic seed from secret+version+sid", async () => {
    const a = await deriveSeed("secret", 1, "sid-123");
    const b = await deriveSeed("secret", 1, "sid-123");
    const c = await deriveSeed("secret", 1, "sid-456");
    expect(Array.from(new Uint8Array(a))).toEqual(Array.from(new Uint8Array(b)));
    expect(Array.from(new Uint8Array(a))).not.toEqual(Array.from(new Uint8Array(c)));
  });

  it("SeedStream produces deterministic bytes", async () => {
    const seed = await deriveSeed("s", 1, "x");
    const s1 = new SeedStream(seed);
    const s2 = new SeedStream(seed);
    for (let i = 0; i < 10; i++) expect(await s1.nextByte()).toBe(await s2.nextByte());
  });

  it("nextInt is within range", async () => {
    const s = new SeedStream(await deriveSeed("s", 1, "x"));
    for (let i = 0; i < 100; i++) {
      const v = await s.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("sampleWithoutReplacement returns unique items", async () => {
    const s = new SeedStream(await deriveSeed("s", 1, "x"));
    const items = [1, 2, 3, 4, 5];
    const sample = await sampleWithoutReplacement(s, items, 3);
    expect(new Set(sample).size).toBe(3);
    for (const x of sample) expect(items).toContain(x);
  });
});

describe("profile determinism", () => {
  it("same inputs => identical profile", async () => {
    const env = mockEnv();
    const p1 = await deriveProfile(env, "session-abc");
    const p2 = await deriveProfile(env, "session-abc");
    expect(p1).toEqual(p2);
  });

  it("different session => different profile", async () => {
    const env = mockEnv();
    const p1 = await deriveProfile(env, "session-1");
    const p2 = await deriveProfile(env, "session-2");
    expect(p1.profileId).not.toBe(p2.profileId);
  });

  it("different version => different profile", async () => {
    const env1 = mockEnv({ PROFILE_VERSION: "1" });
    const env2 = mockEnv({ PROFILE_VERSION: "2" });
    const p1 = await deriveProfile(env1, "same-sid");
    const p2 = await deriveProfile(env2, "same-sid");
    expect(p1.profileId).not.toBe(p2.profileId);
  });

  it("profile has 2-4 families", async () => {
    const env = mockEnv();
    for (let i = 0; i < 50; i++) {
      const p = await deriveProfile(env, `sid-${i}`);
      expect(p.families.length).toBeGreaterThanOrEqual(2);
      expect(p.families.length).toBeLessThanOrEqual(4);
      // No duplicates
      expect(new Set(p.families).size).toBe(p.families.length);
    }
  });

  it("semantic template is from catalog", async () => {
    const env = mockEnv();
    const ids = new Set(SEMANTIC_TEMPLATES.map((t) => t.id));
    for (let i = 0; i < 100; i++) {
      const p = await deriveProfile(env, `sid-${i}`);
      if (p.semantic) expect(ids.has(p.semantic.templateId)).toBe(true);
    }
  });

  it("nonce is 6 chars from expected alphabet", async () => {
    const env = mockEnv();
    const p = await deriveProfile(env, "sid-nonce");
    if (p.semantic) {
      expect(p.semantic.nonce).toHaveLength(6);
      expect(p.semantic.nonce).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe("catalog", () => {
  it("has >= 8 semantic templates", () => {
    expect(SEMANTIC_TEMPLATES.length).toBeGreaterThanOrEqual(8);
  });

  it("has >= 6 placements", () => {
    expect(PLACEMENTS.length).toBeGreaterThanOrEqual(6);
  });

  it("canary linter finds no prohibited patterns", () => {
    const issues = lintAllCanaries();
    expect(issues).toEqual([]);
  });

  it("P06 is lab-only and not production-eligible", () => {
    const p06 = PLACEMENTS.find((p) => p.id === "P06");
    expect(p06).toBeDefined();
    expect(p06!.productionEligible).toBe(false);
    expect(p06!.accessibilitySafe).toBe(false);
  });
});

describe("correlation", () => {
  it("canary endpoint hit => Class A evidence", async () => {
    const env = mockEnv();
    const profile = await deriveProfile(env, "sid");
    profile.decoy = { fieldName: "fr_x", endpointToken: "abc123", elementId: "fr_y" };
    const evidence = await correlate(profile, { canaryEndpointHit: true });
    const causal = evidence.filter((e) => e.class === "A");
    expect(causal.length).toBeGreaterThanOrEqual(1);
    expect(causal[0].source).toBe("CANARY_ROUTE_MATCH");
  });

  it("no observations => empty evidence", async () => {
    const env = mockEnv();
    const profile = await deriveProfile(env, "sid");
    const evidence = await correlate(profile, {});
    expect(evidence).toEqual([]);
  });
});

describe("decision", () => {
  it("Class A evidence => QUARANTINE", () => {
    const evidence = [
      { id: "1", class: "A" as const, weight: 100, source: "X", verified: true },
    ];
    const d = decide(evidence);
    expect(d.disposition).toBe("QUARANTINE");
  });

  it("weak evidence only => ACCEPT (low score)", () => {
    const evidence = [
      { id: "1", class: "C" as const, weight: 10, source: "X", verified: false },
    ];
    const d = decide(evidence);
    expect(d.disposition).toBe("ACCEPT");
  });

  it("score sums weights", () => {
    const evidence = [
      { id: "1", class: "A" as const, weight: 100, source: "X", verified: true },
      { id: "2", class: "B" as const, weight: 60, source: "Y", verified: true },
    ];
    expect(score(evidence)).toBe(160);
  });
});

describe("session", () => {
  it("session IDs are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(1000);
  });

  it("CSRF token verifies correctly", async () => {
    const token = await deriveCsrfToken("secret", "sid", "purpose");
    expect(await verifyCsrfToken("secret", "sid", "purpose", token)).toBe(true);
    expect(await verifyCsrfToken("secret", "sid", "purpose", "wrong")).toBe(false);
    expect(await verifyCsrfToken("secret", "other", "purpose", token)).toBe(false);
  });
});
