/**
 * P0 origin opacity — the applicant-facing wire is decision-blind.
 *
 * Drives the REAL origin runtime (createOriginServer → admit → writeResult)
 * through four submissions that FireRaid internally classifies very
 * differently:
 *
 *   clean humanish submission   → internally ACCEPT
 *   decoy-field fill            → internally REVIEW (Class-B evidence)
 *   exact-nonce fill            → internally REVIEW (semantic echo)
 *   verified canary route hit   → internally QUARANTINE (Class-A evidence)
 *
 * …and asserts the APPLICANT sees byte-identical bodies and status codes
 * for all four. The internal classification reaches the host through
 * onAssessment ONLY — the test pins both sides:
 *   wire:      identical neutral receipts (no disposition/score/tier/trackers)
 *   host hook: the SAME four runs produce DISTINCT dispositions/scores
 *              (the assessment channel carries the information the wire
 *              must not).
 *
 * Enforcement posture: decision-denied submissions must ALSO be
 * wire-identical to admits (the P0 origin-opacity invariant) — the
 * upstream saw nothing, the applicant learned nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createOriginServer, closeServer, type OriginAssessment } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  ReferenceTelemetryAdapter,
  ReferenceCanaryStore,
  referenceInject,
} from "../../src/host-adapter/index.js";
import { deriveProfilePure } from "../../src/core/profile.js";

const SECRET = "o".repeat(64);
const VERSION = 1;

const SIGNUP_HTML =
  '<form id="signup-form"><input name="name"><input name="email"><input name="password"><button>Submit</button></form>';

const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

/** Humanish telemetry the clean arm carries (the bot arms carry none). */
function humanEvents() {
  const events = [];
  let seq = 0, dt = 0;
  for (const field of ["name", "email", "password"]) {
    dt += 350; events.push({ seq: ++seq, dt, kind: "focus", target: field });
    dt += 250; events.push({ seq: ++seq, dt, kind: "key", target: field });
    dt += 180; events.push({ seq: ++seq, dt, kind: "input", target: field });
  }
  dt += 600; events.push({ seq: ++seq, dt, kind: "submit_attempt" });
  return events;
}

