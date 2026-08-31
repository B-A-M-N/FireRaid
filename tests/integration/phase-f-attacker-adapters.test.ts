/**
 * P1-AUDIT-2 Phase F — the new attacker architectures against the JOINED
 * plane (real adapter → middleware facade → origin ledger).
 *
 * fill-everything (omnivorous): fills EVERY field including the
 * visually-hidden decoy. With the FULL recipe the decoy is profile-bound and
 * the page carries the semantic nonce only in lab — but in PRODUCTION the
 * decoy field still exists and any fill is decoyFieldPopulated → evidence →
 * not ACCEPT for a full-defense profile. The ledger must stay EMPTY (the
 * trap sprung). With CONTROL the same omnivore must REGISTER (the decoy
 * family is the difference — ablation baseline).
 *
 * humanized-pw (humanized timing): clicks to focus, per-character typing
 * with jitter, pointer move before submit — every weak signal the
 * interaction scorer consumes, produced honestly. Under FULL it must reach
 * the origin and REGISTER (no false positive by construction); the same
 * behavior under CONTROL registers too (baseline sanity).
 *
 * These tests drive the adapters over the facade runtime, so a QUARANTINE
 * (or its absence) is verified at the AUTHORITATIVE ledger, not at
 * FireRaid's own disposition claim.
 */
import { describe, it, expect, afterAll } from "vitest";
import { startOriginLedgerRuntime, trialEmail } from "../../harness/core/origin-ledger.js";
import { FillEverythingAdapter } from "../../harness/adapters/fill-everything.js";
import { HumanizedPwAdapter } from "../../harness/adapters/humanized-pw.js";
import { ABLATION_RECIPES } from "../../src/core/profile.js";
import type { Scenario } from "../../harness/core/run-schema.js";

const SECRET = "phase-f-adapter-secret".padEnd(32, "x");

let runtime: Awaited<ReturnType<typeof startOriginLedgerRuntime>> | undefined;

afterAll(async () => {
  await runtime?.shutdown();
});

function scenario(targetUrl: string, email: string): Scenario {
  return {
    targetUrl,
    fixture: {
      name: "Phase F Attacker",
      email,
      organization: "Example Research",
      intended_use: "Research purposes",
      password: "synthetic-password-123",
    },
    promptVariant: "baseline",
    model: "none",
    maxSteps: 5,
    timeoutMs: 30_000,
  } as Scenario;
}

describe("Phase F: fill-everything (omnivorous attacker)", () => {
  it("FULL recipe: springs the decoy trap — ledger stays EMPTY", async () => {
    runtime = await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.PRODUCTION_FULL);

    const email = trialEmail("exp-phasef", "fill-full-rep0");
    const adapter = new FillEverythingAdapter();
    const result = await adapter.run(scenario(runtime.facadeUrl, email));

    expect(result.outcome).toBe("submitted");
    const created = await runtime.ledgerHasAccount(email);
    // PRIMARY ENDPOINT: the omnivore filled the hidden decoy → admission
    // refused → the origin never created the account.
    expect(created).toBe(false);
  }, 60_000);

  it("CONTROL: the same omnivore registers — the decoy is the difference", async () => {
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.CONTROL);

    const email = trialEmail("exp-phasef", "fill-control-rep0");
    const adapter = new FillEverythingAdapter();
    const result = await adapter.run(scenario(runtime.facadeUrl, email));

    expect(result.outcome).toBe("submitted");
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(true); // no decoys → nothing to trip → registered
  }, 60_000);
});

describe("Phase F: humanized-pw (humanized-timing attacker)", () => {
  it("FULL recipe: NOT flagged — reaches the origin and registers", async () => {
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.PRODUCTION_FULL);

    const email = trialEmail("exp-phasef", "human-full-rep0");
    const adapter = new HumanizedPwAdapter();
    const result = await adapter.run(scenario(runtime.facadeUrl, email));

    expect(result.outcome).toBe("submitted");
    const created = await runtime.ledgerHasAccount(email);
    // False-positive probe: human-plausible telemetry must NOT be denied.
    expect(created).toBe(true);
  }, 90_000);

  it("CONTROL: registers as well (baseline sanity)", async () => {
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.CONTROL);

    const email = trialEmail("exp-phasef", "human-control-rep0");
    const adapter = new HumanizedPwAdapter();
    const result = await adapter.run(scenario(runtime.facadeUrl, email));

    expect(result.outcome).toBe("submitted");
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(true);
  }, 90_000);
});
