/**
 * FR-RR-14 — onAssessment durability is REPLAY-SAFE.
 *
 * The transactional hole: upstream creates → complete(created) succeeds →
 * the host's onAssessment fails → the client gets 500 and retries → the
 * coordinator found only the terminal OUTCOME (kind + status), so the
 * original score/disposition/email/risk evidence were LOST. The second
 * onAssessment then succeeded with a DEGRADED replay assessment and the
 * application got acked on it — the real assessment was gone while the
 * upstream account persisted.
 *
 * The fix: complete() persists the immutable assessment snapshot WITH the
 * terminal outcome; both replay paths (lookupFinal and claim→replay)
 * return the original assessment with `replayed: true` orthogonal to the
 * ORIGINAL semantic disposition.
 *
 * Regression matrix — request 1 completes the forward but onAssessment
 * fails (HTTP 500); request 2 replays: upstream NOT called again,
 * onAssessment receives the EXACT original assessment, HTTP 200. Covered
 * for created, business-rejected, and queued-for-retry.
 */
import { describe, it, expect } from "vitest";
import {
  ReferenceSessionAdapter,
  referenceInject,
  type MiddlewareDeps,
} from "../../src/host-adapter/index.js";
import type { EnforcementResult, AssessmentSnapshot } from "../../src/host-adapter/interface.js";
import { submissionIdempotencyKey } from "../../src/host-adapter/interface.js";
import {
  DurableTelemetryAdapter,
  DurableCanaryStore,
  DurableSubmissionStore,
} from "./helpers/durable-stores.js";
import { createOriginServer, closeServer, type OriginAssessment } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"><input name="name"><input name="email"></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

/** Deps whose enforcement returns the requested canned terminal outcome. */
function depsWith(outcome: EnforcementResult): MiddlewareDeps {
  return {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://127.0.0.1:1/register", // never reached
    session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
    render: { inject: referenceInject },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: new DurableTelemetryAdapter(),
    enforcement: {
      allow: async () => outcome,
      deny: async () => {},
    },
    canaryStore: new DurableCanaryStore(),
    submissionStore: new DurableSubmissionStore(),
    enforcementMode: "enforcement" as const,
    routes: ROUTES,
  } as unknown as MiddlewareDeps;
}

