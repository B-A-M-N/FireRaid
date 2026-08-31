/**
 * P1-21 — realistic attacker architectures taxonomy + matrix discipline.
 *
 * Verifies the new AgentType architectures are registered in
 * ADAPTER_CAPABILITIES, that the runner rejects unimplemented adapters
 * fail-closed, and that a manifest referencing only implemented architectures
 * (including the new non-LLM dom-automation) validates cleanly.
 */
import { describe, it, expect } from "vitest";
import {
  ADAPTER_CAPABILITIES,
  validateManifest,
  type ExperimentManifest,
} from "../../harness/core/run-schema.js";

describe("P1-21 attacker architecture taxonomy", () => {
  it("registers all named architectures with correct capability flags", () => {
    const caps = ADAPTER_CAPABILITIES;
    // Implemented baseline architectures.
    expect(caps["human"].implemented).toBe(true);
    expect(caps["raw-dom"].implemented).toBe(true);
    expect(caps["ax-snapshot"].implemented).toBe(true);
    expect(caps["browser-use"].implemented).toBe(true);
    expect(caps["raw-http"].implemented).toBe(true);
    // P1-21 new architectures.
    expect(caps["dom-automation"].implemented).toBe(true);
    expect(caps["dom-automation"].usesModel).toBe(false); // non-LLM
    // Not-yet-landed model-backed ones are declared but rejected (fail-closed).
    expect(caps["fill-everything"].implemented).toBe(false);
    expect(caps["humanized-pw"].implemented).toBe(false);
    expect(caps["vision-only"].implemented).toBe(false);
    expect(caps["fireraid-aware"].implemented).toBe(false);
  });

  it("rejects a manifest that names an unimplemented architecture", () => {
    const manifest = {
      id: "exp-x",
      name: "x",
      seed: "s",
      target: { url: "http://localhost:8787" },
      repetitions: 1,
      timeout_ms: 120000,
      profile_version: 1,
      agents: ["vision-only"],
      models: ["model-a"],
      prompts: ["baseline"],
    } as unknown as ExperimentManifest;
    const v = validateManifest(manifest);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("expected validation to fail");
    expect(v.errors.join(" ")).toContain("agent not yet integrated");
  });

  it("accepts a manifest using only implemented architectures incl. dom-automation", () => {
    const manifest = {
      id: "exp-dom",
      name: "dom",
      seed: "s",
      target: { url: "http://localhost:8787" },
      repetitions: 1,
      timeout_ms: 120000,
      profile_version: 1,
      agents: ["human", "raw-http", "dom-automation"],
      models: ["model-a"],
      prompts: ["baseline"],
    } as unknown as ExperimentManifest;
    const v = validateManifest(manifest);
    expect(v.ok).toBe(true);
  });
});
