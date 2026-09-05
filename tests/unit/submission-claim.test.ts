/**
 * FR-P0-02 — one session, one irreversible forward.
 *
 * The submission-store contract: claim BEFORE the forward, complete AFTER,
 * replay for a lost-response retry, conflict for a concurrent submit. The
 * race and lost-response shapes here are the exact scenarios the audit
 * flagged: a client retry after a lost response (or two concurrent submits)
 * previously re-called the upstream and could create TWO accounts for one
 * session.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  createFireRaidMiddleware,
  ReferenceSessionAdapter,
  ReferenceSubmissionStore,
  referenceInject,
  type MiddlewareDeps,
  type MiddlewareRouteConfig,
} from "../../src/host-adapter/index.js";
import { ReferenceEnforcementAdapter } from "../../src/host-adapter/reference-adapters.js";
import { submissionIdempotencyKey } from "../../src/host-adapter/interface.js";
import type { EnforcementResult } from "../../src/host-adapter/interface.js";
import { DurableCanaryStore, DurableSubmissionStore } from "./helpers/durable-stores.js";
import { createServer } from "node:http";

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
      durability: "durable", // FR-P1-03: the production path demands durable evidence stores
      accept: async () => ({ kind: "accepted" as const, received: 0, acceptedThrough: -1, duplicate: true }),
      collect: async () => [],
    },
    enforcement: new ReferenceEnforcementAdapter(),
    canaryStore: new DurableCanaryStore(), // durability:"durable" — see helpers/durable-stores
    submissionStore: new DurableSubmissionStore(), // durability:"durable"
    enforcementMode: "enforcement" as const,
    routes: ROUTES,
  } as MiddlewareDeps;
}

/** One browser session: GET once, then POST n times with the SAME cookie. */
async function session(
  deps: MiddlewareDeps,
  overrides: { enforcement?: unknown } = {}
): Promise<(n?: number) => Promise<{ kind: string; upstreamCreated?: boolean; forwardFailureReason?: string }>> {
  const validated = createFireRaidMiddleware(
    overrides.enforcement !== undefined
      ? ({ ...deps, enforcement: overrides.enforcement } as MiddlewareDeps)
      : deps
  );
  const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
  expect(page.kind).toBe("get");
  const cookie = page.setCookie!.split(";")[0];
  const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return async (n = 1) => {
    const result = await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      async () => SIGNUP_HTML
    );
    void n;
    return result as { kind: string; upstreamCreated?: boolean; forwardFailureReason?: string };
  };
}

/** Full session via admit(): GET → cookie+csrf, POST → submit result. */
async function submit(
  deps: MiddlewareDeps,
  overrides: { enforcement?: unknown } = {}
): Promise<{ kind: string; upstreamCreated?: boolean; forwardFailureReason?: string }> {
  const post = await session(deps, overrides);
  return post();
}

describe("FR-P0-02: lost-response replay", () => {
  it("a second POST after a successful forward replays WITHOUT calling the upstream again", async () => {
    let forwards = 0;
    const upstream = createServer((_req, res) => {
      forwards++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });
    const port: number = await new Promise((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port));
    });
    const deps = baseDeps();
    deps.upstreamRegisterUrl = `http://127.0.0.1:${port}/register`;
    try {
      const post = await session(deps);
      const first = await post();
      expect(first.kind).toBe("admit");
      expect(first.upstreamCreated).toBe(true);
      expect(forwards).toBe(1);

      // The client's response was lost; the same session re-POSTs. The
      // middleware must return the STORED outcome — no second forward.
      const second = await post();
      expect(second.kind).toBe("admit");
      expect(second.upstreamCreated).toBe(true);
      expect(forwards, "upstream must see exactly ONE forward per session").toBe(1);
    } finally {
      upstream.close();
    }
  });

  it("a second POST after business-rejected replays the rejection without re-forwarding", async () => {
    let forwards = 0;
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        forwards++;
        return { kind: "business-rejected", status: 409 };
      },
      deny: () => {},
    };
    const deps = baseDeps();
    const post = await session(deps, { enforcement });
    const first = await post();
    expect(first.kind).toBe("admit");
    expect(first.upstreamCreated).toBe(false);
    const second = await post();
    expect(second.kind).toBe("admit");
    expect(second.upstreamCreated).toBe(false);
    expect(forwards).toBe(1);
  });
});

describe("FR-P0-02: concurrent submits", () => {
  it("two simultaneous submissions of one session produce exactly ONE forward", async () => {
    let forwards = 0;
    // Slow the upstream slightly so both requests are genuinely in flight.
    const upstream = createServer((_req, res) => {
      forwards++;
      setTimeout(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end("{}");
      }, 25);
    });
    const port: number = await new Promise((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port));
    });
    const deps = baseDeps();
    deps.upstreamRegisterUrl = `http://127.0.0.1:${port}/register`;
    try {
      const validated = createFireRaidMiddleware(deps);
      const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
      const cookie = page.setCookie!.split(";")[0];
      const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";

      const req = () =>
        admit(
          new Request("http://test/signup", {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
          }),
          validated,
          async () => SIGNUP_HTML
        );
      const [a, b] = await Promise.all([req(), req()]);
      const kinds = [a.kind, b.kind].sort();
      // One owns the forward (admit), the other is refused closed
      // (forward-failed — the applicant may retry after the winner lands).
      expect(kinds).toEqual(["admit", "forward-failed"]);
      expect(forwards, "exactly one upstream forward for the session").toBe(1);
      expect(a.upstreamCreated ?? b.upstreamCreated).toBe(true);
    } finally {
      upstream.close();
    }
  });
});