describe("FR-RR-14: replayed assessment is the ORIGINAL, not a degraded one", () => {
  for (const [label, outcome] of [
    ["created", { kind: "created" } as const],
    ["business-rejected", { kind: "business-rejected", status: 409 } as const],
    ["queued-for-retry", { kind: "queued-for-retry", retryId: "r-77" } as const],
  ] as const) {
    it(`${label}: onAssessment fails → 500; retry replays the EXACT original assessment → 200, upstream not re-called`, async () => {
      let forwardCalls = 0;
      const deps = depsWith({ ...outcome });
      // Wrap allow to count forwards through THIS transaction.
      const innerAllow = deps.enforcement.allow.bind(deps.enforcement);
      deps.enforcement = {
        allow: async (...args) => {
          forwardCalls++;
          return innerAllow(...args);
        },
        deny: deps.enforcement.deny,
      };

      // The transaction: a real origin server whose onAssessment fails on
      // request 1 (HTTP 500) and succeeds on the replay (HTTP 200).
      const { first, second, assessments } = await (async () => {
        const captured: OriginAssessment[] = [];
        let failAssessment = true;
        const server = createOriginServer({
          middlewareDeps: deps,
          htmlLoader: async () => SIGNUP_HTML,
          routes: ROUTES,
          onAssessment: async (a) => {
            captured.push(a);
            if (failAssessment) {
              failAssessment = false;
              throw new Error("review store outage (simulated)");
            }
          },
        });
        const port: number = await new Promise((resolve) => {
          server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
        });
        const base = `http://127.0.0.1:${port}`;
        try {
          const pageRes = await fetch(`${base}/signup`);
          const setCookie = pageRes.headers.get("set-cookie") ?? "";
          const page = await pageRes.text();
          const cookie = setCookie.split(";")[0].split("=")[1] ?? "";
          const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
          const post = () =>
            fetch(`${base}/signup`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                cookie: `__Host-fr_sid=${cookie}`,
              },
              body: JSON.stringify({ csrf, form: { name: "T", email: "replay@example.invalid" } }),
            });
          const res1 = await post();
          expect(res1.status).toBe(500);
          const res2 = await post();
          expect(res2.status).toBe(200);
          return {
            first: {
              email: captured[0].submittedEmail,
              score: captured[0].score,
              disposition: captured[0].disposition,
              riskEvidence: captured[0].risk?.evidence,
              upstreamCreated: captured[0].upstreamCreated,
              replayed: captured[0].replayed,
            },
            second: {
              email: captured[1].submittedEmail,
              score: captured[1].score,
              disposition: captured[1].disposition,
              riskEvidence: captured[1].risk?.evidence,
              upstreamCreated: captured[1].upstreamCreated,
              replayed: captured[1].replayed,
            },
            assessments: captured,
          };
        } finally {
          await closeServer(server);
          server.closeAllConnections();
        }
      })();

      // Request 1: the original assessment, not a replay.
      expect(first.replayed ?? false).toBe(false);
      expect(first.email).toBe("replay@example.invalid");
      expect(typeof first.score).toBe("number");
      expect(typeof first.disposition).toBe("string");

      // Request 2: the EXACT original — same email, same score, same
      // semantic disposition, same evidence. NOT "REPLAY".
      expect(second.replayed).toBe(true);
      expect(second.email).toBe(first.email);
      expect(second.score).toBe(first.score);
      expect(second.disposition).toBe(first.disposition);
      expect(second.disposition).not.toBe("REPLAY");
      expect(second.riskEvidence).toEqual(first.riskEvidence);
      expect(second.upstreamCreated).toBe(first.upstreamCreated);

      // The upstream was forwarded to EXACTLY ONCE across both attempts.
      expect(forwardCalls).toBe(1);
      expect(assessments).toHaveLength(2);
    });
  }

  it("store-level: the snapshot persists with the outcome and both replay surfaces return it", async () => {
    const store = new DurableSubmissionStore();
    const claim = await store.claim("sess-1", submissionIdempotencyKey("sess-1"));
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    const snapshot: AssessmentSnapshot = {
      sessionId: "sess-1",
      submittedEmail: "s@example.invalid",
      disposition: "REVIEW",
      score: 65,
      risk: {
        score: 65,
        tier: "ELEVATED",
        confidence: "high",
        recommendedAction: "review",
        evidence: [
          { class: "B", source: "direct_fill", weight: 15, verified: true, description: "d" },
        ],
      },
    };
    await store.complete(claim.claimId, { kind: "created" }, undefined, { assessment: snapshot });

    const viaLookup = await store.lookupFinal!("sess-1");
    expect(viaLookup?.outcome).toEqual({ kind: "created" });
    expect(viaLookup?.assessment).toEqual(snapshot);

    const viaClaim = await store.claim("sess-1", submissionIdempotencyKey("sess-1"));
    expect(viaClaim.kind).toBe("replay");
    if (viaClaim.kind === "replay") {
      expect(viaClaim.record.outcome).toEqual({ kind: "created" });
      expect(viaClaim.record.assessment).toEqual(snapshot);
    }

    // Idempotency identity: completing with a DIFFERENT snapshot cannot
    // happen (complete is once per claim) — but a second claim of the same
    // session replays, never re-records. The snapshot is immutable.
    const third = await store.claim("sess-1", submissionIdempotencyKey("sess-1"));
    if (third.kind === "replay") {
      expect(third.record.assessment).toEqual(snapshot);
    } else {
      throw new Error("expected replay");
    }
  });

  it("a transport-failure completion still releases the slot (no assessment stored, retry allowed)", async () => {
    const store = new DurableSubmissionStore();
    const claim = await store.claim("sess-2", submissionIdempotencyKey("sess-2"));
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    await store.complete(
      claim.claimId,
      { kind: "transport-failure", reason: "network_error" },
      undefined,
      {
        assessment: {
          sessionId: "sess-2",
          submittedEmail: undefined,
          disposition: "ACCEPT",
          score: 5,
          risk: { score: 5, tier: "LOW", confidence: "high", recommendedAction: "accept", evidence: [] },
        },
      }
    );
    // Released: lookupFinal null, next claim takes over fresh.
    expect(await store.lookupFinal!("sess-2")).toBeNull();
    const next = await store.claim("sess-2", submissionIdempotencyKey("sess-2"));
    expect(next.kind).toBe("claimed");
  });
});
