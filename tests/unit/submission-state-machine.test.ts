/**
 * FR-RR-40 / FR-RR-41 — the submission store is a STATE MACHINE:
 *
 *   NONE ─claim──────────────────→ FORWARD_CLAIMED
 *                                   ├─ complete(terminal)  → TERMINAL
 *                                   └─ complete(uncertain) → FORWARD_UNCERTAIN
 *   NONE ─finalizeDecision───────→ TERMINAL (decision-denied)
 *
 * There is NO automatic transition out of FORWARD_CLAIMED or
 * FORWARD_UNCERTAIN into a decision denial. These tests use BARRIERS
 * (explicit phase control), never timing sleeps, to interleave:
 *
 *   1. A claims → stalls mid-forward; B finalizes a QUARANTINE decision
 *      → conflict(forward-claimed); A's claim survives; A completes
 *      created. The upstream truth WINS.
 *   2. B evaluates a deny on stale evidence while A already completed
 *      CREATED: B's finalizeDecision returns replay(CREATED) and B NEVER
 *      calls enforcement.deny — the durable record outranks the stale
 *      evaluation.
 *   3. A second decision finalizer on an existing decision record replays
 *      the EXACT original record (first writer wins).
 *   4. FORWARD_UNCERTAIN is ABSORBING: finalizeDecision → conflict, claim
 *      → conflict — only operator reconciliation may resolve it.
 *   5. A malformed finalizeDecision answer (JS host) fails closed: no
 *      deny, no projection completion, operational error.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  createFireRaidMiddleware,
  ReferenceSessionAdapter,
  referenceInject,
  type MiddlewareDeps,
  type MiddlewareRouteConfig,
} from "../../src/host-adapter/index.js";
import { submissionIdempotencyKey } from "../../src/host-adapter/interface.js";
import type {
  AssessmentSnapshot,
  FinalSubmissionRecord,
  HostSubmissionStore,
} from "../../src/host-adapter/interface.js";
import { denialIdempotencyKey, type EnforcementResult } from "../../src/host-adapter/interface.js";
import { DurableSubmissionStore, DurableCanaryStore } from "./helpers/durable-stores.js";
import { deriveProductionProfileByVersion } from "../../src/core/profile-versions.js";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"><input name="name"><input name="email"></form>';
const ROUTES: MiddlewareRouteConfig = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

function baseDeps(): MiddlewareDeps {
  return {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://127.0.0.1:1/register",
    session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
    render: { inject: referenceInject },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: {
      durability: "durable" as const,
      accept: async () => ({ kind: "accepted" as const, received: 0, acceptedThrough: -1, duplicate: true }),
      collect: async () => [],
    },
    enforcement: { allow: async (): Promise<EnforcementResult> => ({ kind: "created" }), deny: () => {} },
    canaryStore: new DurableCanaryStore(),
    submissionStore: new DurableSubmissionStore(),
    enforcementMode: "enforcement" as const,
    routes: ROUTES,
  } as unknown as MiddlewareDeps;
}

interface PostResult {
  kind: string;
  replayed?: boolean;
  upstreamCreated?: boolean;
  disposition?: string;
  forwardFailureReason?: string;
}

/** Full session: GET once (minting the cookie + CSRF), return a POST
 * driver bound to the validated middleware with a per-call store override,
 * plus the session id the cookie carries. `armRoute` probes the session's
 * decoy route first when the profile has one — verified Class-A evidence →
 * the POST decision is QUARANTINE. */
