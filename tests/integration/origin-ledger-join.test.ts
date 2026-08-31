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

  it("nonce in the decoy field (Class-A causal): QUARANTINE and NO origin account", async () => {
    // P1-1: the nonce mechanism is a LAB mechanism (semantic family,
    // production fails closed) — this arm derives in lab mode. The
    // production-faithful causal chain is the NEXT test (canary route).
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: true });
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
      { secret: SECRET, version: 1, sessionId, mode: "lab" },
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

  it("canary probe then submit: verified route hit → QUARANTINE, NO origin account", async () => {
    // P1-AUDIT-2 Phase D (audit item 6): the JOINED host-plane causal chain.
    // The attacker probes the decoy route FIRST (the /c/<token> behavior the
    // defense exists to catch), then submits through the SAME session —
    // exactly what the prior middleware could never see because every GET
    // minted a fresh session. Drive the facade over real HTTP like the
    // raw-http adapter would.
    runtime = runtime ?? await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.PRODUCTION_FULL);

    const email = trialEmail("exp-join-test", "probe-then-submit-rep0");

    // Session + profile through the facade's own GET (cookie comes back).
    const getResp = await fetch(`${runtime.facadeUrl}/signup`);
    expect(getResp.status).toBe(200);
    const cookie = getResp.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-fr_sid=");

    // Derive the SAME profile the facade issued (same secret/version/sid).
    // Cookie value is the fr1 envelope — decode the payload body for the sid.
    const envVal = cookie.split(";")[0].split("=")[1];
    const payload = JSON.parse(atob(envVal!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sid: string };
    const sid = payload.sid;
    const { deriveProfilePure } = await import("../../src/core/profile.js");
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: sid, mode: "production" },
      ABLATION_RECIPES.PRODUCTION_FULL
    );
    const token = profile.decoyRoute!.endpointToken;

    // 1. Probe the decoy route with the session cookie → 204 (verified).
    const probe = await fetch(`${runtime.facadeUrl}/c/${token}`, { headers: { cookie } });
    expect(probe.status).toBe(204);

    // 2. Submit with a CLEAN form (no nonce — the route hit alone must hold).
    const { makeCsrf } = await import("../../src/host-adapter/index.js");
    const csrf = await makeCsrf(SECRET, sid);
    const submit = await fetch(`${runtime.facadeUrl}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        csrf,
        form: { name: "Q", email, [profile.decoyField!.fieldName]: "" },
      }),
    });
    expect(submit.status).toBe(403); // Class-A route evidence → QUARANTINE

    // 3. PRIMARY ENDPOINT: the origin ledger did NOT create the account.
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(false);
  }, 30_000);
});
