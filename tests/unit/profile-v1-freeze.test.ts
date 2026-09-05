/**
 * FR-P0-04 (rereview P0-F) + FR-P0-G — the real v1 freeze and the signed
 * profile hash in the stateless envelope.
 *
 * P0-F: profile-versions v1 dispatches to core/profile/v1.ts + the frozen
 * catalog snapshot (profile/catalog-v1.ts), NOT the live engine. While the
 * live engine has not drifted, frozen-v1 and the live engine must remain
 * BYTE-EQUAL — this cross-check makes any drift visible (and is allowed to
 * be updated when a deliberate, versioned live-engine change lands).
 *
 * P0-G: the fr2 envelope carries the signed issued profile hash (`ph`), so
 * the first stateful write can prove the re-derived treatment equals the
 * issued one — closing the stateless deployment-straddle drift window
 * independently of D1.
 */
import { describe, it, expect } from "vitest";
import {
  deriveProductionProfileByVersion,
  deriveEvaluationProfileByVersion,
  hashProfileByVersion,
  isSupportedProfileVersion,
} from "../../src/core/profile-versions.js";
import {
  deriveProductionProfile,
  deriveEvaluationProfile,
  hashProfile,
} from "../../src/core/profile.js";
import {
  signSessionEnvelope,
  verifySessionEnvelope,
} from "../../src/core/session-envelope.js";
import type { ProfileKeyRing } from "../../src/core/session.js";

const SECRET = "freeze-crosscheck-secret-0123456789abcdef";

describe("P0-F: frozen v1 ≡ live engine (drift cross-check)", () => {
  const sessions = [
    "freeze-alpha",
    "freeze-beta",
    "freeze-gamma-0123456789abcdef",
  ];

  for (const sid of sessions) {
    it(`production byte-equality for ${sid}`, async () => {
      const frozen = await deriveProductionProfileByVersion({ secret: SECRET, version: 1, sessionId: sid });
      const live = await deriveProductionProfile({ secret: SECRET, version: 1, sessionId: sid });
      expect(frozen).toEqual(live);
      expect(await hashProfileV1Of(frozen)).toBe(await hashProfile(live));
    });

    it(`evaluation byte-equality for ${sid}`, async () => {
      const frozen = await deriveEvaluationProfileByVersion(
        { secret: SECRET, version: 1, sessionId: sid, mode: "lab", holdoutMode: true, turnstileRequired: true },
        { families: ["semantic", "interaction"] }
      );
      const live = await deriveEvaluationProfile(
        { secret: SECRET, version: 1, sessionId: sid, mode: "lab", holdoutMode: true, turnstileRequired: true },
        { families: ["semantic", "interaction"] }
      );
      expect(frozen).toEqual(live);
    });
  }

  async function hashProfileV1Of(p: Parameters<typeof hashProfile>[0]) {
    return hashProfileByVersion(p, 1);
  }
});

describe("P0-F: version registry sanity", () => {
  it("v1 is supported; out-of-range versions are not", () => {
    expect(isSupportedProfileVersion(1)).toBe(true);
    expect(isSupportedProfileVersion(0)).toBe(false);
    expect(isSupportedProfileVersion(2)).toBe(false);
    expect(isSupportedProfileVersion(Number.NaN)).toBe(false);
  });
});

describe("P0-G: fr2 envelope carries the signed profile hash", () => {
  const ring: ProfileKeyRing = { current: { id: "k1", secret: SECRET } };

  it("signSessionEnvelope with profileHash issues fr2 with ph; round-trips", async () => {
    const ph = "a".repeat(64);
    const raw = await signSessionEnvelope(ring, "sid-fr2", 1_000, 1, { profileHash: ph });
    expect(raw.startsWith("fr2.")).toBe(true);

    const verdict = await verifySessionEnvelope(ring, raw, 1_500);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.v).toBe(2);
      expect(verdict.payload.ph).toBe(ph);
    }
  });

  it("signSessionEnvelope without profileHash issues legacy fr1 without ph", async () => {
    const raw = await signSessionEnvelope(ring, "sid-fr1", 1_000, 1);
    expect(raw.startsWith("fr1.")).toBe(true);
    const verdict = await verifySessionEnvelope(ring, raw, 1_500);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.v).toBe(1);
      expect(verdict.payload.ph).toBeUndefined();
    }
  });

  it("a v2 payload missing ph fails closed (BAD_PAYLOAD)", async () => {
    // Hand-craft: valid fr2 shape, payload lacks ph.
    const payload = { v: 2, sid: "s", iat: 1_000, pv: 1, kid: "k1" };
    const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // Signature will not even be reached — payload validation first.
    const raw = `fr2.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const verdict = await verifySessionEnvelope(ring, raw, 1_500);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("BAD_PAYLOAD");
  });

  it("the signed ph is tamper-evident (edit → BAD_SIGNATURE)", async () => {
    const ph = "b".repeat(64);
    const raw = await signSessionEnvelope(ring, "sid-tamper", 1_000, 1, { profileHash: ph });
    const parts = raw.split(".");
    const decoded = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    decoded.ph = "c".repeat(64);
    const reencoded = btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const verdict = await verifySessionEnvelope(ring, `fr2.${reencoded}.${parts[2]}`, 1_500);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("BAD_SIGNATURE");
  });

  it("isEnvelopeCookie recognizes both formats; unknown prefixes rejected", async () => {
    const { isEnvelopeCookie } = await import("../../src/core/session-envelope.js");
    const fr2 = await signSessionEnvelope(ring, "sid-x", 1_000, 1, { profileHash: "d".repeat(64) });
    const fr1 = await signSessionEnvelope(ring, "sid-y", 1_000, 1);
    expect(isEnvelopeCookie(fr2)).toBe(true);
    expect(isEnvelopeCookie(fr1)).toBe(true);
    expect(isEnvelopeCookie("zzz.abc.def")).toBe(false);
    expect(isEnvelopeCookie("bare-sid")).toBe(false);
  });

  it("an fr2 envelope signed under a previous key still verifies (rotation)", async () => {
    const oldRing: ProfileKeyRing = { current: { id: "k-old", secret: SECRET } };
    const newRing: ProfileKeyRing = {
      current: { id: "k-new", secret: "n".repeat(64) },
      previous: { "k-old": SECRET },
    };
    const raw = await signSessionEnvelope(oldRing, "sid-rot", 1_000, 1, { profileHash: "e".repeat(64) });
    const verdict = await verifySessionEnvelope(newRing, raw, 1_500);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.ph).toBe("e".repeat(64));
  });
});

describe("P0-G: hashProfileByVersion dispatch", () => {
  it("v1 hash equals the shared hashProfile (the frozen hash semantics)", async () => {
    const p = await deriveProductionProfileByVersion({ secret: SECRET, version: 1, sessionId: "hash-dispatch" });
    expect(await hashProfileByVersion(p, 1)).toBe(await hashProfile(p));
  });
});
