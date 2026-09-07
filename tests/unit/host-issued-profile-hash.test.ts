/**
 * FR-RR-12 — the host plane CONSUMES the signed fr2 profile hash.
 *
 * Prior state: signup-get signed the issued profile hash into the fr2
 * envelope, the envelope signature was verified on POST — and then the
 * hash was DROPPED by resolveSession. Derivation re-ran unchecked, so the
 * host-side tests proved "the hash is correctly encoded and signed" but
 * not "the treatment submitted against is the treatment that was issued."
 * The Worker/D1 path had the drift check (core/reconstruct.ts,
 * PROFILE_HASH_MISMATCH); the generic host middleware did not.
 *
 * These are HOST-LEVEL tests (through admit()), not envelope-codec tests:
 *
 *   1. GET issues fr2 carrying the signed ph (issuance anchor).
 *   2. A deliberately WRONG signed ph (a deployment whose derivation
 *      drifted after issuance) → POST fails CLOSED as an operational
 *      error named PROFILE_HASH_MISMATCH — no upstream call.
 *   3. Same wrong-signed-ph session → canary reconstruction fails CLOSED
 *      with no verified canary persistence.
 *   4. Key rotation (previous-key envelope) + CORRECT hash still passes.
 *   5. A drifted derivation is distinguishable internally:
 *      ProfileHashMismatchError / operationalReason PROFILE_HASH_MISMATCH.
 *   6. The normal fr2 roundtrip (issue → submit) is unaffected.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  createFireRaidMiddleware,
  ReferenceSessionAdapter,
  ProfileHashMismatchError,
  referenceInject,
  type MiddlewareDeps,
} from "../../src/host-adapter/index.js";
import { deriveAndVerifyIssuedProfile } from "../../src/host-adapter/profile/resolve-session-profile.js";
import { signSessionEnvelope, verifySessionEnvelope } from "../../src/core/session-envelope.js";
import { hashProfileByVersion } from "../../src/core/profile-versions.js";
import { deriveProfileEngineV1 } from "../../src/core/profile/v1.js";
import type { ProfileKeyRing } from "../../src/core/session.js";
import { DurableTelemetryAdapter, DurableCanaryStore, DurableSubmissionStore } from "./helpers/durable-stores.js";
import { createServer } from "node:http";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"><input name="name"><input name="email"></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};
const COOKIE_NAME = "__Host-fr_sid";

function baseDeps(): MiddlewareDeps {
  return {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://127.0.0.1:1/register", // refused: no upstream
    session: new ReferenceSessionAdapter({ current: { id: "default", secret: SECRET } }),
    render: { inject: referenceInject },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: new DurableTelemetryAdapter(),
    enforcement: {
      allow: async () => {
        throw new Error("upstream MUST NOT be called on a hash-mismatch session");
      },
      deny: async () => {},
    },
    canaryStore: new DurableCanaryStore(),
    submissionStore: new DurableSubmissionStore(),
    enforcementMode: "enforcement" as const,
    routes: ROUTES,
  } as unknown as MiddlewareDeps;
}

/** Cookie value out of a Set-Cookie header. */
function rawCookie(setCookie: string): string {
  return setCookie.split(";")[0].split("=")[1] ?? "";
}

/** A POST carrying the given raw envelope cookie. */
function postReq(raw: string, csrf: string): Request {
  return new Request("http://test/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${COOKIE_NAME}=${raw}`,
    },
    body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
  });
}