async function sessionDriver(
  deps: MiddlewareDeps,
  armRoute = false
): Promise<{
  post: (store: HostSubmissionStore) => Promise<PostResult>;
  sid: string;
  session: { cookie: string; csrf: string };
}> {
  const validated = createFireRaidMiddleware(deps);
  const load = async () => SIGNUP_HTML;
  const page = await admit(new Request("http://test/signup"), validated, load);
  expect(page.kind).toBe("get");
  let cookie = page.setCookie!.split(";")[0];
  let csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  let sid = decodeSessionId(cookie);
  if (armRoute) {
    // The production draw is route-less for a share of sessions — draw
    // (fresh GETs mint fresh sessions) until one is route-armed.
    for (let draws = 0; ; draws++) {
      const profile = await deriveProductionProfileByVersion({ secret: SECRET, version: VERSION, sessionId: sid });
      const token = profile.decoyRoute?.endpointToken;
      if (token) {
        const probe = await admit(
          new Request(`http://test/c/${token}`, { headers: { cookie } }),
          validated,
          load
        );
        expect(probe.kind).toBe("canary-verified");
        break;
      }
      expect(draws, "a route-armed session within 40 draws").toBeLessThan(40);
      const next = await admit(new Request("http://test/signup"), validated, load);
      expect(next.kind).toBe("get");
      cookie = next.setCookie!.split(";")[0];
      csrf = next.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      sid = decodeSessionId(cookie);
    }
  }
  const post = async (store: HostSubmissionStore): Promise<PostResult> => {
    (deps as { submissionStore: unknown }).submissionStore = store;
    return (await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      load
    )) as PostResult;
  };
  return { post, sid, session: { cookie, csrf } };
}

/** A RETRY driver: re-posts over an EXISTING session (same cookie + CSRF —
 * a client retry never mints a new session) against the SAME validated
 * middleware, with a per-call store override. */
async function retryDriverFor(
  deps: MiddlewareDeps,
  session: { cookie: string; csrf: string }
): Promise<(store: HostSubmissionStore) => Promise<PostResult>> {
  return async (store: HostSubmissionStore): Promise<PostResult> => {
    const validated = createFireRaidMiddleware(deps);
    (deps as { submissionStore: unknown }).submissionStore = store;
    return (await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: session.cookie },
        body: JSON.stringify({ csrf: session.csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      async () => SIGNUP_HTML
    )) as PostResult;
  };
}

/** Decode the sid from an issued session cookie (fr2 envelope: payload is
 * the middle dot-separated segment, base64url JSON). */
function decodeSessionId(cookie: string): string {
  const envelope = cookie.split("=").slice(1).join("=");
  const payload = envelope.split(".")[1];
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4), "=");
  const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { sid?: string };
  return json.sid ?? "";
}