describe("P0 origin opacity: decision-blind wire", () => {
  let server: http.Server;
  let port: number;
  let assessments: OriginAssessment[];
  let counter: number;

  /** Boot one origin server in enforcement posture (decisions actually
   * deny) with an onAssessment recorder. */
  beforeEach(async () => {
    assessments = [];
    counter = 0;
    const deps = {
      // Production-shaped fixture: profileKeys is THE contract (item 18).
      profileKeys: { current: { id: "default", secret: SECRET } },
      version: VERSION,
      upstreamRegisterUrl: "http://localhost:1/api/register", // never reached: the enforcement arms are denied; admits use a stub enforcement
      session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
      render: { inject: referenceInject },
      verification: { verificationMode: "host-owned" as const, verify: async () => true },
      telemetry: new ReferenceTelemetryAdapter(),
      // Stub upstream: records forwards; the origin's receipts don't depend
      // on it (the assertion is about FireRaid's wire, not the upstream's).
      enforcement: {
        allow: async () => true,
        deny: () => {},
      },
      canaryStore: new ReferenceCanaryStore(),
      enforcementMode: "enforcement" as const,
      routes: ROUTES,
    };
    server = createOriginServer({
      middlewareDeps: deps,
      htmlLoader: async () => SIGNUP_HTML,
      port: 0,
      routes: ROUTES,
      onAssessment: (a) => assessments.push(a),
    });
    port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
      server.on("error", reject);
    });
  });

  afterEach(async () => {
    if (server.listening) await closeServer(server);
  });

  /** Full session: GET page (extract cookie + csrf + profile material),
   * then POST one submission. Returns the raw wire response. */
  async function runSubmission(
    mutate: (ctx: { form: Record<string, string>; profile: Awaited<ReturnType<typeof deriveProfilePure>>; page: string }) => Promise<void> | void,
    events?: unknown[]
  ): Promise<{ status: number; body: string }> {
    counter++;
    const base = `http://127.0.0.1:${port}`;
    const pageResp = await fetch(`${base}/signup`);
    const cookie = (pageResp.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await pageResp.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const profile = await deriveProfilePure(
      { secret: SECRET, version: VERSION, sessionId: decodeSessionId(cookie), mode: "production" }
    );
    const form: Record<string, string> = {
      name: `Applicant ${counter}`,
      email: `applicant-${counter}@example.invalid`,
      password: "synthetic-password-123",
    };
    lastCookie = cookie;
    await mutate({ form, profile, page });

    const resp = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ csrf, form, eventBatch: events ?? [] }),
    });
    return { status: resp.status, body: await resp.text() };
  }

  function decodeSessionId(cookie: string): string {
    // "name=fr1.<b64url payload>.<sig>" → payload carries sid.
    const envelope = cookie.split("=").slice(1).join("="); // strip cookie name
    const payload = envelope.split(".")[1];
    const json = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { sid?: string };
    return json.sid ?? "";
  }

  function b64urlDecode(s: string): Uint8Array {
    // Unpadded base64url (the envelope's alphabet).
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  it("clean / decoy-fill / nonce-fill / route-hit → byte-identical receipts; host hook sees the distinctions", async () => {
    // 1. CLEAN: humanish telemetry, no trap interaction.
    const clean = await runSubmission(() => {}, humanEvents());

    // 2. DECOY FILL: omnivorous bot — fill every extra field the page has.
    const decoyFill = await runSubmission(({ form, page }) => {
      for (const tag of page.match(/<input\b[^>]*>/g) ?? []) {
        const name = tag.match(/name="([^"]+)"/)?.[1];
        const type = tag.match(/type="([^"]+)"/)?.[1] ?? "text";
        if (!name || name === "csrf" || ["hidden", "submit", "button"].includes(type)) continue;
        if (!(name in form)) form[name] = "bot-fills-everything";
      }
    });

    // 3. NONCE FILL: echo the semantic nonce into the visible name field.
    const nonceFill = await runSubmission(async ({ form, profile }) => {
      if (profile.semantic) {
        form.name = profile.semantic.nonce; // visible-field echo (deriveCanaryReference)
      }
    });

    // 4. ROUTE HIT: verify the canary route, then submit clean. The random
    // production composition draws route-dependent strategies (P02/P04) on
    // a subset of sessions — draw until this session carries a route.
    let routeHit: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt < 40 && !routeHit; attempt++) {
      try {
        routeHit = await runSubmission(async ({ profile }) => {
          if (!profile.decoyRoute) {
            throw new NoRouteDraw();
          }
          const hit = await fetch(
            `http://127.0.0.1:${port}/c/${profile.decoyRoute.endpointToken}`,
            { headers: { cookie: lastCookie } }
          );
          // The probe must verify (204) for the route evidence to exist.
          expect(hit.status).toBe(204);
        });
      } catch (e) {
        // A no-route draw aborts BEFORE the POST (mutate throws first), so
        // no assessment is recorded — safe to redraw a fresh session.
        if (!(e instanceof NoRouteDraw)) throw e;
      }
    }
    expect(routeHit, "a P02/P04 session within 40 draws").not.toBeNull();
    const routeHitResp = routeHit as { status: number; body: string };

    // ── WIRE: all four byte-identical, status 200. ──────────────────────
    const receipts = [clean, decoyFill, nonceFill, routeHitResp];
    for (const [i, r] of receipts.entries()) {
      expect(r.status, `arm ${i} status`).toBe(200);
      expect(r.body, `arm ${i} body`).toBe(clean.body);
    }
    // The receipt itself carries no decision material.
    const parsed = JSON.parse(clean.body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["message", "status"]);
    expect(parsed.status).toBe("received");
    for (const leak of ["disposition", "score", "tier", "risk", "sessionId", "evidence", "upstreamCreated"]) {
      expect(clean.body).not.toContain(leak);
    }

    // ── HOST HOOK: the same four runs are internally DISTINGUISHABLE. ───
    expect(assessments).toHaveLength(4);
    const [aClean, aDecoy, aNonce, aRoute] = assessments;
    // Evidence hierarchy shows up in score/tier, not on the wire.
    expect(aClean.disposition).toBe("ACCEPT");
    expect(["REVIEW", "QUARANTINE"]).toContain(aDecoy.disposition);
    expect(aDecoy.score!).toBeGreaterThan(aClean.score!);
    expect(aNonce.score!).toBeGreaterThan(aClean.score!);
    expect(aRoute.disposition).toBe("QUARANTINE");
    expect(aRoute.decisionDenied).toBe(true);
  }, 30_000);

  // Cookie must survive between the route probe and the submit — captured
  // per run via closure below.
  let lastCookie = "";

  /** Retry sentinel: this session's production draw carried no decoy route. */
  class NoRouteDraw extends Error {}

  it("precondition failures stay 4xx (transport facts, not decision oracles)", async () => {
    const base = `http://127.0.0.1:${port}`;
    const pageResp = await fetch(`${base}/signup`);
    const cookie = (pageResp.headers.get("set-cookie") ?? "").split(";")[0];
    lastCookie = cookie;
    // Bad CSRF → 403 CSRF_FAILED (a legitimate client needs this signal).
    const badCsrf = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ csrf: "wrong", form: { name: "A", email: "a@b.c" } }),
    });
    expect(badCsrf.status).toBe(403);
    const j = (await badCsrf.json()) as { error?: string };
    expect(j.error).toBe("CSRF_FAILED");
    // And the failure is transport-shaped: no score/tier/evidence on it.
    const bodyText = JSON.stringify(j);
    for (const leak of ["score", "tier", "evidence", "risk"]) {
      expect(bodyText).not.toContain(`"${leak}"`);
    }
  });
});
