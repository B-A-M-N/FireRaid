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
    // P1-AUDIT-2 Phase F: the two non-LLM attacker architectures landed —
    // fill-everything (omnivorous, decoy-field trap-springer) and
    // humanized-pw (humanized timing, interaction false-positive probe).
    expect(caps["fill-everything"].implemented).toBe(true);
    expect(caps["fill-everything"].usesModel).toBe(false); // deterministic loop, not LLM
    expect(caps["humanized-pw"].implemented).toBe(true);
    expect(caps["humanized-pw"].usesModel).toBe(false);
    // P1-AUDIT-2 Phase F (LLM-backed): both landed, model-consuming.
    expect(caps["vision-only"].implemented).toBe(true);
    expect(caps["vision-only"].usesModel).toBe(true);
    expect(caps["vision-only"].usesPrompt).toBe(true);
    expect(caps["fireraid-aware"].implemented).toBe(true);
    expect(caps["fireraid-aware"].usesModel).toBe(true);
    expect(caps["fireraid-aware"].usesPrompt).toBe(true);
    // ALL named architectures are now implemented — the taxonomy is closed.
    for (const [name, cap] of Object.entries(caps)) {
      expect(cap.implemented, name).toBe(true);
    }
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
      agents: ["definitely-unimplemented-arch"],
      models: ["model-a"],
      prompts: ["baseline"],
    } as unknown as ExperimentManifest;
    const v = validateManifest(manifest);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("expected validation to fail");
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
