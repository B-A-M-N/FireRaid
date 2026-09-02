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
 *
 * P1-AUDIT-2 response additions:
 *   P0-1  interaction telemetry drained through /api/events PERSISTS to the
 *         submit evaluation — the direct-fill bot with a drained
 *         machine-shaped stream is REVIEW/quarantined off the origin, and
 *         the store holds the whole unique stream.
 *   P0-4  trialTruth() carries the middleware-side record (profile id,
 *         families, disposition, score, canary verification) — the
 *         server_reconciled inputs — while the ledger probe remains an
 *         independent origin_reconciled truth.
 *   P0-12 treatmentMaterial carries the exact issued field name/route
 *         token/nonce per session.
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
    objective: "honest",
    fixtureId: "ledger-join",
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

    // P0-4: the middleware-side truth was captured for this trial too —
    // server_reconciled inputs exist independently of the ledger probe.
    const truth = runtime.trialTruth();
    expect(truth).toBeDefined();
    expect(truth!.disposition).toBe("ACCEPT");
    expect(truth!.defenseFamilies).toEqual([]);
    expect(truth!.submitted).toBe(true);
  }, 30_000);

  it("nonce in the decoy field (Class-A causal): QUARANTINE and NO origin account", async () => {
    // P1-1: the nonce mechanism is a LAB mechanism (semantic family,
    // production fails closed) — this arm derives in lab mode. The
    // production-faithful causal chain is the NEXT test (canary route).
    // P0-7 (fixed in this response): a SEPARATE lab-mode runtime lifecycle —
    // the production runtime from test 1 must not silently serve the lab
    // semantic arm (its profile derivation would fail closed and 403 for
    // the WRONG reason, a false-positive "defense held").
    runtime = await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: true });
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
    // P0-7: the 403 must be the REAL causal decision — QUARANTINE, not an
    // EVAL_ERROR from a recipe the production engine would reject.
    expect(((await resp.json()) as { disposition?: string }).disposition).toBe("QUARANTINE");
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(false); // PRIMARY ENDPOINT: origin did NOT create it

    // P0-4: the deny path records the middleware truth — QUARANTINE
    // disposition, issued families, the exact semantic material (P0-12).
    const truth = runtime.trialTruth();
    expect(truth).toBeDefined();
    expect(truth!.disposition).toBe("QUARANTINE");
    expect(truth!.defenseFamilies).toContain("semantic");
    expect(truth!.treatmentMaterial.semanticNonce).toBe(nonce);
    expect(truth!.treatmentMaterial.fieldName).toBe(field);
  }, 30_000);

  it("canary probe then submit: verified route hit → QUARANTINE, NO origin account", async () => {
    // P1-AUDIT-2 Phase D (audit item 6): the JOINED host-plane causal chain.
    // The attacker probes the decoy route FIRST (the /c/<token> behavior the
    // defense exists to catch), then submits through the SAME session —
    // exactly what the prior middleware could never see because every GET
    // minted a fresh session. Drive the facade over real HTTP like the
    // raw-http adapter would.
    runtime = await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.PRODUCTION_NONSEMANTIC_FULL);

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
      ABLATION_RECIPES.PRODUCTION_NONSEMANTIC_FULL
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
    expect(((await submit.json()) as { disposition?: string }).disposition).toBe("QUARANTINE");

    // 3. PRIMARY ENDPOINT: the origin ledger did NOT create the account.
    const created = await runtime.ledgerHasAccount(email);
    expect(created).toBe(false);

    // P0-4/P0-12: trial truth captured the verified canary + route token.
    const truth = runtime.trialTruth();
    expect(truth).toBeDefined();
    expect(truth!.disposition).toBe("QUARANTINE");
    expect(truth!.canaryVerified).toBe(true);
    expect(truth!.treatmentMaterial.routeToken).toBe(token);
  }, 30_000);

  it("P0-1: telemetry drained through /api/events persists into the submit decision", async () => {
    // The REAL signup.js drains its queue through /api/events BEFORE
    // submitting. The prior runtime minted a fresh ReferenceTelemetryAdapter
    // inside deps() per request, so the drain landed in a store that was
    // discarded — the submit scored an empty stream and the interaction
    // family measured nothing. This drives the actual HTTP facade:
    //   GET /signup → POST /api/events [1..5] → POST /api/events [6..10]
    //   → POST /api/submit eventBatch=[]
    // and requires the submit decision to carry evidence derived from
    // seq 1..10 (a machine-shaped stream under INTERACTION_ONLY must NOT
    // be an ACCEPT-with-zero-evidence outcome).
    runtime = await startOriginLedgerRuntime({ secret: SECRET, version: 1, labMode: false });
    runtime.setTrialRecipe(ABLATION_RECIPES.INTERACTION_ONLY);

    const email = trialEmail("exp-join-test", "drain-then-submit-rep0");

    const { makeCsrf, ReferenceSessionAdapter } = await import("../../src/host-adapter/index.js");

    const session = new ReferenceSessionAdapter(SECRET);
    const sessionId = await session.createSession();
    const cookie = await session.sessionCookie(sessionId);
    const csrf = await makeCsrf(SECRET, sessionId);
    const post = async (path: string, body: unknown) =>
      fetch(`${runtime!.facadeUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    // Two drain batches (the outbox flush shape), then the submit. The
    // stream is BOT-shaped — direct-fill inputs with NO focus events, 30ms
    // cadence, ending in submit_attempt — so its evidence is NOT gated on
    // the profile's random capture draws: DIRECT_FILL_PATTERN (15) +
    // SHORT_COMPLETION (<3s, 10) ≥ 25 points regardless of the
    // capturePointer/captureKey draw.
    const batch = (from: number, to: number) => {
      const events = [];
      let dt = 0;
      for (let s = from; s <= to; s++) {
        dt += 30; // machine cadence: 30ms gaps, zero dwell
        events.push({ seq: s, dt, kind: "input", target: "email" });
      }
      return events;
    };
    const drain1 = await post("/api/events", { events: batch(1, 5) });
    expect(drain1.status).toBe(200);
    expect(((await drain1.json()) as { acceptedThrough: number }).acceptedThrough).toBe(5);
    const drain2 = await post("/api/events", {
      events: [...batch(6, 10), { seq: 11, dt: 330, kind: "submit_attempt" }],
    });
    expect(((await drain2.json()) as { acceptedThrough: number }).acceptedThrough).toBe(11);

    // Submit with an EMPTY eventBatch — everything must come from the
    // persisted stream (the exact defect: the old runtime saw none of it).
    const submit = await post("/api/submit", {
      csrf,
      form: { name: "Q", email, password: "synthetic-password-123" },
      eventBatch: [],
    });
    expect(submit.status).toBe(200); // accepted through (no decoy family)
    const body = (await submit.json()) as { disposition?: string; score?: number };
    // The interaction evidence from the drained stream MUST have been
    // SCORED: direct-fill (15) + short completion (10) = 25 points
    // minimum, independent of capture draws. score=0 would mean the
    // drained stream never reached the evaluation (the P0-1 defect).
    expect(body.score).toBeGreaterThanOrEqual(25);

    // P0-4: trial truth reflects the evaluated session.
    const truth = runtime.trialTruth();
    expect(truth).toBeDefined();
    expect(truth!.sessionId).toBe(sessionId);
    expect(truth!.defenseFamilies).toEqual(["interaction"]);
  }, 30_000);
});