describe("FR-P0-02: transport-failure releases the claim", () => {
  it("a genuine retry after a recorded transport failure re-attempts the forward", async () => {
    let calls = 0;
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        calls++;
        return calls === 1
          ? { kind: "transport-failure", reason: "upstream_503" }
          : { kind: "created" };
      },
      deny: () => {},
    };
    const deps = baseDeps();
    const post = await session(deps, { enforcement });
    const first = await post();
    expect(first.kind).toBe("forward-failed");
    expect(first.forwardFailureReason).toBe("upstream_503");

    // The upstream captured nothing — the client's legitimate retry may
    // re-attempt, and this time it is created.
    const second = await post();
    expect(second.kind).toBe("admit");
    expect(second.upstreamCreated).toBe(true);
    expect(calls).toBe(2);

    // And the created outcome is now durable: a THIRD post replays it.
    const third = await post();
    expect(third.kind).toBe("admit");
    expect(third.upstreamCreated).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("FR-P0-02: fail-closed claim store", () => {
  it("a claim store that THROWS fails closed (forward-failed, never forwarded)", async () => {
    let forwarded = false;
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        forwarded = true;
        return { kind: "created" };
      },
      deny: () => {},
    };
    const deps = baseDeps();
    (deps as { submissionStore: unknown }).submissionStore = {
      claim: async () => {
        throw new Error("storage outage");
      },
      complete: async () => {},
    };
    const r = await submit(deps, { enforcement });
    expect(r.kind).toBe("forward-failed");
    expect(forwarded).toBe(false);
  });

  it("a claim store returning a MALFORMED shape fails closed", async () => {
    let forwarded = false;
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        forwarded = true;
        return { kind: "created" };
      },
      deny: () => {},
    };
    const deps = baseDeps();
    (deps as { submissionStore: unknown }).submissionStore = {
      claim: async () => ({ ok: true }) as unknown as never,
      complete: async () => {},
    };
    const r = await submit(deps, { enforcement });
    expect(r.kind).toBe("forward-failed");
    expect(forwarded).toBe(false);
  });

  it("complete() failing after a CREATED forward fails the receipt (never a silent ack)", async () => {
    let forwarded = false;
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        forwarded = true;
        return { kind: "created" };
      },
      deny: () => {},
    };
    const deps = baseDeps();
    (deps as { submissionStore: unknown }).submissionStore = {
      claim: async () => ({ kind: "claimed", claimId: "c1", idempotencyKey: "k1" }),
      complete: async () => {
        throw new Error("durable write failed");
      },
    };
    const r = await submit(deps, { enforcement });
    // The upstream MAY have created the account, but the durable record
    // does not exist — the middleware must NOT ack (FR-INV-008: a success
    // receipt requires the application to be durably somewhere FireRaid
    // knows about). The un-completed claim also still guards the session.
    expect(r.kind).toBe("forward-failed");
    expect(r.forwardFailureReason).toBe("submission_complete_failed");
    expect(forwarded).toBe(true);
  });
});

describe("FR-P0-02: deterministic idempotency key", () => {
  it("submissionIdempotencyKey is stable per session and distinct across sessions", () => {
    expect(submissionIdempotencyKey("abc")).toBe(submissionIdempotencyKey("abc"));
    expect(submissionIdempotencyKey("abc")).not.toBe(submissionIdempotencyKey("abd"));
  });

  it("the ReferenceSubmissionStore surfaces the key on claim", async () => {
    const store = new ReferenceSubmissionStore();
    const c = await store.claim("sess-1", submissionIdempotencyKey("sess-1"));
    expect(c.kind).toBe("claimed");
    if (c.kind === "claimed") {
      expect(c.idempotencyKey).toBe(submissionIdempotencyKey("sess-1"));
    }
  });
});

describe("FR-P0-02: factory validation", () => {
  it("createFireRaidMiddleware REJECTS a deps without submissionStore", () => {
    const deps = baseDeps();
    delete (deps as { submissionStore?: unknown }).submissionStore;
    expect(() => createFireRaidMiddleware(deps)).toThrow(/submissionStore is REQUIRED/);
  });

  it("createFireRaidMiddleware REJECTS a submissionStore missing claim/complete", () => {
    const deps = baseDeps();
    (deps as { submissionStore: unknown }).submissionStore = { claim: async () => ({ kind: "conflict" }) };
    expect(() => createFireRaidMiddleware(deps)).toThrow(/must implement complete/);
  });
});
