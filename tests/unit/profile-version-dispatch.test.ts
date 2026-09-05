/**
 * FR-P0-04 — version dispatch + profile-hash drift detection.
 *
 * - reconstructIssuedProfile dispatches by the session's PERSISTED version:
 *   an unknown historical version fails closed (UNSUPPORTED_PROFILE_VERSION)
 *   instead of running current code under an old number.
 * - When the session persisted a profile hash at issuance, the reconstructed
 *   profile is compared against it; a mismatch is PROFILE_HASH_MISMATCH —
 *   a hard failure, never "close enough".
 */
import { describe, it, expect } from "vitest";
import { reconstructIssuedProfile, type ReconstructableSession } from "../../src/core/reconstruct.js";
import { deriveProductionProfile, hashProfile } from "../../src/core/profile.js";
import type { Env } from "../../src/env.js";

const SECRET = "drift-check-secret-0123456789abcdefghij";

function env(): Env {
  return {
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    FIRERAID_PROFILE_SECRET: SECRET,
  } as unknown as Env;
}

describe("FR-P0-04: reconstruction version dispatch", () => {
  it("an unsupported persisted version fails closed as UNSUPPORTED_PROFILE_VERSION", async () => {
    const session: ReconstructableSession = {
      id: "sess-old",
      profileVersion: 7, // a version with no frozen implementation
      profileKeyId: "default",
    };
    const r = await reconstructIssuedProfile(env(), session);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNSUPPORTED_PROFILE_VERSION");
      expect(r.detail).toMatch(/UNSUPPORTED_PROFILE_VERSION: 7/);
    }
  });

  it("a supported version reconstructs the exact issued profile", async () => {
    const issued = await deriveProductionProfile({
      secret: SECRET,
      version: 1,
      sessionId: "sess-current",
    });
    const r = await reconstructIssuedProfile(env(), {
      id: "sess-current",
      profileVersion: 1,
      profileKeyId: "default",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await hashProfile(r.profile)).toBe(await hashProfile(issued));
    }
  });
});

describe("FR-P0-04: profile-hash drift detection", () => {
  it("a matching stored hash reconstructs OK", async () => {
    const issued = await deriveProductionProfile({
      secret: SECRET,
      version: 1,
      sessionId: "sess-hash",
    });
    const storedHash = await hashProfile(issued);
    const r = await reconstructIssuedProfile(env(), {
      id: "sess-hash",
      profileVersion: 1,
      profileKeyId: "default",
      profileHash: storedHash,
    });
    expect(r.ok).toBe(true);
  });

  it("a MISMATCHED stored hash fails closed as PROFILE_HASH_MISMATCH", async () => {
    const r = await reconstructIssuedProfile(env(), {
      id: "sess-hash",
      profileVersion: 1,
      profileKeyId: "default",
      profileHash: "deadbeef".repeat(8), // any 64-hex value ≠ the real hash
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PROFILE_HASH_MISMATCH");
      expect(r.detail).toMatch(/differs from the hash persisted at issuance/);
    }
  });

  it("a session without a stored hash still reconstructs (legacy rows)", async () => {
    const r = await reconstructIssuedProfile(env(), {
      id: "sess-legacy",
      profileVersion: 1,
      profileKeyId: "default",
      profileHash: null,
    });
    expect(r.ok).toBe(true);
  });
});
