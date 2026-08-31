/**
 * P1-AUDIT-2 Phase C — the JOINED proof plane.
 *
 * Real harness adapter (raw-http, the scripted minimum-protocol attacker)
 *   → host-neutral FireRaid middleware (admit())
 *     → ordinary upstream signup app (FireRaid-ignorant)
 *       → AUTHORITATIVE ledger read back READ-ONLY.
 *
 * Establishes the three Phase C invariants:
 *   1. CONTROL: adapter registers → the ledger contains the account.
 *   2. FULL + exact nonce in the decoy field: middleware QUARANTINEs → the
 *      ledger does NOT contain the account (defense actually held at the
 *      origin — the property `submitted` could never prove).
 *   3. Ledger truth is per-trial-identity unambiguous (unique emails).
 */
import { describe, it, expect, afterAll } from "vitest";
import { startOriginLedgerRuntime, trialEmail } from "../../harness/core/origin-ledger.js";
import { RawHttpAdapter } from "../../harness/adapters/raw-http.js";
import { ABLATION_RECIPES } from "../../src/core/profile.js";
import type { Scenario } from "../../harness/core/run-schema.js";

const SECRET = "origin-ledger-test-secret".padEnd(32, "x");

let runtime: Awaited<ReturnType<typeof startOriginLedgerRuntime>> | undefined;

afterAll(async () => {
  await runtime?.shutdown();
});

function scenario(targetUrl: string): Scenario {
  return {
    targetUrl,
    fixture: {
      name: "Casey Ledger",
      email: "placeholder@ledger-probe.invalid",
      organization: "Example Research",
      intended_use: "Research purposes",
      password: "synthetic-password-123",
    },
    promptVariant: "baseline",
    model: "none",
    maxSteps: 5,
    timeoutMs: 15_000,
  } as Scenario;
}

describe("Phase C: real agent → middleware → origin ledger", () => {
  it("CONTROL: raw-http registers and the ORIGIN ledger contains the account", async () => {
    runtime = await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.CONTROL);

    const email = trialEmail("exp-join-test", "control-rep0");
    const sc = scenario(runtime.facadeUrl);
    sc.fixture = { ...sc.fixture, email };

    const adapter = new RawHttpAdapter();
    const result = await adapter.run(sc);

    expect(result.outcome).toBe("submitted");
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(true); // PRIMARY ENDPOINT: origin says account exists
  }, 30_000);

  it("FULL + exact nonce in the decoy field: QUARANTINE and NO origin account", async () => {
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.FULL);

    const email = trialEmail("exp-join-test", "full-rep0");

    // The causal Class-A path itself (S06 nonce → QUARANTINE) is pinned in
    // host-adapter-middleware.test.ts. What THIS test proves is the JOIN:
    // a quarantined submission leaves the ORIGIN ledger empty — the property
    // FireRaid's `submitted` flag could never establish. Drive the facade
    // with the same secret the runtime uses so profile derivation matches.
    const { makeCsrf, ReferenceSessionAdapter } = await import("../../src/host-adapter/index.js");
    const { deriveProfilePure } = await import("../../src/core/profile.js");

    const session = new ReferenceSessionAdapter(SECRET);
    const sessionId = await session.createSession();
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId, mode: "production" },
      ABLATION_RECIPES.FULL
    );
    const nonce = profile.semantic!.nonce;
    const field = profile.decoyField!.fieldName;

    // POST through the facade: signed cookie + keyed CSRF + nonce-in-field.
    const cookie = await session.sessionCookie(sessionId);
    const csrf = await makeCsrf(SECRET, sessionId);
    const resp = await fetch(`${runtime.facadeUrl}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ csrf, form: { name: "Q", email, [field]: nonce } }),
    });
    expect(resp.status).toBe(403); // QUARANTINE → facade denies (never forwards)
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(false); // PRIMARY ENDPOINT: origin did NOT create it
  }, 30_000);
});
