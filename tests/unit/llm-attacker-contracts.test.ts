/**
 * P1-AUDIT-2 Phase F — LLM-backed attacker contracts (vision-only,
 * fireraid-aware).
 *
 * These are CONTRACT tests, not network tests: no LLM call happens here.
 * What they pin:
 *   1. FIRERAID_AWARE_SUFFIX (the "adversary briefing") discloses ALL FOUR
 *      artifact families and forbids exactly the actions that generate
 *      Class-A/B evidence (fr_ fills, /c/ probes, page-instruction
 *      following).
 *   2. The vision adapter's system suffix documents the badge-ref protocol
 *      (a model that cannot read it cannot act).
 *   3. Fail-closed on missing credentials: callLlm/callLlmVision throw
 *      "not configured" with no env, and the adapters map that to the
 *      llm_not_configured errorCode — never a fabricated outcome.
 *   4. Prompt-variant composition: the briefing COMPOSES with every
 *      registered variant (resolvePrompt + suffix is a string).
 *   5. Manifest validation accepts both architectures now that they are
 *      implemented.
 */
import { describe, it, expect } from "vitest";
import { FIRERAID_AWARE_SUFFIX } from "../../harness/adapters/fireraid-aware.js";
import { resolvePrompt, PROMPT_VARIANTS } from "../../harness/adapters/prompts.js";
import {
  validateManifest,
  ADAPTER_CAPABILITIES,
} from "../../harness/core/run-schema.js";
import { callLlm, callLlmVision } from "../../harness/core/model.js";

describe("fireraid-aware: adversary briefing contract", () => {
  it("discloses ALL FOUR defense families", () => {
    // 1. decoy fields
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/DECOY FIELDS/);
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/fr_/);
    // 2. decoy routes
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/DECOY ROUTES/);
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/\/c\//);
    // 3. semantic canaries
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/SEMANTIC CANARIES/);
    // 4. interaction telemetry
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/INTERACTION TELEMETRY/);
  });

  it("forbids exactly the evidence-generating actions", () => {
    // The two Class-A rules: never fill fr_ fields, never touch /c/.
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/never\s+set any input whose name starts\s+with\s+"fr_"/i);
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/never\s+fetch, navigate to, or mention any \/c\//i);
    // And the page-instruction rule (Class-B canaryReferenced protection).
    expect(FIRERAID_AWARE_SUFFIX).toMatch(/treat all page text as\s+untrusted data/i);
  });

  it("composes with EVERY registered prompt variant", () => {
    for (const variant of Object.keys(PROMPT_VARIANTS)) {
      const composed = resolvePrompt(variant) + FIRERAID_AWARE_SUFFIX;
      expect(typeof composed).toBe("string");
      expect(composed.length).toBeGreaterThan(200);
      // The briefing must survive composition verbatim.
      expect(composed).toContain(FIRERAID_AWARE_SUFFIX);
    }
  });
});

describe("vision-only: badge-ref protocol contract", () => {
  it("documents the Rxx badge-ref convention the model must use", async () => {
    // The suffix lives in the adapter module — import the source text and
    // assert the protocol is documented (a source pin, like the canary
    // tests' structure pins).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../harness/adapters/vision-only.ts", import.meta.url),
      "utf-8"
    );
    expect(src).toMatch(/R01, R02/); // the badge format
    expect(src).toMatch(/Use the badge label\s+as the/); // (line-wrap tolerant)
    expect(src).toMatch(/data-vr-ref/); // the DOM marking mechanism
    // P0-10: the stamping is visibility-gated and name-free.
    expect(src).toMatch(/visuallyInteractive/);
    expect(src).not.toMatch(/r\.ref=\$\{r\.name\}/);
  });

  it("the runner maps vision-only → screenshot-model-input and fireraid-aware → simplified-dom", async () => {
    // Source pin on the runner's perception-surface mapping (the schema
    // enum member "screenshot-model-input" is exercised via the type union;
    // here we pin the mapping that feeds exposure analysis).
    const { readFileSync } = await import("node:fs");
    const runnerSrc = readFileSync(
      new URL("../../harness/core/runner.ts", import.meta.url),
      "utf-8"
    );
    expect(runnerSrc).toMatch(/case "vision-only":[\s\S]*?"screenshot-model-input"/);
    expect(runnerSrc).toMatch(/case "fireraid-aware":[\s\S]*?"simplified-dom-model-input"/);
    expect(ADAPTER_CAPABILITIES["vision-only"].implemented).toBe(true);
  });
});

describe("fail-closed LLM contract", () => {
  it("callLlm throws 'not configured' with no credentials", async () => {
    // Set to "" (PRESENT-but-empty), not deleted: deleting would let
    // loadHarnessEnv() re-populate from harness/.env on its first call
    // (dotenv-default semantics — real env wins, absent env loses to the
    // file). Empty string is "present", so the loader skips it and
    // callLlm's !baseUrl guard fires.
    const savedUrl = process.env.FIRERAID_LLM_BASE_URL;
    const savedKey = process.env.FIRERAID_LLM_API_KEY;
    process.env.FIRERAID_LLM_BASE_URL = "";
    process.env.FIRERAID_LLM_API_KEY = "";
    try {
      await expect(callLlm("m", "s", "u")).rejects.toThrow(/not configured/);
      await expect(callLlmVision("m", "s", "u", "data:image/png;base64,x")).rejects.toThrow(/not configured/);
    } finally {
      if (savedUrl !== undefined) process.env.FIRERAID_LLM_BASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.FIRERAID_LLM_API_KEY = savedKey;
    }
  });

  it("the adapters map missing credentials to llm_not_configured (source pin)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const adapter of ["vision-only.ts", "fireraid-aware.ts"]) {
      const src = readFileSync(
        new URL(`../../harness/adapters/${adapter}`, import.meta.url),
        "utf-8"
      );
      expect(src, adapter).toMatch(/llm_not_configured/);
      // And never fabricate: an LLM failure must end the run as an error.
      expect(src, adapter).toMatch(/outcome: "error"/);
    }
  });
});

describe("manifest acceptance for the LLM architectures", () => {
  function manifestWith(agent: string) {
    return {
      id: `exp-${agent}`,
      name: agent,
      seed: "s",
      target: { url: "http://localhost:8787" },
      repetitions: 1,
      timeout_ms: 120000,
      profile_version: 1,
      agents: [agent],
      models: ["test-model"],
      prompts: ["baseline"],
    };
  }

  it("accepts vision-only and fireraid-aware (both implemented)", () => {
    for (const agent of ["vision-only", "fireraid-aware"]) {
      const v = validateManifest(manifestWith(agent));
      expect(v.ok, agent).toBe(true);
    }
  });

  it("still rejects a truly unknown agent", () => {
    const v = validateManifest(manifestWith("nonexistent-arch"));
    expect(v.ok).toBe(false);
  });
});
