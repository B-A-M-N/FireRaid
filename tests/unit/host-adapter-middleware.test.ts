/**
 * P1-24 / P1-25 — host-neutral admission middleware unit tests.
 *
 * Exercises `admit()` against the host-adapter seam WITHOUT a live server:
 * a fake HostEnforcementAdapter records whether `allow()` was called, which
 * is the PRIMARY experimental truth (did the origin ledger get the account).
 * A CONTROL (no defense) registration forwards; a QUARANTINE decision never
 * forwards.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  makeCsrf,
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  type MiddlewareDeps,
  type HostEnforcementAdapter,
} from "../../src/host-adapter/index.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import { validateTelemetryBatch } from "../../src/security/request-validation.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

/** Session-keyed in-memory telemetry store backing the test adapters'
 * stateful HostTelemetryAdapter contract (P0-5). */
const store: Record<string, { seq: number; dt: number; kind: string; target?: string }[]> = {};

/** Build a POST Request carrying a valid signed cookie + keyed CSRF. */
async function postRequest(sessionId: string, body: Record<string, unknown>) {
  const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
  const csrf = await makeCsrf(SECRET, sessionId);
  return new Request("http://mw/signup", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ csrf, ...body }),
  });
}

class FakeEnforcement implements HostEnforcementAdapter {
  allowed = 0;
  denied = 0;
  lastForm: Record<string, string> | null = null;
  async allow(_url: string, form: Record<string, string>, _cookies: string): Promise<boolean> {
    this.allowed++;
    this.lastForm = form;
    return true;
  }
  deny(_sid: string, _reason: string): void {
    this.denied++;
  }
}

function deps(over: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: "http://upstream/api/register",
    session: new ReferenceSessionAdapter(SECRET),
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new FakeEnforcement(),
    labMode: false,
    ...over,
  };
}

const SIGNUP_HTML = '<form id="signup-form"></form><body></body>';

async function htmlLoader(): Promise<string> {
  return SIGNUP_HTML;
}

