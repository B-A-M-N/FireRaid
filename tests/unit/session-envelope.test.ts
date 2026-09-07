/**
 * FR-P1-19: stateless signed production session envelope.
 *
 * Covers the audit-mandated cases:
 *   - issue/verify round-trip (happy path)
 *   - tamper rejection (payload edit, signature edit, truncation, wrong prefix)
 *   - expiry and future-dating
 *   - unknown-kid fail-closed
 *   - rotation: envelope signed under a PREVIOUS key still verifies, and the
 *     returned secret is the one derivation must use
 *   - lab-vs-production cookie-shape discrimination
 *
 * Materialization (ensureSessionRow) needs a D1 binding; those cases live in
 * the integration suite (tests/integration/session-envelope-flow.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  signSessionEnvelope,
  verifySessionEnvelope,
  isEnvelopeCookie,
} from "../../src/core/session-envelope.js";
import type { ProfileKeyRing } from "../../src/core/session.js";

const NOW = 1_700_000_000_000;
const PV = 1;
const SID = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 chars base64url (16 bytes)
const KEY_A = { id: "k1", secret: "profile-secret-a-0123456789abcdef-0123456789abcdef" };
const KEY_B = { id: "k2", secret: "profile-secret-b-0123456789abcdef-0123456789abcdef" };

const RING_A: ProfileKeyRing = { current: KEY_A };
const RING_B: ProfileKeyRing = {
  current: KEY_B,
  previous: { [KEY_A.id]: KEY_A.secret },
};

describe("FR-P1-19: session envelope — issue/verify", () => {
  it("round-trips: signed envelope verifies with payload + signing secret", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const verdict = await verifySessionEnvelope(RING_A, env, NOW + 1000);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.sid).toBe(SID);
      expect(verdict.payload.iat).toBe(NOW);
      expect(verdict.payload.pv).toBe(PV);
      expect(verdict.payload.kid).toBe(KEY_A.id);
      expect(verdict.secret).toBe(KEY_A.secret);
    }
  });

  it("shape: fr1.<body>.<sig>, three dot-separated parts", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const parts = env.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("fr1");
    // base64url: no padding, no + or /
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("isEnvelopeCookie discriminates envelope vs bare sid by shape", () => {
    const env = "fr1.abc.def";
    const bare = "AAAAAAAAAAAAAAAAAAAAAA";
    expect(isEnvelopeCookie(env)).toBe(true);
    expect(isEnvelopeCookie(bare)).toBe(false);
  });
});

describe("FR-P1-19: session envelope — fail-closed verification", () => {
  it("rejects an edited payload byte (signature covers the original body)", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const [p, body, sig] = env.split(".");
    // Flip a character in the middle of the body.
    const mid = Math.floor(body.length / 2);
    const swapped = body[mid] === "A" ? "B" : "A";
    const tampered = `${p}.${body.slice(0, mid)}${swapped}${body.slice(mid + 1)}.${sig}`;
    const verdict = await verifySessionEnvelope(RING_A, tampered, NOW + 1000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(["BAD_SIGNATURE", "MALFORMED", "BAD_PAYLOAD"]).toContain(verdict.code);
  });

  it("rejects an edited signature", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const [p, body, sig] = env.split(".");
    const swapped = sig[0] === "A" ? "B" : "A";
    const verdict = await verifySessionEnvelope(RING_A, `${p}.${body}.${swapped}${sig.slice(1)}`, NOW + 1000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(["BAD_SIGNATURE", "MALFORMED"]).toContain(verdict.code);
  });

  it("rejects a truncated envelope and a wrong prefix", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    expect((await verifySessionEnvelope(RING_A, "fr1.onlybody", NOW)).ok).toBe(false);
    expect((await verifySessionEnvelope(RING_A, env.replace(/^fr1\./, "fr2."), NOW)).ok).toBe(false);
    expect((await verifySessionEnvelope(RING_A, "", NOW)).ok).toBe(false);
    // A bare session id is NOT an envelope.
    expect((await verifySessionEnvelope(RING_A, SID, NOW)).ok).toBe(false);
  });

  it("rejects payload forgery: attacker re-signs with their own key", async () => {
    // Attacker controls kid + secret but not the ring: unknown kid fails closed.
    const forged = await signSessionEnvelope(
      { current: { id: "evil", secret: "attacker-secret-0123456789abcdef-0123456789abcdef" } },
      SID, NOW, PV
    );
    const verdict = await verifySessionEnvelope(RING_A, forged, NOW + 1000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("UNKNOWN_KEY");
  });

  it("rejects a payload whose pv/sid fields were swapped with another valid envelope's", async () => {
    const sid2 = "BBBBBBBBBBBBBBBBBBBBBB";
    const envA = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const envB = await signSessionEnvelope(RING_A, sid2, NOW, PV);
    const bodyA = envA.split(".")[1];
    const sigB = envB.split(".")[2];
    // Splice A's payload with B's signature: invalid.
    const verdict = await verifySessionEnvelope(RING_A, `fr1.${bodyA}.${sigB}`, NOW + 1000);
    expect(verdict.ok).toBe(false);
  });

  it("rejects expired envelopes and future-dated ones beyond slack", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    // Older than SESSION_TTL_MS (30 min).
    const expired = await verifySessionEnvelope(RING_A, env, NOW + 31 * 60 * 1000);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("EXPIRED");
    // Exactly at TTL boundary is still valid.
    const atTtl = await verifySessionEnvelope(RING_A, env, NOW + 30 * 60 * 1000);
    expect(atTtl.ok).toBe(true);

    const future = await signSessionEnvelope(RING_A, SID, NOW + 10 * 60 * 1000, PV);
    const futureVerdict = await verifySessionEnvelope(RING_A, future, NOW);
    expect(futureVerdict.ok).toBe(false);
    if (!futureVerdict.ok) expect(futureVerdict.code).toBe("FROM_FUTURE");
  });

  it("accepts an envelope signed under a PREVIOUS key (rotation window) and returns that key's secret", async () => {
    // Signed when KEY_A was current; verify after rotation to KEY_B.
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    const verdict = await verifySessionEnvelope(RING_B, env, NOW + 1000);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.kid).toBe(KEY_A.id);
      // CRITICAL: the secret returned is the PREVIOUS key's, so profile
      // derivation at materialization uses the key that issued the session.
      expect(verdict.secret).toBe(KEY_A.secret);
    }
  });

  it("rejects an envelope whose kid is unknown AFTER the previous-map drops it", async () => {
    const env = await signSessionEnvelope(RING_A, SID, NOW, PV);
    // Rotation moved k1 out of the previous map entirely (two rotations).
    const ringC: ProfileKeyRing = { current: KEY_B };
    const verdict = await verifySessionEnvelope(ringC, env, NOW + 1000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("UNKNOWN_KEY");
  });
});

describe("FR-RR-38: profile-hash validation (fr2.ph)", () => {
  const PH = "a".repeat(64);

  /** Forge an fr2 envelope with an arbitrary ph, signed GENUINELY with
   * KEY_A — so only the ph payload rule can reject it. */
  async function forgeFr2(ph: unknown): Promise<string> {
    const payload = { v: 2, sid: SID, iat: NOW, pv: PV, kid: KEY_A.id, ph };
    const b64 = (s: string) =>
      btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const body = b64(JSON.stringify(payload));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(KEY_A.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`fr2.${body}`));
    const sigB64 = b64(String.fromCharCode(...new Uint8Array(sig)));
    return `fr2.${body}.${sigB64}`;
  }

  it("issuance REFUSES a malformed profileHash (wrong length / non-hex / placeholder)", async () => {
    for (const bad of [
      "a".repeat(63), // truncated
      "a".repeat(65), // overlong
      "A".repeat(64), // uppercase
      "g".repeat(64), // non-hex
      "<required issued hash>", // a placeholder that would never verify
      "",
    ]) {
      await expect(
        signSessionEnvelope(RING_A, SID, NOW, PV, { profileHash: bad })
      ).rejects.toThrow(/64 lowercase hex/);
    }
  });

  it("issuance still accepts a valid hash (fr2) and an absent one (fr1)", async () => {
    const fr2 = await signSessionEnvelope(RING_A, SID, NOW, PV, { profileHash: PH });
    expect(fr2.startsWith("fr2.")).toBe(true);
    expect((await verifySessionEnvelope(RING_A, fr2, NOW)).ok).toBe(true);
    const fr1 = await signSessionEnvelope(RING_A, SID, NOW, PV);
    expect(fr1.startsWith("fr1.")).toBe(true);
    expect((await verifySessionEnvelope(RING_A, fr1, NOW)).ok).toBe(true);
  });

  it("verification REJECTS a genuinely-signed fr2 whose ph is not 64 lowercase hex (BAD_PAYLOAD)", async () => {
    for (const badPh of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), ""]) {
      const forged = await forgeFr2(badPh);
      const verdict = await verifySessionEnvelope(RING_A, forged, NOW);
      expect(verdict.ok, `ph=${JSON.stringify(badPh).slice(0, 14)}`).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("BAD_PAYLOAD");
    }
  });

  it("a genuinely-signed fr2 with a VALID ph still verifies (control)", async () => {
    expect((await verifySessionEnvelope(RING_A, await forgeFr2(PH), NOW)).ok).toBe(true);
  });
});
