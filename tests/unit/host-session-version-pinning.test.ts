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
  makeCsrf,
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  type HostEnforcementAdapter,
  ReferenceCanaryStore,
  ReferenceSubmissionStore,
} from "../../src/host-adapter/index.js";
import {
  admitEvaluation,
  type EvaluationMiddlewareDeps,
} from "../../src/eval/evaluation-middleware.js";

const SECRET = "k".repeat(64);

class NullEnforcement implements HostEnforcementAdapter {
  lastForm: Record<string, string> | null = null;
  async allow(_u: string, form: Record<string, string>): Promise<boolean> {
    this.lastForm = form;
    return true;
  }
  deny(): void {}
}

function deps(version: number, over: Partial<EvaluationMiddlewareDeps> = {}): EvaluationMiddlewareDeps {
  return {
    secret: SECRET,
    version,
    upstreamRegisterUrl: "https://upstream.invalid/api/register",
    session: new ReferenceSessionAdapter(SECRET, { version }),
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new NullEnforcement(),
    canaryStore: new ReferenceCanaryStore(),
    submissionStore: new ReferenceSubmissionStore(),
    labMode: false,
    // Fail-closed assertions (non-ACCEPT denies) — enforcement posture.
    enforcementMode: "enforcement",
    ...over,
  };
}

const HTML = '<html><body><form id="signup-form"></form></body></html>';

describe("P1-1: middleware consumes the envelope's pv (version pinning)", () => {
  it("a pv=7 cookie under a v1 deployment FAILS CLOSED (never runs v1 under pv=7)", async () => {
    // The sessions were ISSUED at version 7. The profile registry today has
    // only ONE FROZEN version (v1), so version 7 has no frozen implementation
    // (FR-P0-04). The middleware MUST consume the envelope's pv — and, finding
    // it unsupported, fail closed with an operational error rather than derive
    // the v1 treatment under a mismatched number. If it silently fell back to
    // deps.version (v1) the request would proceed — the exact pre-FR-P0-04
    // version-drift the registry exists to stop.
    const issuingAdapter = new ReferenceSessionAdapter(SECRET, { version: 7 });
    const sessionId = await issuingAdapter.createSession();
    const cookie = await issuingAdapter.sessionCookie(sessionId);
    const csrf = await makeCsrf(SECRET, sessionId);

    const enforcement = new NullEnforcement();
    const d = deps(1, {
      enforcement,
      recipe: { families: ["decoy-field"] } as never,
    });
    const req = new Request("http://mw/signup", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        csrf,
        form: { name: "A", email: "a@b.c", decoy_field: "decoy-hit" },
      }),
    });
    const res = await admitEvaluation(req, d, async () => HTML);

    // The envelope's pv=7 was consumed; UNSUPPORTED_PROFILE_VERSION fails
    // closed as an operational error — never an applicant-facing denial, and
    // never a silent derive-under-wrong-version (the forward stays undone).
    expect(res.kind).toBe("error");
    expect((res as { operationalReason?: string }).operationalReason).toBe("SUBMIT_EVAL_ERROR");
    expect(enforcement.lastForm).toBeNull(); // never forwarded on an unsupported version
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

  it("the canary GET path consumes the envelope pv and FAILS CLOSED on an unsupported version", async () => {
    // A pv=7-issued canary probe must NOT be verified by re-deriving under a
    // different number. With only v1 frozen, the envelope's pv=7 is consumed
    // and fails closed as an operational error (never INVALID_TOKEN, which
    // would claim the treatment WAS verified-then-rejected — version drift
    // must stay an infrastructure failure, not an applicant rejection).
    const issuingAdapter = new ReferenceSessionAdapter(SECRET, { version: 7 });
    const sessionId = await issuingAdapter.createSession();
    const cookie = await issuingAdapter.sessionCookie(sessionId);
    const d = deps(1, {
      recipe: { families: ["decoy-route"] } as never,
      canaryStore: new (await import("../../src/host-adapter/index.js")).ReferenceCanaryStore(),
    });
    const probe = new Request("http://mw/c/some-token", { headers: { cookie } });
    const res = await admitEvaluation(probe, d, async () => HTML);
    expect(res.kind).toBe("error");
    expect((res as { operationalReason?: string }).operationalReason).toBe("CANARY_EVAL_ERROR");
  });
});
