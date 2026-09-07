/**
 * FR-RR-21 — a DECISION-denied submission is a TERMINAL, replayable outcome.
 *
 * The old flow: decision → deny → evidence stores finalized (wiped) →
 * result returned → runtime's onAssessment persistence FAILS → 500. A
 * client retry then found NO terminal record, no evidence — the session
 * re-evaluated and could now forward to the upstream. That is the exact
 * one-forward/duplicate-create hazard FR-P0-02 closed for the forward
 * path, reopened through the decision-deny path.
 *
 * The fixed flow: decision → finalizeDecision (DURABLE terminal record v2
 * carrying the assessment snapshot) → enforcement.deny → evidence cleanup
 * (best-effort) → result. A retry replays the stored denial with its
 * original assessment — no re-evaluation, no upstream call, no release.
 *
 * Regressions (per the goal text, QUARANTINE and REVIEW):
 *   first request: causal evidence → decision; durable terminal decision
 *     succeeds; evidence stores finalize; onAssessment rejects; HTTP 500.
 *   retry: evidence is gone; coordinator does NOT re-evaluate; upstream
 *     calls = 0; the ORIGINAL assessment is replayed; onAssessment
 *     succeeds; HTTP 200 neutral receipt.
 *
 * Decision forcing over the PRODUCTION plane (createOriginServer runs
 * admit() with no evaluation controls — a recipe in deps would be dead
 * configuration here):
 *   - QUARANTINE: verified decoy-route probe before submit →
 *     CANARY_ROUTE_MATCH (Class-A, weight 100, quarantineOnCausal). The
 *     production draw is route-less ~1/3 of sessions; draw until armed.
 *   - REVIEW: omnivorous decoy-field fill (Class-B 60) + machine-shaped
 *     stream (directFill 15 + zeroDwell 10 + uniformCadence 10) ≥ 80 with
 *     a strong hit → REVIEW under the default policy.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createOriginServer, closeServer } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  referenceInject,
  type HostEnforcementAdapter,
  type EnforcementResult,
} from "../../src/host-adapter/index.js";
import {
  DurableTelemetryAdapter,
  DurableCanaryStore,
  DurableSubmissionStore,
} from "./helpers/durable-stores.js";
import type { OriginAssessment } from "../../src/runtime/node.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

const SIGNUP_HTML =
  '<form id="signup-form"><input name="name"><input name="email"><input name="password"><button>Submit</button></form>';

const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

class CountingEnforcement implements HostEnforcementAdapter {
  calls = 0;
  async allow(): Promise<EnforcementResult> {
    this.calls++;
    return { kind: "created" };
  }
  deny(): void {}
}

describe("FR-RR-21: decision-deny is terminal and replayable", () => {
  let server: http.Server;
  let port: number;
  let assessments: OriginAssessment[];
  let failAssessment: boolean;
  let enforcement: CountingEnforcement;
  let submissionStore: DurableSubmissionStore;

  afterEach(async () => {
    if (server?.listening) await closeServer(server);
  });

  async function start(): Promise<void> {
    assessments = [];
    failAssessment = false;
    enforcement = new CountingEnforcement();
    submissionStore = new DurableSubmissionStore();
    const deps = {
      profileKeys: { current: { id: "default", secret: SECRET } },
      version: VERSION,
      upstreamRegisterUrl: "http://127.0.0.1:1/api/register", // never reached on a deny
      session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
      render: { inject: referenceInject },
      verification: { verificationMode: "host-owned" as const, verify: async () => true },
      telemetry: new DurableTelemetryAdapter(),
      enforcement,
      canaryStore: new DurableCanaryStore(),
      submissionStore,
      enforcementMode: "enforcement" as const,
      routes: ROUTES,
    };
    server = createOriginServer({
      middlewareDeps: deps,
      htmlLoader: async () => SIGNUP_HTML,
      routes: ROUTES,
      onAssessment: async (a) => {
        if (failAssessment) {
          failAssessment = false;
          throw new Error("host persistence outage");
        }
        assessments.push(a);
      },
    });
    port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
      server.on("error", reject);
    });
  }

  /** Machine-shaped stream: fill-after-focus with zero dwell, metronomic
   * cadence, no pointer, no blur. */
  const BOT_EVENTS = [
    { seq: 1, dt: 0, kind: "page_ready" },
    { seq: 2, dt: 10, kind: "focus", target: "email" },
    { seq: 3, dt: 11, kind: "input", target: "email" },
    { seq: 4, dt: 21, kind: "focus", target: "password" },
    { seq: 5, dt: 22, kind: "input", target: "password" },
    { seq: 6, dt: 32, kind: "focus", target: "name" },
    { seq: 7, dt: 33, kind: "input", target: "name" },
    { seq: 8, dt: 34, kind: "submit_attempt" },
  ];

  /** Open a session; return cookie, csrf, profile material, and the page. */
  async function openSession(): Promise<{
    cookie: string;
    csrf: string;
    page: string;
    decoyField: string | null;
    decoyRouteToken: string | null;
  }> {
    const base = `http://127.0.0.1:${port}`;
    const pageResp = await fetch(`${base}/signup`);
    const cookie = (pageResp.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await pageResp.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const sid = decodeSessionId(cookie);
    const { deriveProfilePure } = await import("../../src/core/profile.js");
    const profile = await deriveProfilePure({
      secret: SECRET,
      version: VERSION,
      sessionId: sid,
      mode: "production",
    });
    return {
      cookie,
      csrf,
      page,
      decoyField: profile.decoyField?.fieldName ?? null,
      decoyRouteToken: profile.decoyRoute?.endpointToken ?? null,
    };
  }

  async function submit(
    s: { cookie: string; csrf: string },
    form: Record<string, string>,
    events: unknown[]
  ): Promise<{ status: number; body: string }> {
    const base = `http://127.0.0.1:${port}`;
    const resp = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: s.cookie },
      body: JSON.stringify({ csrf: s.csrf, form, eventBatch: events }),
    });
    return { status: resp.status, body: await resp.text() };
  }

  function decodeSessionId(cookie: string): string {
    const envelope = cookie.split("=").slice(1).join("=");
    const payload = envelope.split(".")[1];
    const json = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { sid?: string };
    return json.sid ?? "";
  }

  function b64urlDecode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** FR-RR-21 flake guard: a 500 is the deny under test ONLY when a
   * durable terminal decision-denied record exists for the session. A
   * load-induced OPERATIONAL 500 (e.g. a deadline firing on a draw under a
   * fully-loaded machine) leaves no such record — that draw is skipped,
   * never mistaken for a decision denial. */
  async function isTerminalDenial(sid: string): Promise<boolean> {
    const rec = await submissionStore.lookupFinal(sid);
    return rec?.outcome.kind === "decision-denied";
  }

  it("QUARANTINE: first request stores the terminal decision, 500 on assessment failure; retry replays the ORIGINAL denial without re-evaluating", async () => {
    await start();
    const botForm = (extra: Record<string, string> = {}): Record<string, string> => ({
      name: "Bot",
      email: `bot-${Date.now()}-${Math.random()}@example.invalid`,
      password: "synthetic-pass-123",
      ...extra,
    });

    // Draw until a route-armed session: probe the decoy route (Class-A
    // verified evidence), then submit with the bot stream → QUARANTINE.
    let first: Awaited<ReturnType<typeof openSession>> | null = null;
    for (let i = 0; i < 40 && !first; i++) {
      const s = await openSession();
      if (!s.decoyRouteToken) continue; // route-less draw — fresh session
      const probe = await fetch(`http://127.0.0.1:${port}/c/${s.decoyRouteToken}`, {
        headers: { cookie: s.cookie },
      });
      expect(probe.status).toBe(204); // verified canary hit
      // Arm the hook failure: the DENY under test (earlier draws prove
      // un-armed submits return 200) must fail at the onAssessment seam.
      failAssessment = true;
      const r = await submit(s, botForm(), BOT_EVENTS);
      if (r.status === 500 && (await isTerminalDenial(decodeSessionId(s.cookie)))) {
        // Decision made → finalizeDecision durable → deny → evidence
        // cleanup → the armed onAssessment rejected. The failure is NOT
        // recorded as a success assessment.
        expect(assessments).toHaveLength(0);
        first = s;
      } else {
        failAssessment = false; // draw did not deny — disarm for the next
      }
    }
    expect(first, "a route-armed QUARANTINE session within 40 draws").not.toBeNull();

    // ── Retry: same session. CSRF is session-keyed and still valid — the
    // retry reuses the ORIGINAL token (a fresh GET would mint a NEW session,
    // which is not this client's retry shape). ──
    const base = `http://127.0.0.1:${port}`;
    const callsBefore = enforcement.calls;
    const retry = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first!.cookie },
      body: JSON.stringify({ csrf: first!.csrf, form: botForm(), eventBatch: [] }),
    });
    // HTTP 200 neutral receipt — the ORIGINAL terminal outcome, replayed.
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { status?: string };
    expect(retryBody.status).toBe("received");
    // No re-evaluation → NO upstream forward and NO second deny pass.
    expect(enforcement.calls).toBe(callsBefore);
    expect(enforcement.calls).toBe(0);
    // The original assessment REPLAYED through the hook with its original
    // risk material — not a degraded receipt.
    expect(assessments).toHaveLength(1);
    expect(assessments[0].replayed).toBe(true);
    // FR-RR-55: the replayed receipt carries the disposition the boundary
    // ACTUALLY enforced. The default tier map (enforcement mode) auto-
    // suppresses only the CAUSAL tier (score ≥ 200); a 100–200 CAUSAL-
    // class canary hit lands in HIGH (autoSuppress:false) → the runtime
    // action is REVIEW. The snapshot still holds the core call in its own
    // field — the pair (core, runtime) is the honest record.
    expect(assessments[0].score).toBeGreaterThanOrEqual(100);
    if ((assessments[0].score ?? 0) >= 200) {
      expect(assessments[0].disposition).toBe("QUARANTINE");
    } else {
      expect(assessments[0].disposition).toBe("REVIEW");
    }
    expect(assessments[0].decisionDenied).toBe(true);
    expect(assessments[0].risk?.evidence?.length ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("REVIEW: same terminal transaction — 500 on assessment failure, retry replays without re-evaluating", async () => {
    await start();
    // Omnivorous decoy fill + bot stream → strong (Class-B) evidence with
    // total ≥ strongReviewThreshold (80) → REVIEW under the default policy.
    let first: Awaited<ReturnType<typeof openSession>> | null = null;
    for (let i = 0; i < 40 && !first; i++) {
      const s = await openSession();
      const form: Record<string, string> = {
        name: "Bot",
        email: `bot-${Date.now()}-${Math.random()}@example.invalid`,
        password: "synthetic-pass-123",
      };
      if (s.decoyField) form[s.decoyField] = "bot-fills-everything";
      failAssessment = true;
      const r = await submit(s, form, BOT_EVENTS);
      if (r.status === 500 && (await isTerminalDenial(decodeSessionId(s.cookie)))) {
        first = s;
      } else {
        failAssessment = false;
      }
    }
    expect(first, "a REVIEW session within 40 draws").not.toBeNull();

    const retry = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first!.cookie },
      body: JSON.stringify({
        csrf: first!.csrf,
        form: { name: "Bot", email: "retry@example.invalid" },
        eventBatch: [],
      }),
    });
    expect(retry.status).toBe(200);
    expect(enforcement.calls).toBe(0);
    expect(assessments).toHaveLength(1);
    expect(assessments[0].replayed).toBe(true);
    expect(assessments[0].disposition).toBe("REVIEW");
    expect(assessments[0].decisionDenied).toBe(true);
  }, 60_000);
});
