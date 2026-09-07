/**
 * FR-RR-22 / FR-RR-23 — the host submission store is an UNTRUSTED runtime
 * seam. TypeScript unions protect nothing at runtime: a JavaScript host can
 * return anything from claim()/lookupFinal()/complete(). These tests drive
 * the coordinator with RAW JS-shaped values and pin the invariant that
 * every malformed answer fails CLOSED with ZERO upstream calls — never a
 * forward, never a fabricated receipt.
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
import type { EnforcementResult } from "../../src/host-adapter/interface.js";
import {
  parseFinalSubmissionOutcome,
  parseStoredRecord,
} from "../../src/host-adapter/submission/store-parsers.js";
import { DurableCanaryStore, DurableSubmissionStore } from "./helpers/durable-stores.js";

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

/** Full session (GET → cookie/csrf) returning a POST driver bound to a
 * coordinator whose submissionStore the test controls per attempt. */
async function sessionDriver(deps: MiddlewareDeps) {
  const validated = createFireRaidMiddleware(deps);
  const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
  expect(page.kind).toBe("get");
  const cookie = page.setCookie!.split(";")[0];
  const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return async (store: unknown) => {
    (deps as { submissionStore: unknown }).submissionStore = store;
    return admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      async () => SIGNUP_HTML
    ) as Promise<{ kind: string; upstreamCreated?: boolean; forwardFailureReason?: string }>;
  };
}

describe("FR-RR-22: malformed claim results never reach the upstream", () => {
  const MALFORMED: Array<[string, unknown]> = [
    ["claimed without claimId", { kind: "claimed" }],
    ["claimed with empty claimId", { kind: "claimed", claimId: "" }],
    ["claimed with non-string claimId", { kind: "claimed", claimId: 42 }],
    ["claimed without idempotencyKey", { kind: "claimed", claimId: "x" }],
    ["claimed with the WRONG idempotencyKey", { kind: "claimed", claimId: "x", idempotencyKey: "wrong" }],
    ["legacy replay shape (outcome field)", { kind: "replay", outcome: { kind: "created" } }],
    ["replay without a record", { kind: "replay" }],
    ["replay with an unparseable record", { kind: "replay", record: { nonsense: true } }],
    ["invented kind", { kind: "something-else" }],
    ["null", null],
    ["true", true],
    ["bare string", "claimed"],
    ["undefined", undefined],
  ];

  for (const [name, value] of MALFORMED) {
    it(`claim() → ${name} fails closed: zero upstream calls, no receipt`, async () => {
      let upstreamCalls = 0;
      const deps = baseDeps();
      deps.onOperationalError = () => {}; // the malformed answers are EXPECTED noise here
      deps.enforcement = {
        allow: async (): Promise<EnforcementResult> => {
          upstreamCalls++;
          return { kind: "created" };
        },
        deny: () => {},
      };
      const post = await sessionDriver(deps);
      const r = await post({
        durability: "durable",
        claim: async () => value,
        complete: async () => {},
      });
      expect(r.kind, name).toBe("forward-failed");
      expect(r.forwardFailureReason, name).toBe("submission_claim_invalid");
      expect(upstreamCalls, `${name}: the forward must never proceed`).toBe(0);
    });
  }

  it("a well-formed claim with the EXACT requested key proceeds (control)", async () => {
    let upstreamCalls = 0;
    const deps = baseDeps();
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        upstreamCalls++;
        return { kind: "created" };
      },
      deny: () => {},
    };
    const post = await sessionDriver(deps);
    const r = await post({
      durability: "durable",
      claim: async (sid: string) => ({
        kind: "claimed",
        claimId: "c1",
        idempotencyKey: submissionIdempotencyKey(sid),
      }),
      complete: async () => {},
    });
    expect(r.kind).toBe("admit");
    expect(upstreamCalls).toBe(1);
  });
});

