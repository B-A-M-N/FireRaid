/**
 * FR-P1-11 — a request-scoped deadline that custom host adapters cannot ignore.
 *
 * A host adapter is arbitrary code; if its accept/verify/allow/etc. hangs, the
 * request would hang with it. The middleware OWNS a per-request deadline it
 * races every adapter await against (an adapter that ignores the AbortSignal
 * cannot hang the request past the budget) and passes the signal INTO each
 * adapter so a cooperative host cancels its own I/O. A deadline expiry is a
 * fail-closed operational/transport error — never a hang, never a partial
 * forward, never a false created-receipt.
 */
import { describe, it, expect } from "vitest";
import { DeadlineSignal, DeadlineError, DEFAULT_ADAPTER_CALL_TIMEOUT_MS } from "../../src/host-adapter/deadline.js";
import {
  createFireRaidMiddleware,
  ReferenceSessionAdapter,
  referenceInject,
  type MiddlewareDeps,
  type MiddlewareRouteConfig,
} from "../../src/host-adapter/index.js";
import { admit } from "../../src/host-adapter/middleware.js";
import { DurableCanaryStore, DurableSubmissionStore } from "./helpers/durable-stores.js";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"></form><body></body>';

const ROUTES: MiddlewareRouteConfig = {
  applicationPage: "/signup",
  applicationSubmit: "/api/submit",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

function baseDeps(over: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://upstream/api/register",
    session: new ReferenceSessionAdapter(SECRET),
    render: { inject: (h, p, c, l, o) => referenceInject(h, p, c, l, o) },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: {
      durability: "durable",
      accept: async () => ({ kind: "accepted" as const, received: 0, acceptedThrough: -1, duplicate: true }),
      collect: async () => [],
    },
    enforcement: { allow: async () => true, deny: () => {} },
    canaryStore: new DurableCanaryStore(),
    submissionStore: new DurableSubmissionStore(),
    enforcementMode: "enforcement",
    ...over,
  };
}

describe("FR-P1-11: DeadlineSignal races a hanging promise", () => {
  it("rejects with DeadlineError when a never-resolving promise exceeds the budget", async () => {
    const d = new DeadlineSignal(30);
    const hang = new Promise<never>(() => {});
    await expect(d.run(hang)).rejects.toBeInstanceOf(DeadlineError);
  });

  it("resolves the value when the promise lands before the deadline", async () => {
    const d = new DeadlineSignal(10_000);
    await expect(d.run(Promise.resolve(42))).resolves.toBe(42);
  });

  it("accepts a void result (HostEnforcementAdapter.deny shape)", async () => {
    const d = new DeadlineSignal(10_000);
    await expect(d.run(Promise.resolve())).resolves.toBeUndefined();
  });

  it("the deadline signal fires when the budget elapses", async () => {
    const d = new DeadlineSignal(25);
    let aborted = false;
    d.signal.addEventListener("abort", () => { aborted = true; });
    await d.run(new Promise<never>(() => {})).catch(() => {});
    expect(aborted).toBe(true);
    expect(DEFAULT_ADAPTER_CALL_TIMEOUT_MS).toBe(10_000);
  });
});

describe("FR-P1-11: a hanging telemetry adapter cannot hang the ingest path", () => {
  it("returns a fail-closed operational error inside the budget instead of hanging", async () => {
    // The telemetry adapter never resolves — a pathological custom host store.
    const deps = baseDeps({
      routes: ROUTES,
      adapterTimeoutMs: 40,
      telemetry: {
        durability: "durable" as const,
        accept: () => new Promise<never>(() => {}),
        collect: async () => [],
      },
    });
    const mw = createFireRaidMiddleware(deps);
    const session = new ReferenceSessionAdapter(SECRET);
    const sid = await session.createSession();
    const cookie = await session.sessionCookie(sid);

    const start = Date.now();
    // Because accept never resolves, the deadline must bound the call and
    // yield a handler result — not an unhandled rejection, not a hang.
    const res = await admit(
      new Request("http://mw/api/events", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ events: [{ seq: 0, dt: 0, kind: "focus", target: "b" }] }),
      }),
      mw,
      async () => SIGNUP_HTML
    );
    const elapsed = Date.now() - start;
    expect(res.kind).toBe("error");
    expect(res.operationalReason).toBe("INGEST_ADAPTER_DEADLINE");
    // Bound: the request must have returned well inside the default budget,
    // proving the deadline (not a hang) constrained it.
    expect(elapsed).toBeLessThan(5_000);
  });
});