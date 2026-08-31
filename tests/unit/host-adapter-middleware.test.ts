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
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  type MiddlewareDeps,
  type HostEnforcementAdapter,
} from "../../src/host-adapter/index.js";
import { deriveProfilePure } from "../../src/core/profile.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

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
    session: new ReferenceSessionAdapter(),
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
    const csrf = "csrf";
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sessionId}` },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      htmlLoader
    );
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
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sessionId}` },
        body: JSON.stringify({ csrf: "x", form: { name: "A", email: "a@b.c", [field]: nonce } }),
      }),
      d,
      htmlLoader
    );
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
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sessionId}` },
        body: JSON.stringify({ form: { name: "A" } }),
      }),
      d,
      htmlLoader
    );
    expect(res.kind).toBe("deny");
    expect(enforcement.allowed).toBe(0);
  });
});