/** Barrier: a promise the test resolves to release an awaited phase. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

function decisionRecord(sessionId: string, core: "REVIEW" | "QUARANTINE", runtime = core): FinalSubmissionRecord {
  return {
    version: 2,
    outcome: { kind: "decision-denied", disposition: runtime === "QUARANTINE" ? "QUARANTINE" : "REVIEW" },
    assessment: {
      sessionId,
      coreDisposition: core,
      runtimeDisposition: runtime as "REVIEW" | "QUARANTINE",
      score: 200,
      risk: { score: 200, tier: "CAUSAL", confidence: "HIGH", recommendedAction: "custom-review", evidence: [] },
    },
  };
}

function replayBarrierStore(record: FinalSubmissionRecord, source: "claim" | "finalize"): HostSubmissionStore {
  let projection: "pending" | "complete" = "pending";
  return {
    durability: "durable",
    lookupFinal: async () => null,
    claim: async () => source === "claim"
      ? { kind: "replay", record }
      : { kind: "conflict" },
    finalizeDecision: async () => source === "finalize"
      ? { kind: "replay", record }
      : { kind: "conflict", state: "forward-claimed" },
    complete: async () => {},
    denyProjectionState: async () => projection,
    markDenyProjectionComplete: async () => {
      projection = "complete";
    },
    reconcileUncertain: async () => ({ kind: "conflict", state: "not-uncertain" }),
  };
}

describe("FR-RR-40: finalizeDecision vs an in-flight forward claim", () => {
  it("INTERLEAVING 1: A claims and stalls mid-forward → B's finalizeDecision conflicts; A's claim survives and completes created", async () => {
    // A: claim succeeds, then allow() blocks on a gate we hold.
    // B: runs a decision finalize while A is mid-forward.
    const allowStarted = gate();
    const releaseAllow = gate();
    const deps = baseDeps();
    deps.onOperationalError = () => {};
    let allowCalls = 0;
    let denyCalls = 0;
    // A's store: a REAL state-machine store (claim opens FORWARD_CLAIMED)
    // whose claim the test inspects after B's finalize attempt.
    const storeA = new DurableSubmissionStore();
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        allowCalls++;
        allowStarted.release();
        await releaseAllow.promise;
        return { kind: "created" };
      },
      deny: () => {
        denyCalls++;
      },
    };
    const { post: postA, sid } = await sessionDriver(deps);

    // A starts; allow() blocks at the gate (claim already OPEN).
    const a = postA(storeA);
    await allowStarted.promise;

    // B: finalizes a QUARANTINE decision while A's forward is in flight.
    // A has NOT completed, so the store is FORWARD_CLAIMED — finalizeDecision
    // must return conflict, never "stored".
    const conflict = await storeA.finalizeDecision(sid, {
      version: 2,
      outcome: { kind: "decision-denied", disposition: "QUARANTINE" },
      assessment: {
        sessionId: sid,
        coreDisposition: "QUARANTINE",
        runtimeDisposition: "QUARANTINE",
        disposition: "QUARANTINE",
        score: 200,
        risk: { score: 200, tier: "CAUSAL", confidence: "HIGH", recommendedAction: "REJECT", evidence: [] },
      },
    });
    expect(conflict).toEqual({ kind: "conflict", state: "forward-claimed" });

    // B must not have projected a deny for this session (the coordinator's
    // conflict branch refuses deny-side effects; asserted again end-to-end
    // in INTERLEAVING 2 via the middleware plane).
    expect(denyCalls).toBe(0);

    // A's claim survives: release the gate, A completes created.
    releaseAllow.release();
    const aRes = await a;
    expect(aRes.kind).toBe("admit");
    expect(aRes.upstreamCreated).toBe(true);
    expect(allowCalls).toBe(1);
    expect(denyCalls).toBe(0);

    // The durable record is A's CREATED truth — B's denial never landed.
    const final = await storeA.lookupFinal(sid);
    expect(final?.outcome.kind).toBe("created");
  });

  it("INTERLEAVING 2: B evaluates a deny after A already completed CREATED → the coordinator replays CREATED; B never denies", async () => {
    // A: full ACCEPT → forward → created (durable). B: re-evaluates the
    // SAME session through the middleware with fresh "QUARANTINE-grade"
    // evidence and a deny-armed store — the coordinator must surface the
    // durable CREATED record (replay) and NEVER invoke deny.
    const deps = baseDeps();
    deps.onOperationalError = () => {};
    let denyCalls = 0;
    let allowCalls = 0;
    const durable = new DurableSubmissionStore();
    deps.submissionStore = durable;
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        allowCalls++;
        return { kind: "created" };
      },
      deny: () => {
        denyCalls++;
      },
    };
    const { post, sid } = await sessionDriver(deps);

    // A: full ACCEPT → forward → created.
    const aRes = await post(durable);
    expect(aRes.kind).toBe("admit");
    expect(aRes.upstreamCreated).toBe(true);
    expect(allowCalls).toBe(1);

    // B: a fresh POST over the SAME session. lookupFinal now returns A's
    // CREATED record — B replays it WITHOUT re-evaluating, so B never
    // reaches finalizeDecision and never denies. This is the coordinator's
    // replay contract: the durable record outranks any fresh evaluation.
    const bRes = await post(durable);
    expect(bRes.kind).toBe("admit");
    expect(bRes.replayed).toBe(true);
    expect(bRes.upstreamCreated).toBe(true);
    expect(denyCalls).toBe(0);
    expect(allowCalls).toBe(1); // only A ever forwarded

    // The same holds at the STORE contract level for a stale finalizer that
    // DOES reach finalizeDecision with a denial (e.g. a coordinator that
    // looked up before A completed): replay(CREATED), first writer wins.
    const stale = await durable.finalizeDecision(sid, {
      version: 2,
      outcome: { kind: "decision-denied", disposition: "QUARANTINE" },
      assessment: {
        sessionId: sid,
        coreDisposition: "QUARANTINE",
        runtimeDisposition: "QUARANTINE",
        disposition: "QUARANTINE",
        score: 200,
        risk: { score: 200, tier: "CAUSAL", confidence: "HIGH", recommendedAction: "REJECT", evidence: [] },
      },
    });
    expect(stale.kind).toBe("replay");
    expect(stale.kind === "replay" ? stale.record.outcome.kind : null).toBe("created");
    expect(denyCalls).toBe(0);
  });

  it("INTERLEAVING 3: a second decision finalizer replays the EXACT original record", async () => {
    const reference = new DurableSubmissionStore();
    const first: FinalSubmissionRecord = {
      version: 2,
      outcome: { kind: "decision-denied", disposition: "REVIEW" },
      assessment: {
        sessionId: "s",
        coreDisposition: "REVIEW",
        runtimeDisposition: "REVIEW",
        disposition: "REVIEW",
        score: 65,
        risk: { score: 65, tier: "ELEVATED", confidence: "HIGH", recommendedAction: "REVIEW", evidence: [] },
      },
    };
    const r1 = await reference.finalizeDecision("s", first);
    expect(r1.kind).toBe("stored");
    // A concurrent finalizer with a DIFFERENT record must not overwrite.
    const second: FinalSubmissionRecord = {
      version: 2,
      outcome: { kind: "decision-denied", disposition: "QUARANTINE" },
      assessment: {
        sessionId: "s",
        coreDisposition: "QUARANTINE",
        runtimeDisposition: "QUARANTINE",
        disposition: "QUARANTINE",
        score: 120,
        risk: { score: 120, tier: "HIGH", confidence: "HIGH", recommendedAction: "REJECT", evidence: [] },
      },
    };
    const r2 = await reference.finalizeDecision("s", second);
    expect(r2.kind).toBe("replay");
    if (r2.kind === "replay") {
      expect(r2.record).toEqual(first); // FIRST WRITER WINS, verbatim
    }
    const lookup = await reference.lookupFinal("s");
    expect(lookup).toEqual(first);
  });

  it("INTERLEAVING 5 (fail-closed): a malformed finalizeDecision answer (JS host) → no deny, no projection completion, operational error", async () => {
    // An ARMED session: verified decoy-route probe → the POST decision is
    // QUARANTINE → the coordinator reaches finalizeDecision on the deny
    // path. The store then answers with a malformed non-throwing value
    // (the JS-host case: no exception, garbage shape).
    const deps = baseDeps();
    const ops: string[] = [];
    deps.onOperationalError = (op) => ops.push(op);
    let denyCalls = 0;
    let projectionMarks = 0;
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        throw new Error("a QUARANTINE decision must never forward");
      },
      deny: () => {
        denyCalls++;
      },
    };
    const malformed: HostSubmissionStore = {
      durability: "durable" as const,
      claim: async (sid: string) => ({ kind: "claimed" as const, claimId: "c", idempotencyKey: submissionIdempotencyKey(sid) }),
      lookupFinal: async () => null,
      // JS host: answers 42 — no throw, no documented shape.
      finalizeDecision: async () => 42 as never,
      complete: async () => {},
      markDenyProjectionComplete: async () => {
        projectionMarks++;
      },
      denyProjectionState: async () => "pending" as const,
      reconcileUncertain: async () => ({ kind: "conflict", state: "not-uncertain" } as const),
    };
    const { post } = await sessionDriver(deps, true);
    const r = await post(malformed);
    expect(r.kind).toBe("forward-failed");
    expect(r.forwardFailureReason).toBe("submission_decision_finalize_failed");
    expect(denyCalls).toBe(0); // no deny side effect
    expect(projectionMarks).toBe(0); // no projection completion
    expect(ops.some((o) => o.includes("submissionStore.finalizeDecision"))).toBe(true);
  });
});

describe("FR-RR-42: the deny is a repairable PROJECTION of the durable record", () => {
  /** An armed (QUARANTINE-deciding) session driver with an instrumented
   * deny seam. denyMode: "ok" | "throw" — the failure under repair. */
  async function armedDriver(denyMode: "ok" | "throw") {
    const deps = baseDeps();
    const denyCalls: string[] = [];
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        throw new Error("a QUARANTINE decision must never forward");
      },
      deny: (sessionId: string) => {
        denyCalls.push(sessionId);
        if (denyMode === "throw") throw new Error("host queue outage");
      },
    };
    const { post, sid, session } = await sessionDriver(deps, true);
    return { deps, post, sid, session, denyCalls };
  }

  it("first request: finalizeDecision durable + deny throws → 5xx forward-failed; the record survives with a PENDING projection", async () => {
    const { deps, post, sid, denyCalls } = await armedDriver("throw");
    deps.onOperationalError = () => {};
    const store = new DurableSubmissionStore();
    const r = await post(store);
    // The request does NOT acknowledge: the host queue annotation failed.
    expect(r.kind).toBe("forward-failed");
    expect(r.forwardFailureReason).toBe("submission_deny_projection_failed");
    expect(denyCalls).toEqual([sid]); // exactly one deny attempt

    // The DURABLE half of the transaction landed: terminal decision record…
    const rec = await store.lookupFinal(sid);
    expect(rec?.outcome.kind).toBe("decision-denied");
    // …with its deny projection still PENDING — the honest durable state.
    expect(await store.denyProjectionState!(sid)).toBe("pending");
  });

  it("retry: pending projection is REPAIRED (idempotent re-deny + completion mark) BEFORE the receipt acknowledges", async () => {
    const first = await armedDriver("throw");
    first.deps.onOperationalError = () => {};
    const store = new DurableSubmissionStore();
    const r1 = await first.post(store);
    expect(r1.forwardFailureReason).toBe("submission_deny_projection_failed");
    expect(await store.denyProjectionState!(first.sid)).toBe("pending");

    // Retry: the deny seam is HEALTHY now (the outage ended). The SAME
    // session cookie re-posts; the coordinator replays the stored record,
    // sees the pending projection, re-projects (idempotent), marks
    // complete, and only THEN acknowledges.
    const retryDeps = first.deps;
    const enforcement = retryDeps.enforcement as unknown as {
      deny: (sessionId: string) => void;
    };
    enforcement.deny = (sessionId: string) => {
      first.denyCalls.push(sessionId); // healthy: no throw
    };
    const retry = await retryDriverFor(retryDeps, first.session);
    const r2 = await retry(store);
    expect(r2.kind).toBe("deny"); // the replayed ORIGINAL denial
    expect(r2.replayed).toBe(true);
    // The repair ran: a SECOND deny (idempotent re-projection) landed.
    expect(first.denyCalls.length).toBe(2);
    expect(first.denyCalls[1]).toBe(first.sid);
    // And the projection is complete — a THIRD retry finds nothing to do.
    expect(await store.denyProjectionState!(first.sid)).toBe("complete");
  });

  it("no acknowledgement while the projection fails: a retry with the seam STILL down keeps failing closed", async () => {
    const first = await armedDriver("throw");
    first.deps.onOperationalError = () => {};
    const store = new DurableSubmissionStore();
    const r1 = await first.post(store);
    expect(r1.forwardFailureReason).toBe("submission_deny_projection_failed");

    // Retry with the deny seam STILL broken: repair fails → fail closed
    // again. The applicant is NEVER acked while the host record is missing.
    const retry = await retryDriverFor(first.deps, first.session);
    const r2 = await retry(store);
    expect(r2.kind).toBe("forward-failed");
    expect(r2.forwardFailureReason).toBe("submission_deny_projection_failed");
    expect(first.denyCalls.length).toBe(2); // a repair attempt WAS made
    expect(await store.denyProjectionState!(first.sid)).toBe("pending");
  });
});

