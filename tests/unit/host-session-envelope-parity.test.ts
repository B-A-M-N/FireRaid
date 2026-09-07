/**
 * P1-AUDIT-2 Phase D (audit item 9) — signed host session context:
 * ENVELOPE PARITY with the Worker's FR-P1-19.
 *
 * The reference session adapter now issues the SAME core envelope the
 * Worker path uses (core/session-envelope.ts): fr1.<b64url payload>.<sig>
 * with payload {v, sid, iat, pv, kid}. These tests pin that the host plane
 * gets the FR-P1-19 properties, not just a tamper tag:
 *
 *   1. FORMAT parity: cookie value parses with verifySessionEnvelope — one
 *      format, one verifier, both planes.
 *   2. TAMPER: any body/signature edit → resolveSession null (fail-closed).
 *   3. TTL: an expired envelope is rejected (the context-free tag had NO
 *      server-side lifetime at all).
 *   4. FUTURE-DATED: iat beyond clock slack → rejected.
 *   5. ROTATION: an envelope signed under the previous ring key still
 *      verifies; an unknown-kid envelope fails closed.
 *   6. VERSION CARRIAGE: payload.pv records the issuance profile version —
 *      the input a host needs to re-derive the SAME profile for an
 *      in-flight session across a version bump (the hazard the tag
 *      ignored).
 *   7. PARITY with the Worker issuer: signSessionEnvelope output for the
 *      same (ring, sid, iat, pv) is byte-identical to what the adapter
 *      embeds — same signer, same secrets.
 */
import { describe, it, expect } from "vitest";
import { ReferenceSessionAdapter } from "../../src/host-adapter/index.js";
import {
  signSessionEnvelope,
  verifySessionEnvelope,
} from "../../src/core/session-envelope.js";
import type { ProfileKeyRing } from "../../src/core/session.js";

const SECRET = "host-envelope-parity-secret".padEnd(32, "x");
/** The adapter signs with the real clock; tests verify on the same clock. */
const nowMs = () => Date.now();

function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0].split("=")[1] ?? "";
}

/** A ring like the adapter's, sharing its key id + secret. */
const RING: ProfileKeyRing = { current: { id: "default", secret: SECRET } };