describe("FR-RR-23: malformed replay records never fabricate a receipt", () => {
  const BAD_RECORDS: Array<[string, unknown]> = [
    ["invented outcome kind", { version: 2, outcome: { kind: "fabricated-success" }, assessment: {} }],
    ["outcome missing", { version: 2, assessment: {} }],
    ["transport-failure replayed as terminal", { version: 2, outcome: { kind: "transport-failure", reason: "x" }, assessment: {} }],
    ["business-rejected with a 5xx status", { version: 2, outcome: { kind: "business-rejected", status: 503 }, assessment: {} }],
    ["business-rejected with NaN status", { version: 2, outcome: { kind: "business-rejected", status: "NaN" }, assessment: {} }],
    ["queued-for-retry without retryId", { version: 2, outcome: { kind: "queued-for-retry" }, assessment: {} }],
    ["decision-denied with an invented disposition", { version: 2, outcome: { kind: "decision-denied", disposition: "MAYBE" }, assessment: {} }],
    ["v2 record without an assessment", { version: 2, outcome: { kind: "created" } }],
    ["assessment for the WRONG session", { version: 2, outcome: { kind: "created" }, assessment: { sessionId: "other", disposition: "ACCEPT", score: 0, risk: { score: 0, tier: "low", confidence: "high", recommendedAction: "accept", evidence: [] } } }],
  ];

  for (const [name, record] of BAD_RECORDS) {
    it(`lookupFinal → ${name} fails closed: zero upstream calls, no receipt`, async () => {
      let upstreamCalls = 0;
      const deps = baseDeps();
      deps.onOperationalError = () => {};
      deps.enforcement = {
        allow: async (): Promise<EnforcementResult> => {
          upstreamCalls++;
          return { kind: "created" };
        },
        deny: () => {},
      };
      const post = await sessionDriver(deps);
      const r = await post({
        durability: "durable",
        lookupFinal: async () => record,
        claim: async () => ({ kind: "claimed", claimId: "c", idempotencyKey: "k" }),
        complete: async () => {},
      });
      expect(r.kind, name).toBe("forward-failed");
      expect(r.forwardFailureReason, name).toBe("submission_claim_invalid");
      expect(upstreamCalls, `${name}: the forward must never proceed`).toBe(0);
    });
  }

  it("a VALID v2 record with a full assessment replays WITHOUT an upstream call (control)", async () => {
    let upstreamCalls = 0;
    const deps = baseDeps();
    deps.enforcement = {
      allow: async (): Promise<EnforcementResult> => {
        upstreamCalls++;
        return { kind: "created" };
      },
      deny: () => {},
    };
    // Decode the session id from the GET-issued envelope so the snapshot
    // names the RIGHT session (parseAssessment checks sessionId equality).
    let capturedSid = "";
    const validated = createFireRaidMiddleware(deps);
    const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
    expect(page.kind).toBe("get");
    const cookie = page.setCookie!.split(";")[0];
    const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    {
      const envelope = cookie.split("=").slice(1).join("=");
      const payload = JSON.parse(
        Buffer.from(envelope.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
      ) as { sid: string };
      capturedSid = payload.sid;
    }
    (deps as { submissionStore: unknown }).submissionStore = {
      durability: "durable",
      lookupFinal: async () => ({
        version: 2,
        outcome: { kind: "created" },
        assessment: {
          sessionId: capturedSid,
          disposition: "ACCEPT",
          score: 0,
          risk: { score: 0, tier: "LOW", confidence: "LOW", recommendedAction: "CONTINUE", evidence: [] },
        },
      }),
      claim: async () => ({ kind: "claimed", claimId: "c", idempotencyKey: "k" }),
      complete: async () => {},
    };
    const r = (await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      async () => SIGNUP_HTML
    )) as { kind: string; replayed?: boolean; upstreamCreated?: boolean; disposition?: string };
    expect(r.kind).toBe("admit");
    expect(r.replayed).toBe(true);
    expect(r.upstreamCreated).toBe(true);
    expect(r.disposition).toBe("ACCEPT"); // the ORIGINAL assessment, not a degraded REPLAY
    expect(upstreamCalls).toBe(0);
  });
});

describe("FR-RR-26: record shape at the parser boundary", () => {
  const FULL_ASSESSMENT = {
    sessionId: "s1",
    disposition: "ACCEPT",
    score: 0,
    risk: { score: 0, tier: "LOW", confidence: "LOW", recommendedAction: "CONTINUE", evidence: [] },
  };

  it("a record declaring version 2 WITHOUT an assessment is malformed (null)", () => {
    // A record that DECLARES v2 enters the v2 contract: the assessment
    // snapshot is mandatory. Claiming the version while omitting the
    // snapshot must not silently degrade to the legacy v1 shape.
    expect(parseStoredRecord({ version: 2, outcome: { kind: "created" } }, "s1")).toBeNull();
    expect(parseStoredRecord({ version: 2, outcome: { kind: "created" }, assessment: null }, "s1")).toBeNull();
  });

  it("FR-RR-46: a version-less outcome-only (legacy v1) record is MALFORMED — no compatibility window", () => {
    // The legacy acceptance produced degraded replay (no original score,
    // risk snapshot, or submitted identity). v0.1.0 has not shipped, so no
    // production data carries assessment-less records: the runtime accepts
    // ONLY the v2 shape, and anything else fails closed.
    expect(parseStoredRecord({ outcome: { kind: "created" } }, "s1")).toBeNull();
    expect(parseStoredRecord({ version: 1, outcome: { kind: "created" }, assessment: FULL_ASSESSMENT }, "s1")).toBeNull();
  });

  it("a v2 record with an INVALID assessment is malformed (null) — never outcome-only", () => {
    expect(
      parseStoredRecord(
        { version: 2, outcome: { kind: "created" }, assessment: { sessionId: "other", nonsense: true } },
        "s1"
      )
    ).toBeNull();
  });

  it("a valid v2 record parses with BOTH halves", () => {
    expect(parseStoredRecord({ version: 2, outcome: { kind: "created" }, assessment: FULL_ASSESSMENT }, "s1")).toEqual({
      outcome: { kind: "created" },
      assessment: FULL_ASSESSMENT,
    });
  });
});

