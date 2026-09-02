/**
 * Defense-composition redesign — invariant tests for the production random
 * path (Phase A/B).
 *
 * Every random production profile MUST carry:
 *   (1) The "semantic" family.
 *   (2) A template ∈ {P02, P03, P04} — never P01, never S09, never S01-S08.
 *   (3) Causal-channel compliance: P02 → decoy-route, P03 → decoy-field,
 *       P04 → both.
 *   (4) At least one independent automation layer beyond the semantic deps.
 *   (5) Determinism: same inputs → deep-equal output.
 *
 * Lab mode: light-touch sanity — no invariant imposed, just 2–4 families.
 */
import { describe, it, expect } from "vitest";
import { deriveProfilePure } from "../../src/core/profile.js";

const SECRET = "test-secret-composition"; // ≤32 chars, fits HMAC key
const VERSION = 1;
const NUM_PROFILES = 40;

function makeSid(i: number) {
  return `comp-prod-${String(i).padStart(4, "0")}`;
}

describe("production composition invariants", () => {
  // ── Invariant 1: families includes "semantic" ──────────────────────────
  it("all 40 profiles include 'semantic' in families", async () => {
    for (let i = 0; i < NUM_PROFILES; i++) {
      const p = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: makeSid(i),
        mode: "production",
      });
      expect(p.families).toContain("semantic");
    }
  });

  // ── Invariant 2: template ∈ {P02, P03, P04} ──────────────────────────
  it("semantic template is always P02, P03, or P04 — never P01 or S09", async () => {
    const allowed = new Set(["P02", "P03", "P04"]);
    for (let i = 0; i < NUM_PROFILES; i++) {
      const p = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: makeSid(i),
        mode: "production",
      });
      expect(p.semantic).toBeDefined();
      expect(allowed.has(p.semantic!.templateId), `template ${p.semantic!.templateId} not in {P02,P03,P04}`).toBe(true);
      // Sanity: definitely NOT any lab-only or metadata template.
      expect(p.semantic!.templateId).not.toBe("P01");
      expect(p.semantic!.templateId).not.toBe("S09");
    }
  });

  // ── Invariant 3: causal-channel compliance per template ────────────────
  it("P02 → decoy-route present; P03 → decoy-field present; P04 → both", async () => {
    for (let i = 0; i < NUM_PROFILES; i++) {
      const p = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: makeSid(i),
        mode: "production",
      });
      const tid = p.semantic!.templateId;
      if (tid === "P02") {
        expect(p.decoyRoute).toBeDefined();
      } else if (tid === "P03") {
        expect(p.decoyField).toBeDefined();
      } else if (tid === "P04") {
        expect(p.decoyField).toBeDefined();
        expect(p.decoyRoute).toBeDefined();
      }
    }
  });

  // ── Invariant 4: ≥1 independent layer beyond semantic deps ─────────────
  it("P02 gets decoy-route + (decoy-field OR interaction); P03 gets decoy-field + (decoy-route OR interaction); P04 gets all three or at least route+field+interaction", async () => {
    for (let i = 0; i < NUM_PROFILES; i++) {
      const p = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: makeSid(i),
        mode: "production",
      });
      const tid = p.semantic!.templateId;
      const fams = p.families;

      if (tid === "P02") {
        // P02 requires route. Independent layer must be decoy-field or interaction.
        expect(fams).toContain("decoy-route");
        expect(fams).toContain("semantic");
        // At least one of {decoy-field, interaction} must be present as independent.
        expect(fams.includes("decoy-field") || fams.includes("interaction")).toBe(true);
      } else if (tid === "P03") {
        // P03 requires field. Independent layer must be decoy-route or interaction.
        expect(fams).toContain("decoy-field");
        expect(fams).toContain("semantic");
        expect(fams.includes("decoy-route") || fams.includes("interaction")).toBe(true);
      } else {
        // P04 requires route + field. Must have all 4 (semantic + route + field + interaction)
        // or at minimum route + field + ≥1 more. The Phase B pool after P04 deps is
        // {interaction} (the only non-dep trap), so it will always be drawn (pool size 1,
        // draw 1). Assert: all four families present.
        expect(fams).toContain("decoy-route");
        expect(fams).toContain("decoy-field");
        expect(fams).toContain("semantic");
        expect(fams).toContain("interaction");
      }
    }
  });

  // ── Invariant 5: determinism ──────────────────────────────────────────
  it("same inputs produce deep-equal profiles", async () => {
    for (let i = 0; i < NUM_PROFILES; i++) {
      const s = makeSid(i);
      const p1 = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: s,
        mode: "production",
      });
      const p2 = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: s,
        mode: "production",
      });
      expect(p1).toEqual(p2);
    }
  });

  // ── Lab-mode light-touch sanity ──────────────────────────────────────
  it("lab mode: no throw, families.length between 2 and 4", async () => {
    const NUM_LAB = 20;
    for (let i = 0; i < NUM_LAB; i++) {
      const p = await deriveProfilePure({
        secret: SECRET,
        version: VERSION,
        sessionId: `comp-lab-${String(i).padStart(4, "0")}`,
        mode: "lab",
      });
      expect(p.families.length).toBeGreaterThanOrEqual(2);
      expect(p.families.length).toBeLessThanOrEqual(4);
    }
  });
});