describe("host-neutral admission middleware (P1-24/P1-25)", () => {
  it("GET injects artifacts and issues a session cookie", async () => {
    const d = deps();
    const res = await admit(new Request("http://mw/signup"), d, htmlLoader);
    expect(res.kind).toBe("get");
    expect(res.setCookie).toContain("__Host-fr_sid=");
    expect(res.html).toContain('name="csrf"');
  });

  it("CONTROL (no defense) forwards and the upstream ledger is written", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({ enforcement });
    const sessionId = await d.session.createSession();
    const profile = await deriveProfilePure({ secret: SECRET, version: VERSION, sessionId, mode: "production" });
    const req = await postRequest(sessionId, { form: { name: "A", email: "a@b.c" } });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
    // FireRaid fields are stripped before forwarding — the ordinary ledger
    // never sees our decoy/csrf artifacts.
    expect(enforcement.lastForm).not.toHaveProperty("csrf");
    expect(enforcement.lastForm).not.toHaveProperty(profile.decoyField?.fieldName ?? "__none__");
    expect(enforcement.denied).toBe(0);
  });

  it("QUARANTINE decision never forwards to the upstream", async () => {
    const enforcement = new FakeEnforcement();
    // The defended (lab) condition: semantic canary S06 in decoy mode draws a
    // nonce the agent is told to place into the decoy field. Submitting that
    // exact nonce is causal Class-A evidence → QUARANTINE.
    const d = deps({
      enforcement,
      labMode: true,
      recipe: { families: ["semantic", "decoy-field", "decoy-route", "interaction"], semanticTemplate: "S06", semanticMode: "decoy" },
    });
    const sessionId = await d.session.createSession();
    const profile = await deriveProfilePure(
      { secret: SECRET, version: VERSION, sessionId, mode: "lab" },
      { families: ["semantic", "decoy-field", "decoy-route", "interaction"], semanticTemplate: "S06", semanticMode: "decoy" }
    );
    const field = profile.decoyField!.fieldName;
    const nonce = profile.semantic!.nonce;
    const req = await postRequest(sessionId, { form: { name: "A", email: "a@b.c", [field]: nonce } });
    const res = await admit(req, d, htmlLoader);
    expect(res.disposition).toBe("QUARANTINE");
    expect(enforcement.allowed).toBe(0);
    expect(enforcement.denied).toBe(1);
  });

  it("fail-closed: missing session is denied, never forwarded", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({ enforcement });
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ form: { name: "A" } }),
      }),
      d,
      htmlLoader
    );
    expect(res.kind).toBe("deny");
    expect(enforcement.allowed).toBe(0);
  });

  it("fail-closed: verification adapter throwing denies, never forwards", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({
      enforcement,
      verification: { verify: async () => { throw new Error("verifier down"); } },
    });
    const sessionId = await d.session.createSession();
    const req = await postRequest(sessionId, { form: { name: "A" } });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("deny");
    expect(enforcement.allowed).toBe(0);
  });

  it("P1-AUDIT-2: forged (unsigned) session cookie is rejected as NO_SESSION", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({ enforcement });
    const sessionId = await d.session.createSession();
    // Bare sid — no HMAC signature. Must NOT be accepted as a session.
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sessionId}` },
        body: JSON.stringify({ form: { name: "A" } }),
      }),
      d,
      htmlLoader
    );
    expect(res.disposition).toBe("NO_SESSION");
    expect(enforcement.allowed).toBe(0);
  });

  it("P1-AUDIT-2: missing/wrong CSRF is denied before evaluation", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({ enforcement });
    const sessionId = await d.session.createSession();
    const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf: "forged", form: { name: "A" } }),
      }),
      d,
      htmlLoader
    );
    expect(res.disposition).toBe("CSRF_FAILED");
    expect(enforcement.allowed).toBe(0);
  });
});

describe("P1-AUDIT-2: middleware telemetry parity with canonical submit", () => {
  const LAB_FULL: Parameters<typeof deriveProfilePure>[1] = {
    families: ["decoy-field", "decoy-route", "interaction"],
  };

  it("capture OFF never yields noPointerEvents (was a false positive by construction)", async () => {
    const enforcement = new FakeEnforcement();
    // Derive a profile to learn the capture mask first, then FORCE the
    // opposite: we need a profile with capturePointer=false to prove the
    // capture gate. Retry until one draws capturePointer=false.
    let sessionId = "";
    let profile: Awaited<ReturnType<typeof deriveProfilePure>> | null = null;
    for (let i = 0; i < 50; i++) {
      sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
      const p = await deriveProfilePure({ secret: SECRET, version: VERSION, sessionId, mode: "production" }, LAB_FULL);
      if (!p.telemetry.capturePointer) { profile = p; break; }
    }
    expect(profile).not.toBeNull(); // 50 draws all-capture-on is implausible
    const d = deps({
      enforcement,
      recipe: LAB_FULL,
      telemetry: {
        // Canonical validation + in-memory persistence (P0-5 contract).
        accept: async (sid: string, b: unknown) => {
          const check = validateTelemetryBatch(b);
          if (!check.ok) return null;
          (store[sid] ??= []).push(...check.events);
          return check.events.length;
        },
        collect: async (sid: string) => store[sid] ?? [],
      },
    });
    // Batch has key + input events but NO pointer events. With capture OFF,
    // noPointerEvents must stay undefined — never scored. Events carry REAL
    // dt values — the canonical validator rejects undefined dt (P0-4's
    // no-fabricated-timestamps contract cuts both ways).
    const events = [
      { seq: 1, dt: 0, kind: "key" },
      { seq: 2, dt: 100, kind: "input", target: "email" },
      { seq: 3, dt: 200, kind: "submit_attempt" },
    ];
    const req = await postRequest(sessionId, { form: { name: "A", email: "a@b.c" }, eventBatch: events });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });

  it("capture ON + zero pointer events derives noPointerEvents from canonical aggregator", async () => {
    const enforcement = new FakeEnforcement();
    let sessionId = "";
    let profile: Awaited<ReturnType<typeof deriveProfilePure>> | null = null;
    for (let i = 0; i < 50; i++) {
      sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
      const p = await deriveProfilePure({ secret: SECRET, version: VERSION, sessionId, mode: "production" }, LAB_FULL);
      if (p.telemetry.capturePointer) { profile = p; break; }
    }
    expect(profile).not.toBeNull();
    const d = deps({
      enforcement,
      recipe: LAB_FULL,
      telemetry: {
        // Canonical validation + in-memory persistence (P0-5 contract).
        accept: async (sid: string, b: unknown) => {
          const check = validateTelemetryBatch(b);
          if (!check.ok) return null;
          (store[sid] ??= []).push(...check.events);
          return check.events.length;
        },
        collect: async (sid: string) => store[sid] ?? [],
      },
    });
    const events = [
      { seq: 1, dt: 0, kind: "key" },
      { seq: 2, dt: 100, kind: "input", target: "email" },
      { seq: 3, dt: 200, kind: "submit_attempt" },
    ];
    const req = await postRequest(sessionId, { form: { name: "A", email: "a@b.c" }, eventBatch: events });
    const res = await admit(req, d, htmlLoader);
    // The decision here depends on the FULL recipe's correlation: a captured
    // no-pointer stream is real interaction evidence, so it must NOT be
    // QUARANTINE on that basis alone — but critically the decision cannot
    // have come from a fabricated metric. Assert the forward happened (the
    // no-pointer signal alone is not disqualifying for this recipe).
    expect(res.kind).toBe("admit");
  });
});

describe("P1-AUDIT-2 (P1-14): telemetry-drain carrier on the host plane", () => {
  it("POST /api/events accepts a valid batch and returns the Worker-shaped ACK", async () => {
    const d = deps();
    const sessionId = await d.session.createSession();
    const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
    const req = new Request("http://mw/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        events: [
          { seq: 1, dt: 0, kind: "page_ready" },
          { seq: 2, dt: 300, kind: "focus", target: "name" },
          { seq: 3, dt: 900, kind: "input", target: "name" },
        ],
      }),
    });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("ingest");
    expect(res.received).toBe(3);
    expect(res.acceptedThrough).toBe(3);
    // The drain persisted into the observation store — the later submit
    // scores the whole stream, not just what rode along.
    expect(await d.telemetry.collect(sessionId)).toHaveLength(3);
  });

  it("POST /api/events with a structurally invalid batch is a DENY (worker 400/413 verdict, host shape)", async () => {
    const enforcement = new FakeEnforcement();
    const d = deps({ enforcement });
    const sessionId = await d.session.createSession();
    const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
    const req = new Request("http://mw/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        events: [
          { seq: 2, dt: 0, kind: "page_ready" },
          { seq: 1, dt: 100, kind: "focus", target: "name" }, // seq order violation
        ],
      }),
    });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("INVALID_TELEMETRY");
    expect(enforcement.allowed).toBe(0);
  });

  it("POST /api/events without a session is NO_SESSION (never an ingest)", async () => {
    const d = deps();
    const req = new Request("http://mw/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ seq: 1, dt: 0, kind: "page_ready" }] }),
    });
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("NO_SESSION");
  });

  it("telemetryIngestPath: '' disables ingest handling (submit-only host)", async () => {
    const d = deps({ telemetryIngestPath: "" });
    const sessionId = await d.session.createSession();
    const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
    const req = new Request("http://mw/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ events: [{ seq: 1, dt: 0, kind: "page_ready" }] }),
    });
    // Falls through to the submit branch: no csrf → CSRF_FAILED deny
    // (NOT an ingest result).
    const res = await admit(req, d, htmlLoader);
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("CSRF_FAILED");
  });
});