describe("FR-RR-42 barrier coverage: every replay surface repairs pending deny projection", () => {
  for (const source of ["finalize", "claim"] as const) {
    it(`${source} replay: idempotent deny completes before the receipt`, async () => {
      const deps = baseDeps();
      deps.onOperationalError = () => {};
      let denyCalls = 0;
      let observedKey = "";
      deps.enforcement = {
        allow: async (): Promise<EnforcementResult> => {
          throw new Error("replay must never forward");
        },
        deny: (
          _sessionId: string,
          _reason: string,
          _annotation: object | undefined,
          _signal: AbortSignal | undefined,
          opts: { idempotencyKey: string }
        ) => {
          denyCalls++;
          observedKey = opts.idempotencyKey;
        },
      };
      const { post, sid } = await sessionDriver(deps, source === "finalize");
      const record = decisionRecord(sid, "QUARANTINE");
      const result = await post(replayBarrierStore(record, source));
      expect(result.kind).toBe("deny");
      expect(result.replayed).toBe(true);
      expect(denyCalls).toBe(1);
      expect(observedKey).toBe(denialIdempotencyKey(sid));
    });
  }
});

describe("FR-RR-41: FORWARD_UNCERTAIN is absorbing", () => {
  it("finalizeDecision on an uncertain session → conflict(forward-uncertain); claim → conflict; nothing resolves it automatically", async () => {
    const reference = new DurableSubmissionStore();
    // Drive the state machine to FORWARD_UNCERTAIN via a real claim+complete.
    const claim = await reference.claim("s1", submissionIdempotencyKey("s1"));
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await reference.complete(claim.claimId, { kind: "transport-failure", reason: "timeout", uncertain: true });

    // lookupFinal: NO final record — the upstream truth is unknown.
    expect(await reference.lookupFinal("s1")).toBeNull();

    // A later deny evaluation must NOT convert unknown → blocked.
    const r = await reference.finalizeDecision("s1", {
      version: 2,
      outcome: { kind: "decision-denied", disposition: "QUARANTINE" },
      assessment: {
        sessionId: "s1",
        coreDisposition: "QUARANTINE",
        runtimeDisposition: "QUARANTINE",
        disposition: "QUARANTINE",
        score: 200,
        risk: { score: 200, tier: "CAUSAL", confidence: "HIGH", recommendedAction: "REJECT", evidence: [] },
      },
    });
    expect(r).toEqual({ kind: "conflict", state: "forward-uncertain" });

    // Still absorbing: retries conflict; no record materializes.
    expect(await reference.lookupFinal("s1")).toBeNull();
    const c = await reference.claim("s1", submissionIdempotencyKey("s1"));
    expect(c.kind).toBe("conflict");

    const assessment: AssessmentSnapshot = {
      sessionId: "s1",
      coreDisposition: "QUARANTINE",
      runtimeDisposition: "QUARANTINE",
      score: 200,
      risk: { score: 200, tier: "CAUSAL", confidence: "HIGH", recommendedAction: "operator-confirmed", evidence: [] },
    };
    const reconciled = await reference.reconcileUncertain(
      "s1",
      { kind: "created", assessment },
      "operator@example.invalid"
    );
    expect(reconciled.kind).toBe("created");
    if (reconciled.kind === "created") {
      expect(reconciled.record.outcome).toEqual({ kind: "created" });
      expect(reconciled.audit).toMatchObject({
        actor: "operator@example.invalid",
        oldState: "forward-uncertain",
        newState: "terminal",
      });
    }
    expect(await reference.lookupFinal("s1")).toEqual({ version: 2, outcome: { kind: "created" }, assessment });
    expect(reference.reconciliationFor("s1")?.actor).toBe("operator@example.invalid");
  });

  it("operator reconciliation can release only with explicit not-created evidence and leaves an audit", async () => {
    const reference = new DurableSubmissionStore();
    const claim = await reference.claim("s2", submissionIdempotencyKey("s2"));
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await reference.complete(claim.claimId, { kind: "transport-failure", reason: "timeout", uncertain: true });
    const released = await reference.reconcileUncertain(
      "s2",
      { kind: "not-created-release", reason: "upstream ledger lookup: no matching idempotency key" },
      "operator@example.invalid"
    );
    expect(released.kind).toBe("released");
    expect(await reference.lookupFinal("s2")).toBeNull();
    expect((await reference.claim("s2", submissionIdempotencyKey("s2"))).kind).toBe("claimed");
    expect(reference.reconciliationFor("s2")).toMatchObject({
      actor: "operator@example.invalid",
      oldState: "forward-uncertain",
      newState: "none",
      reason: "upstream ledger lookup: no matching idempotency key",
    });
  });
});

