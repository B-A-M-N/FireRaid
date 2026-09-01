/**
 * P1-AUDIT-2 response (P1-1) — the host session envelope's pv is CONSUMED.
 *
 * The signed envelope carries the issuing profile version; middleware used
 * to derive with the DEPLOYMENT default (deps.version) instead, so:
 *
 *   issue session at profile version 7
 *   deployment default moves to 8
 *   submit with the v7 cookie
 *   ⇒ middleware must reconstruct the v7 treatment
 *
 * If the decision follows a v8 profile, parity is broken (the FR-P1-19
 * rotation hazard on the Worker). Also pins: the origin runtime signs the
 * EXPERIMENT's version into its envelopes (the prior bare construction
 * always signed pv=1), and the canary GET path derives under the envelope
 * pv too.
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

const SECRET = "k".repeat(64);

class NullEnforcement implements HostEnforcementAdapter {
  lastForm: Record<string, string> | null = null;
  async allow(_u: string, form: Record<string, string>): Promise<boolean> {
    this.lastForm = form;
    return true;
  }
  deny(): void {}
}

function deps(version: number, over: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    secret: SECRET,
    version,
    upstreamRegisterUrl: "http://upstream.invalid/api/register",
    session: new ReferenceSessionAdapter(SECRET, { version }),
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new NullEnforcement(),
    labMode: false,
    ...over,
  };
}

const HTML = '<html><body><form id="signup-form"></form></body></html>';

describe("P1-1: middleware consumes the envelope's pv (version pinning)", () => {
  it("a v7 cookie under a v8 deployment default still reconstructs the v7 treatment", async () => {
    // The sessions were ISSUED at version 7 (adapter constructed with 7).
    const issuingAdapter = new ReferenceSessionAdapter(SECRET, { version: 7 });
    const sessionId = await issuingAdapter.createSession();
    const cookie = await issuingAdapter.sessionCookie(sessionId);
    const csrf = await makeCsrf(SECRET, sessionId);

    // The v7 profile's treatment (decoy field name) — what the middleware
    // MUST reconstruct.
    const v7Profile = await deriveProfilePure(
      { secret: SECRET, version: 7, sessionId, mode: "production" },
      { families: ["decoy-field"] }
    );
    // The v8 profile for the same session differs (different seed domain).
    const v8Profile = await deriveProfilePure(
      { secret: SECRET, version: 8, sessionId, mode: "production" },
      { families: ["decoy-field"] }
    );
    // Sanity: the two versions really do issue different material for this
    // session — otherwise this test cannot distinguish them.
    expect(v7Profile.decoyField!.fieldName).not.toBe(v8Profile.decoyField!.fieldName);

    // Deployment default is NOW 8, with the bound recipe the experiment
    // assigned. The submit carries the v7 cookie.
    const enforcement = new NullEnforcement();
    const d = deps(8, { enforcement, recipe: { families: ["decoy-field"] } as never });
    const req = new Request("http://mw/signup", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        csrf,
        form: { name: "A", email: "a@b.c", [v7Profile.decoyField!.fieldName]: "decoy-hit" },
      }),
    });
    const res = await admit(req, d, async () => HTML);

    // The v7 decoy field must have been STRIPPED from the forward (the
    // middleware reconstructed the v7 profile — the v8 field name would
    // have survived the strip and leaked into the upstream form).
    expect(res.kind).toBe("deny"); // decoy populated ⇒ class-B evidence ⇒ REVIEW-deny
    expect(enforcement.lastForm).toBeNull(); // never forwarded
    // And the deny was a SCORING decision, not an infrastructure reject.
    expect((res as { disposition?: string }).disposition).toBe("REVIEW");
  });

  it("resolveSession returns the envelope's pv/kid (the context middleware consumes)", async () => {
    const adapter = new ReferenceSessionAdapter(SECRET, { version: 7, keyId: "k7" });
    const sessionId = await adapter.createSession();
    const cookie = await adapter.sessionCookie(sessionId);
    const req = new Request("http://mw/signup", { headers: { cookie } });
    const ctx = await adapter.resolveSession(req);
    expect(ctx).not.toBeNull();
    expect(ctx!.id).toBe(sessionId);
    expect(ctx!.profileVersion).toBe(7);
    expect(ctx!.keyId).toBe("k7");
    expect(typeof ctx!.issuedAt).toBe("number");
  });

  it("the canary GET path derives under the envelope pv (route token parity)", async () => {
    // A v7-issued route token must verify under a v8 deployment default.
    const issuingAdapter = new ReferenceSessionAdapter(SECRET, { version: 7 });
    const sessionId = await issuingAdapter.createSession();
    const cookie = await issuingAdapter.sessionCookie(sessionId);
    const v7Profile = await deriveProfilePure(
      { secret: SECRET, version: 7, sessionId, mode: "production" },
      { families: ["decoy-route"] }
    );
    const d = deps(8, {
      recipe: { families: ["decoy-route"] } as never,
      canaryStore: new (await import("../../src/host-adapter/index.js")).ReferenceCanaryStore(),
    });
    const probe = new Request(`http://mw/c/${v7Profile.decoyRoute!.endpointToken}`, {
      headers: { cookie },
    });
    const res = await admit(probe, d, async () => HTML);
    // Verified under the ENVELOPE's version — 204, not an INVALID_TOKEN deny
    // from re-deriving the v8 token.
    expect(res.kind).toBe("canary-verified");
  });
});