describe("host session envelope parity (audit item 9)", () => {
  it("FORMAT parity: the adapter's cookie verifies with the CORE verifier", async () => {
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    // FR-RR-27: the reference adapter is an issued-hash carrier — the
    // middleware's GET path always passes the complete issuance; direct
    // calls in this test do the same.
    const cookie = await adapter.sessionCookie(sid, {
      profileVersion: 1,
      profileKeyId: "default",
      profileHash: "a".repeat(64),
    });
    const raw = cookieValue(cookie);

    expect(raw.startsWith("fr2.")).toBe(true);
    const verdict = await verifySessionEnvelope(RING, raw, nowMs());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.sid).toBe(sid);
      expect(verdict.payload.pv).toBe(1);
      expect(verdict.payload.kid).toBe("default");
      // iat is approximately the issuance wall clock.
      expect(Math.abs(verdict.payload.iat - nowMs())).toBeLessThan(5_000);
    }
  });

  it("FR-RR sunset rule: a hash-carrying issuance produces fr2 with the signed ph claim", async () => {
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    // What the GET handler now passes: the issued profile's hash.
    const ph = "a".repeat(64);
    const raw = cookieValue(
      await adapter.sessionCookie(sid, { profileVersion: 1, profileKeyId: "default", profileHash: ph })
    );
    expect(raw.startsWith("fr2.")).toBe(true);
    const verdict = await verifySessionEnvelope(RING, raw, nowMs());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.v).toBe(2);
      expect(verdict.payload.ph).toBe(ph);
      expect(verdict.payload.sid).toBe(sid);
    }
  });

  it("TAMPER: flipped body/signature bit → resolveSession null (fail-closed)", async () => {
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    // FR-RR-27: the reference adapter is an issued-hash carrier — direct
    // sessionCookie calls must carry a hash (tests use a fixed digest).
    const raw = cookieValue(
      await adapter.sessionCookie(sid, { profileVersion: 1, profileKeyId: "default", profileHash: "a".repeat(64) })
    );
    const [prefix, body, sig] = raw.split(".");

    // Flip one character of the body (sid edit attempt).
    const flippedBody =
      body.slice(0, -2) +
      (body.at(-2) === "A" ? "B" : "A") +
      body.at(-1);
    const tampered = new ReferenceSessionAdapter(SECRET);
    const req1 = new Request("http://mw/", {
      headers: { cookie: `__Host-fr_sid=${prefix}.${flippedBody}.${sig}` },
    });
    expect(await tampered.resolveSession(req1)).toBeNull();

    // Flip one character of the signature.
    const flippedSig =
      sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    const req2 = new Request("http://mw/", {
      headers: { cookie: `__Host-fr_sid=${prefix}.${body}.${flippedSig}` },
    });
    expect(await tampered.resolveSession(req2)).toBeNull();

    // Cross-signing: valid envelope from a DIFFERENT secret → rejected.
    const other = new ReferenceSessionAdapter("other-secret".padEnd(32, "y"));
    const forged = cookieValue(
      await other.sessionCookie(sid, { profileVersion: 1, profileKeyId: "default", profileHash: "a".repeat(64) })
    );
    const req3 = new Request("http://mw/", {
      headers: { cookie: `__Host-fr_sid=${forged}` },
    });
    expect(await tampered.resolveSession(req3)).toBeNull();

    // The untampered cookie still verifies.
    const reqOk = new Request("http://mw/", {
      headers: { cookie: `__Host-fr_sid=${raw}` },
    });
    const ok = await tampered.resolveSession(reqOk);
    expect(ok?.id).toBe(sid);
  });

  it("TTL: an expired envelope is rejected (the old tag had no lifetime)", async () => {
    const sid = "expired-session-0001";
    // Signed in the past: iat = NOW - SESSION_TTL_MS - 1.
    const stale = await signSessionEnvelope(RING, sid, nowMs() - (30 * 60 * 1000 + 1), 1);
    const adapter = new ReferenceSessionAdapter(SECRET);
    const req = new Request("http://mw/", {
      headers: { cookie: `__Host-fr_sid=${stale}` },
    });
    expect(await adapter.resolveSession(req)).toBeNull();
  });

  it("FUTURE-DATED: iat beyond clock slack → rejected", async () => {
    const sid = "future-session-00001";
    const future = await signSessionEnvelope(RING, sid, nowMs() + 60_000, 1);
    const verdict = await verifySessionEnvelope(RING, future, nowMs());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("FROM_FUTURE");
  });

  it("ROTATION: previous-key envelope verifies; unknown kid fails closed", async () => {
    const oldRing: ProfileKeyRing = {
      current: { id: "k1", secret: SECRET },
    };
    const newRing: ProfileKeyRing = {
      current: { id: "k2", secret: "rotation-secret".padEnd(32, "z") },
      previous: { k1: SECRET },
    };
    const sid = "rotation-session-1";

    // Envelope signed under the OLD key still verifies on the NEW ring.
    const oldEnvelope = await signSessionEnvelope(oldRing, sid, nowMs(), 1);
    const ok = await verifySessionEnvelope(newRing, oldEnvelope, nowMs());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.kid).toBe("k1");

    // Unknown kid → fail closed.
    const unknownRing: ProfileKeyRing = {
      current: { id: "k2", secret: "rotation-secret".padEnd(32, "z") },
    };
    const bad = await verifySessionEnvelope(unknownRing, oldEnvelope, nowMs());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("UNKNOWN_KEY");
  });

  it("VERSION CARRIAGE: pv records the ISSUANCE profile version (FR-RR-17)", async () => {
    // FR-RR-17: the adapter no longer owns a version — the issuance call
    // names pv (and kid), and the adapter signs what it is told.
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    const raw = cookieValue(
      await adapter.sessionCookie(sid, { profileVersion: 7, profileKeyId: "default", profileHash: "7".repeat(64) })
    );
    const verdict = await verifySessionEnvelope(RING, raw, nowMs());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.pv).toBe(7);
  });

  it("PARITY with the Worker issuer: byte-identical envelope for same inputs", async () => {
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = "parity-session-0001";
    // The adapter signs with Date.now(); capture one envelope and re-derive
    // the core signature for the SAME (ring, sid, iat, pv) extracted from it.
    // FR-RR-27: the reference adapter is an issued-hash carrier — the call
    // carries a (fixed) hash; envelope PARITY is about the SIGNATURE over
    // (ring, sid, iat, pv), which does not cover the ph claim's VALUE.
    const raw = cookieValue(
      await adapter.sessionCookie(sid, { profileVersion: 1, profileKeyId: "default", profileHash: "a".repeat(64) })
    );
    const [, body, sig] = raw.split(".");
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as {
      iat: number;
      pv: number;
    };
    const expected = await signSessionEnvelope(RING, sid, payload.iat, payload.pv, {
      profileHash: "a".repeat(64),
    });
    expect(expected).toBe(raw);
    expect(sig.length).toBe(43); // base64url of 32 bytes, unpadded
  });
});