describe("FR-RR-55: the snapshot models BOTH the core and runtime dispositions", () => {
  /** Drive an armed QUARANTINE-grade session to a terminal decision and
   * capture the durable record. mode: the deployment posture. riskTiers:
   * an optional custom tier map. */
  async function captureSnapshot(
    mode: "review" | "enforcement",
    riskTiers?: unknown
  ): Promise<{ record: FinalSubmissionRecord; sid: string; store: DurableSubmissionStore }> {
    const deps = baseDeps();
    deps.enforcementMode = mode;
    if (riskTiers) (deps as { riskTiers?: unknown }).riskTiers = riskTiers;
    deps.onOperationalError = () => {};
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        throw new Error("a decision denial must never forward");
      },
      deny: () => {},
    };
    const store = new DurableSubmissionStore();
    const { post, sid } = await sessionDriver(deps, true);
    const r = await post(store);
    expect(r.kind, `armed session must decide a denial (${mode})`).toBe("deny");
    const record = await store.lookupFinal(sid);
    expect(record).not.toBeNull();
    return { record: record as FinalSubmissionRecord, sid, store };
  }

  it("review mode: core QUARANTINE → runtime REVIEW; the record carries BOTH", async () => {
    const { record } = await captureSnapshot("review");
    expect(record.assessment.coreDisposition).toBe("QUARANTINE"); // core call
    expect(record.assessment.runtimeDisposition).toBe("REVIEW"); // enforced form
    expect(record.outcome.kind).toBe("decision-denied");
    if (record.outcome.kind === "decision-denied") {
      expect(record.outcome.disposition).toBe("REVIEW"); // the ACTUAL action
    }
  });

  it("enforcement + default tiers: a CAUSAL-band score auto-suppresses → runtime QUARANTINE matches the core call", async () => {
    const { record } = await captureSnapshot("enforcement");
    // A verified route hit is Class-A (weight 100). Under the DEFAULT map
    // the 100–200 band is HIGH (autoSuppress:false) → REVIEW; only ≥ 200
    // is CAUSAL → QUARANTINE. The pair must be coherent either way.
    if ((record.assessment.score ?? 0) >= 200) {
      expect(record.assessment.runtimeDisposition).toBe("QUARANTINE");
      if (record.outcome.kind === "decision-denied") {
        expect(record.outcome.disposition).toBe("QUARANTINE");
      }
    } else {
      expect(record.assessment.runtimeDisposition).toBe("REVIEW");
    }
    expect(record.assessment.coreDisposition).toBe("QUARANTINE"); // the core call
  });

  it("a CUSTOM tier map with autoSuppress at a low band → runtime QUARANTINE on a core REVIEW", async () => {
    // Tier map: everything ≥ 50 suppresses automatically. A strong Class-B
    // REVIEW (score 60–100) then lands runtime QUARANTINE.
    const { record } = await captureSnapshot("enforcement", [
      { minScore: 0, maxScore: 50, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
      { minScore: 50, maxScore: null, tier: "CAUSAL", recommendedAction: "QUARANTINE", autoSuppress: true },
    ]);
    expect(record.assessment.coreDisposition).toBe("QUARANTINE"); // core call
    expect(record.assessment.runtimeDisposition).toBe("QUARANTINE"); // custom map suppressed
    if (record.outcome.kind === "decision-denied") {
      expect(record.outcome.disposition).toBe("QUARANTINE"); // the ACTUAL action
    }
  });

  it("replay fidelity: a stored snapshot reproduces the SAME pair on the replay receipt", async () => {
    const { record, sid, store } = await captureSnapshot("review");
    expect(record.assessment.runtimeDisposition).toBe("REVIEW");
    // The replay surface (replayReceipt via lookupFinal semantics) reads
    // the SAME stored record: the pair is what any retry re-sees.
    const again = await store.lookupFinal(sid);
    expect(again).toEqual(record); // first writer wins, verbatim
    expect(again?.assessment.runtimeDisposition).toBe("REVIEW");
    expect(again?.assessment.coreDisposition).toBe("QUARANTINE");
  });
});
