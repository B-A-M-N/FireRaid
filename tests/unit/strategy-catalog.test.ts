/**
 * FR-AUDIT-001: production vs evaluation strategy catalog split.
 *
 * PRODUCTION_AGENT_STRATEGIES and EVALUATION_SEMANTIC_PROBES must form a
 * clean partition of SEMANTIC_TEMPLATES — every template classified exactly
 * once, no overlap, no omissions. Production strategies must be genuine
 * causal traps (labOnly=false, requiresRoute || requiresDecoyField).
 */
import { describe, it, expect } from "vitest";
import {
  SEMANTIC_TEMPLATES,
  PRODUCTION_AGENT_STRATEGIES,
  EVALUATION_SEMANTIC_PROBES,
} from "../../src/core/catalog.js";

describe("FR-AUDIT-001: catalog split invariants", () => {
  const prodSet = new Set(PRODUCTION_AGENT_STRATEGIES);
  const evalSet = new Set(EVALUATION_SEMANTIC_PROBES);
  const allIds = new Set(SEMANTIC_TEMPLATES.map((t) => t.id));

  it("PRODUCTION and EVALUATION are disjoint", () => {
    for (const id of prodSet) {
      expect(evalSet.has(id), `${id} must not be in both catalogs`).toBe(false);
    }
  });

  it("Together they cover exactly all SEMANTIC_TEMPLATES ids", () => {
    const covered = new Set([...PRODUCTION_AGENT_STRATEGIES, ...EVALUATION_SEMANTIC_PROBES]);
    expect(covered).toEqual(allIds);
  });

  it("No template is unclassified (every SEMANTIC_TEMPLATES id is in one catalog)", () => {
    for (const t of SEMANTIC_TEMPLATES) {
      expect(
        prodSet.has(t.id) || evalSet.has(t.id),
        `${t.id} must appear in exactly one catalog`
      ).toBe(true);
    }
  });

  it("No catalog entry is missing from SEMANTIC_TEMPLATES", () => {
    for (const id of [...PRODUCTION_AGENT_STRATEGIES, ...EVALUATION_SEMANTIC_PROBES]) {
      expect(allIds.has(id), `${id} must exist in SEMANTIC_TEMPLATES`).toBe(true);
    }
  });

  it("Every production strategy has labOnly=false and is causal-capable", () => {
    for (const id of PRODUCTION_AGENT_STRATEGIES) {
      const t = SEMANTIC_TEMPLATES.find((x) => x.id === id);
      expect(t, `${id} must exist in SEMANTIC_TEMPLATES`).toBeDefined();
      expect(t!.labOnly).toBe(false);
      expect(
        t!.requiresRoute || t!.requiresDecoyField,
        `${id} must be causal-capable (requiresRoute || requiresDecoyField)`
      ).toBe(true);
    }
  });

  it("P01 is NOT in PRODUCTION_AGENT_STRATEGIES", () => {
    expect(PRODUCTION_AGENT_STRATEGIES).not.toContain("P01");
  });

  it("S09 is NOT in PRODUCTION_AGENT_STRATEGIES", () => {
    expect(PRODUCTION_AGENT_STRATEGIES).not.toContain("S09");
  });

  it("Every EVALUATION_SEMANTIC_PROBES id exists in SEMANTIC_TEMPLATES", () => {
    for (const id of EVALUATION_SEMANTIC_PROBES) {
      const found = SEMANTIC_TEMPLATES.find((t) => t.id === id);
      expect(found, `${id} must exist in SEMANTIC_TEMPLATES`).toBeDefined();
    }
  });

  it("Every production strategy's render output contains its nonce", () => {
    for (const id of PRODUCTION_AGENT_STRATEGIES) {
      const t = SEMANTIC_TEMPLATES.find((x) => x.id === id);
      expect(t).toBeDefined();
      const rendered = t!.render({ nonce: "FRNONCETEST" });
      expect(rendered, `${id} render must contain the nonce string "FRNONCETEST"`).toContain(
        "FRNONCETEST"
      );
    }
  });
});