describe("FR-RR-23: outcome whitelist", () => {
  it("accepts exactly the four documented outcome kinds", () => {
    expect(parseFinalSubmissionOutcome({ kind: "created" })).toEqual({ kind: "created" });
    expect(parseFinalSubmissionOutcome({ kind: "business-rejected", status: 409 })).toEqual({
      kind: "business-rejected",
      status: 409,
    });
    expect(parseFinalSubmissionOutcome({ kind: "queued-for-retry", retryId: "r" })).toEqual({
      kind: "queued-for-retry",
      retryId: "r",
    });
    expect(parseFinalSubmissionOutcome({ kind: "decision-denied", disposition: "QUARANTINE" })).toEqual({
      kind: "decision-denied",
      disposition: "QUARANTINE",
    });
  });

  it("rejects invented kinds and out-of-range payloads", () => {
    for (const bad of [
      { kind: "fabricated-success" },
      { kind: "created", extra: true }, // tolerated extras are fine…
      { kind: "business-rejected", status: 200 }, // not a business rejection
      { kind: "business-rejected", status: 503 }, // 5xx is transport, never terminal-rejected
      { kind: "business-rejected", status: "409" }, // non-numeric
      { kind: "queued-for-retry", retryId: "" },
      { kind: "queued-for-retry", retryId: 7 },
      { kind: "decision-denied", disposition: "MAYBE" },
      { kind: "transport-failure", reason: "x" }, // never terminal
      "created",
      null,
      42,
    ]) {
      if (JSON.stringify(bad) === '{"kind":"created","extra":true}') {
        expect(parseFinalSubmissionOutcome(bad)).toEqual({ kind: "created" }); // extras ignored
      } else {
        expect(parseFinalSubmissionOutcome(bad), JSON.stringify(bad)).toBeNull();
      }
    }
  });
});

describe("FR-RR-29: malformed enforcement results normalize to UNCERTAIN", () => {
  const BAD: Array<[string, unknown]> = [
    ["status NaN", { kind: "business-rejected", status: NaN }],
    ["status 200", { kind: "business-rejected", status: 200 }],
    ["status 503", { kind: "business-rejected", status: 503 }],
    ["status string", { kind: "business-rejected", status: "409" }],
    ["missing status", { kind: "business-rejected" }],
    ["queued-for-retry without retryId", { kind: "queued-for-retry" }],
    ["transport-failure without reason", { kind: "transport-failure" }],
    ["uncertain as string", { kind: "transport-failure", reason: "x", uncertain: "yes" }],
    ["bare string", "created"],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [name, shape] of BAD) {
    it(`allow() → ${name}: forward-failed, UNCERTAIN (slot held)`, async () => {
      let upstreamCalls = 0;
      const deps = baseDeps();
      deps.onOperationalError = () => {};
      deps.enforcement = {
        allow: async (): Promise<EnforcementResult> => {
          upstreamCalls++;
          return shape as EnforcementResult;
        },
        deny: () => {},
      };
      const post = await sessionDriver(deps);
      const r = (await post({
        durability: "durable",
        claim: async (sid: string) => ({
          kind: "claimed",
          claimId: "c",
          idempotencyKey: submissionIdempotencyKey(sid),
        }),
        complete: async () => {},
      })) as { kind: string; enforcementDetail?: { uncertain?: boolean }; forwardFailureReason?: string };
      // The forward itself WAS attempted (the malformed answer arrived after
      // the boundary) — but the receipt is forward-failed, the normalized
      // failure is UNCERTAIN so the slot is HELD, and the reason is the
      // named malformed marker.
      expect(r.kind, name).toBe("forward-failed");
      expect(r.forwardFailureReason, name).toBe("malformed_enforcement_result");
      expect(r.enforcementDetail?.uncertain, name).toBe(true);
      expect(upstreamCalls, name).toBe(1);
    });
  }
});