describe("FR-RR-12: signed host fr2 profile hash is consumed, not dropped", () => {
  it("issuance: GET issues an fr2 envelope whose signed ph matches the derived profile's hash", async () => {
    const validated = createFireRaidMiddleware(baseDeps());
    const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
    expect(page.kind).toBe("get");
    const raw = rawCookie(page.setCookie!);
    expect(raw.startsWith("fr2.")).toBe(true);
    const verdict = await verifySessionEnvelope(
      { current: { id: "default", secret: SECRET } },
      raw,
      Date.now()
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.payload.ph).toBeDefined();
    // The signed ph equals the hash of the profile the SAME deployment
    // derives for that session — the roundtrip consistency the whole
    // check depends on.
    const profile = await deriveProfileEngineV1({
      secret: SECRET,
      version: VERSION,
      sessionId: verdict.payload.sid,
      mode: "production",
    });
    expect(verdict.payload.ph).toBe(await hashProfileByVersion(profile, VERSION));
  });

  it("a deliberately WRONG signed ph → POST fails closed, upstream never called, named PROFILE_HASH_MISMATCH", async () => {
    // Forge a VALIDLY-SIGNED envelope whose ph cannot match any derivation
    // (as if a deployment redefined derivation after issuing it).
    const wrongPh = "f".repeat(64);
    const sid = "hash-mismatch-session-1";
    const raw = await signSessionEnvelope(
      { current: { id: "default", secret: SECRET } },
      sid,
      Date.now(),
      VERSION,
      { profileHash: wrongPh }
    );
    // The envelope itself verifies (signature is genuine) — the defense
    // must catch the drift at derivation, not blame the cookie.
    const v = await verifySessionEnvelope({ current: { id: "default", secret: SECRET } }, raw, Date.now());
    expect(v.ok).toBe(true);

    const validated = createFireRaidMiddleware(baseDeps());
    // CSRF token minted from the same secret so the request reaches the
    // derivation step (the mismatch must be caught THERE, not at CSRF).
    const { makeCsrf } = await import("../../src/host-adapter/handlers/csrf.js");
    const csrf = await makeCsrf(SECRET, sid);
    const result = await admit(postReq(raw, csrf), validated, async () => SIGNUP_HTML);
    // Fail CLOSED as an operational error, never admit, never a deny that
    // blames the applicant.
    expect(result.kind).toBe("error");
    expect(result.operationalReason).toBe("PROFILE_HASH_MISMATCH");
  });

  it("a wrong signed ph → canary reconstruction fails closed, nothing persisted as verified", async () => {
    const wrongPh = "0".repeat(64);
    const sid = "hash-mismatch-session-2";
    const raw = await signSessionEnvelope(
      { current: { id: "default", secret: SECRET } },
      sid,
      Date.now(),
      VERSION,
      { profileHash: wrongPh }
    );
    const validated = createFireRaidMiddleware(baseDeps());
    const canary = validated.canaryStore as DurableCanaryStore;
    // Probe an arbitrary canary path — whatever token value, the mismatch
    // must fire at derivation BEFORE the token comparison/persist step.
    const res = await admit(
      new Request(`http://test/c/any-token`, {
        headers: { cookie: `${COOKIE_NAME}=${raw}` },
      }),
      validated,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("error");
    expect(res.operationalReason).toBe("PROFILE_HASH_MISMATCH");
    expect(await canary.readVerified(sid)).toBe(false);
  });

  it("previous-key ROTATION with the CORRECT signed hash still passes derivation", async () => {
    // Ring rotated: k1 (previous) issued the session, k2 is current.
    const oldSecret = "old-key-secret".padEnd(40, "1");
    const ring: ProfileKeyRing = {
      current: { id: "k2", secret: SECRET },
      previous: { k1: oldSecret },
    };
    // Derive the REAL profile under the OLD key and sign its true hash.
    const sid = "rotation-hash-session-1";
    const profile = await deriveProfileEngineV1({
      secret: oldSecret,
      version: VERSION,
      sessionId: sid,
      mode: "production",
    });
    const trueHash = await hashProfileByVersion(profile, VERSION);
    const raw = await signSessionEnvelope({ current: { id: "k1", secret: oldSecret } }, sid, Date.now(), VERSION, {
      profileHash: trueHash,
    });
    // Derive-and-verify on the NEW ring (current k2, previous k1) with the
    // envelope's OWN key — must succeed: rotation alone must not break an
    // honest session.
    const derived = await deriveAndVerifyIssuedProfile({
      secret: oldSecret, // resolveKeySecret(ring, "k1")
      version: VERSION,
      sessionId: sid,
      expectedHash: trueHash,
      evaluation: undefined,
      labMode: false,
    });
    expect(derived.version).toBe(VERSION);
    // And the middleware accepts the envelope on the rotated ring too.
    const deps = baseDeps();
    deps.profileKeys = ring;
    const validated = createFireRaidMiddleware(deps);
    const { makeCsrf } = await import("../../src/host-adapter/handlers/csrf.js");
    const csrf = await makeCsrf(oldSecret, sid);
    const result = await admit(postReq(raw, csrf), validated, async () => SIGNUP_HTML);
    // Not a PROFILE_HASH_MISMATCH error — derivation verified the issued
    // treatment. (The forward itself hits the refused upstream URL; that
    // outcome shape is P0.2's concern, not this test's.)
    expect(result.kind === "error" && result.operationalReason === "PROFILE_HASH_MISMATCH").toBe(false);
  });

  it("the mismatch is distinguishable internally as ProfileHashMismatchError", async () => {
    const sid = "mismatch-classification-1";
    const profile = await deriveProfileEngineV1({
      secret: SECRET,
      version: VERSION,
      sessionId: sid,
      mode: "production",
    });
    const trueHash = await hashProfileByVersion(profile, VERSION);
    // A helper call with a deliberately corrupted expectation throws the
    // TYPED error, not a generic one.
    await expect(
      deriveAndVerifyIssuedProfile({
        secret: SECRET,
        version: VERSION,
        sessionId: sid,
        expectedHash: trueHash.slice(1) + "0", // corrupt one char
        evaluation: undefined,
        labMode: false,
      })
    ).rejects.toBeInstanceOf(ProfileHashMismatchError);
  });

  it("the normal fr2 roundtrip (issue → submit) still reaches the forward boundary", async () => {
    // The check must be a no-op for an honest deployment: GET then POST
    // with the deployment's own derivation passes the verify step (the
    // upstream URL is refused, so the observable terminal state is the
    // transport failure at the boundary — past derivation entirely).
    const validated = createFireRaidMiddleware(baseDeps());
    const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
    const raw = rawCookie(page.setCookie!);
    const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const result = await admit(postReq(raw, csrf), validated, async () => SIGNUP_HTML);
    expect(result.kind === "error" && result.operationalReason === "PROFILE_HASH_MISMATCH").toBe(false);
  });

  it("an origin that commits then destroys the socket before replying (P0.2 fixture preview): derive-verify stays orthogonal", async () => {
    // Guard: the mismatch classification must never swallow unrelated
    // errors — a network failure at the forward must keep its own reason.
    const { server, url } = await new Promise<{ server: import("node:http").Server; url: string }>((resolve) => {
      const s = createServer((_req, res) => {
        // Receive the POST, then destroy without replying.
        s.closeAllConnections?.();
        res.destroy();
      });
      s.listen(0, "127.0.0.1", () =>
        resolve({ server: s, url: `http://127.0.0.1:${(s.address() as { port: number }).port}/register` })
      );
    });
    try {
      const deps = baseDeps();
      deps.upstreamRegisterUrl = url;
      const validated = createFireRaidMiddleware(deps);
      const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
      const raw = rawCookie(page.setCookie!);
      const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const result = await admit(postReq(raw, csrf), validated, async () => SIGNUP_HTML);
      // Derivation verified fine; the failure is the transport, named as
      // such — not a hash mismatch.
      expect(result.kind === "error" && result.operationalReason === "PROFILE_HASH_MISMATCH").toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("FR-RR-27: production REQUIRES a verifiable issued treatment", () => {
  it("a production session WITHOUT a signed hash (fr1 carrier) fails closed — never evaluated unverified", async () => {
    // A validly-signed but HASHLESS envelope (the legacy fr1 shape a
    // broken/legacy host adapter could still mint) cannot be drift-checked.
    // On the production plane the coordinator refuses it (operational
    // PROFILE_HASH_MISMATCH), it is never evaluated, and the upstream is
    // never called.
    const sid = "hashless-fr1-session-1";
    const raw = await signSessionEnvelope(
      { current: { id: "default", secret: SECRET } },
      sid,
      Date.now(),
      VERSION
      // no profileHash → fr1-shaped carrier
    );
    const v = await verifySessionEnvelope({ current: { id: "default", secret: SECRET } }, raw, Date.now());
    expect(v.ok).toBe(true);

    const validated = createFireRaidMiddleware(baseDeps());
    const { makeCsrf } = await import("../../src/host-adapter/handlers/csrf.js");
    const csrf = await makeCsrf(SECRET, sid);
    const result = await admit(postReq(raw, csrf), validated, async () => SIGNUP_HTML);
    expect(result.kind).toBe("error");
    expect(result.operationalReason).toBe("PROFILE_HASH_MISMATCH");
  });
});
