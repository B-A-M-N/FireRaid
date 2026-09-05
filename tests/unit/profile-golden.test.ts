/**
 * FR-P0-04 — GOLDEN PROFILE FREEZE for profile version 1.
 *
 * The audit finding: PROFILE_VERSION only salted the PRF seed while every
 * version executed the CURRENT engine — current strategy pool, current
 * templates, current artifact rules, current scoring. A session envelope
 * issued under one deployed implementation and submitted after another
 * deployment (both claiming pv=1) silently reconstructed a DIFFERENT
 * treatment than the one issued.
 *
 * These goldens pin the COMPLETE observable treatment identity for fixed
 * (secret, version, sessionId) triples — families, strategy, template,
 * placement, spots, field name, element id, route token, nonce, telemetry
 * mask, scoring policy, variant id, and the deep canonical profile hash —
 * so ANY semantic change to the v1 derivation fails here. That failure is
 * the release gate doing its job: changing treatment semantics REQUIRES
 * introducing version 2 (src/core/profile-versions.ts) and freezing v1 as
 * it was. Updating these strings without a version bump is forbidden.
 *
 * The secret here is a test-only constant; the goldens' authority comes
 * from being checked into the tree and compared byte-for-byte, not from
 * the secret's entropy.
 */
import { describe, it, expect } from "vitest";
import { deriveProductionProfileByVersion, deriveEvaluationProfileByVersion, isSupportedProfileVersion } from "../../src/core/profile-versions.js";
import { deriveProductionProfile, hashProfile } from "../../src/core/profile.js";
import type { DefenseProfile } from "../../src/types/profile.js";

const GOLDEN_SECRET = "golden-freeze-secret-0123456789abcdef";

/**
 * The complete v1 treatment identity for each fixed session — captured from
 * the derivation AS FROZEN. Sorted families for stable comparison; every
 * other field is the raw derived value.
 */
const GOLDENS: Array<{
  sessionId: string;
  profileId: string;
  profileVariantId: string;
  families: string[];
  scoringPolicy: string;
  telemetry: Record<string, boolean>;
  semantic: {
    templateId: string;
    placementId: string;
    spots: string[];
    spotCount: number;
    mode: string;
    nonce: string;
  } | null;
  decoyField: { fieldName: string; elementId: string } | null;
  decoyRoute: { endpointToken: string } | null;
  interaction: { scoringEnabled: boolean } | null;
  hash: string;
}> = [
  {
    sessionId: "golden-session-alpha",
    profileId: "7956e9610d548d87",
    profileVariantId: "bea4d18a2a456a855a7f6603f7aa371851e8ac7f65c3a50b948cd6ad9a72d27a",
    families: ["decoy-field", "decoy-route", "interaction", "semantic"],
    scoringPolicy: "default-v1",
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      captureKey: false,
      capturePointer: false,
      captureSubmit: true,
    },
    semantic: {
      templateId: "P04",
      placementId: "P06",
      spots: ["pre-form", "head-meta", "post-form"],
      spotCount: 3,
      mode: "observe",
      nonce: "2KMY58",
    },
    decoyField: { fieldName: "f5a013c80c8b34e3", elementId: "2c88d9fe283a9284" },
    decoyRoute: { endpointToken: "fb110bfeb4fd" },
    interaction: { scoringEnabled: true },
    hash: "e9e3113c63dc179994cbcaaf0e6a622a8a6eda4a6e120e5c94a5aebf9c8cede9",
  },
  {
    sessionId: "golden-session-beta",
    profileId: "c6090a3fe3a0c6ef",
    profileVariantId: "c332d3a811e3a93957d46c6c94458146653fccafc59039768a7c001de869d2c2",
    families: ["decoy-field", "decoy-route", "interaction", "semantic"],
    scoringPolicy: "default-v1",
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      captureKey: true,
      capturePointer: true,
      captureSubmit: true,
    },
    semantic: {
      templateId: "P04",
      placementId: "P06",
      spots: ["body-end", "post-form", "body-comment"],
      spotCount: 3,
      mode: "observe",
      nonce: "7QLJVL",
    },
    decoyField: { fieldName: "4c2296e4a118e40a", elementId: "1a39ddffc392518d" },
    decoyRoute: { endpointToken: "616c7409c7ec" },
    interaction: { scoringEnabled: true },
    hash: "13cf2e57c542eb2ea97aad558713155e935cf27b6da2115c9a6efec422a514c2",
  },
  {
    sessionId: "golden-session-gamma",
    profileId: "e0113ff07b9f4207",
    profileVariantId: "d473435d91506fc7b778f77e6b58e716b93f5bdac8d799df330d714effabae53",
    families: ["decoy-field", "decoy-route", "semantic"],
    scoringPolicy: "default-v1",
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      captureKey: false,
      capturePointer: false,
      captureSubmit: true,
    },
    semantic: {
      templateId: "P03",
      placementId: "P06",
      spots: ["head-meta", "body-comment"],
      spotCount: 2,
      mode: "decoy",
      nonce: "ZLJS48",
    },
    decoyField: { fieldName: "b2c3f236858658d7", elementId: "a37b817ff0f16ad2" },
    decoyRoute: { endpointToken: "47860c030993" },
    interaction: null,
    hash: "04f5171fa93cddd749c940e9721df15fda846539458c0be9b0ce3434eb0c5d4c",
  },
];

/** Project a derived profile to the golden comparison shape. */
async function project(p: DefenseProfile) {
  return {
    profileId: p.profileId,
    profileVariantId: p.profileVariantId,
    families: [...p.families].sort(),
    scoringPolicy: p.scoringPolicy,
    telemetry: { ...p.telemetry },
    semantic: p.semantic
      ? {
          templateId: p.semantic.templateId,
          placementId: p.semantic.placementId,
          spots: [...p.semantic.spots],
          spotCount: p.semantic.spotCount,
          mode: p.semantic.mode,
          nonce: p.semantic.nonce,
        }
      : null,
    decoyField: p.decoyField
      ? { fieldName: p.decoyField.fieldName, elementId: p.decoyField.elementId }
      : null,
    decoyRoute: p.decoyRoute ? { endpointToken: p.decoyRoute.endpointToken } : null,
    interaction: p.interaction ? { scoringEnabled: p.interaction.scoringEnabled } : null,
    hash: await hashProfile(p),
  };
}

describe("FR-P0-04: v1 golden profile freeze", () => {
  for (const g of GOLDENS) {
    it(`v1 derivation for ${g.sessionId} reproduces the frozen treatment EXACTLY`, async () => {
      const p = await deriveProductionProfileByVersion({
        secret: GOLDEN_SECRET,
        version: 1,
        sessionId: g.sessionId,
      });
      const actual = await project(p);
      expect(actual, `complete treatment identity for ${g.sessionId}`).toEqual({
        profileId: g.profileId,
        profileVariantId: g.profileVariantId,
        families: [...g.families].sort(),
        scoringPolicy: g.scoringPolicy,
        telemetry: g.telemetry,
        semantic: g.semantic,
        decoyField: g.decoyField,
        decoyRoute: g.decoyRoute,
        interaction: g.interaction,
        hash: g.hash,
      });
    });
  }

  it("derivation is deterministic across repeat calls (same inputs, same bytes)", async () => {
    const a = await deriveProductionProfileByVersion({
      secret: GOLDEN_SECRET,
      version: 1,
      sessionId: GOLDENS[0].sessionId,
    });
    const b = await deriveProductionProfileByVersion({
      secret: GOLDEN_SECRET,
      version: 1,
      sessionId: GOLDENS[0].sessionId,
    });
    expect(await hashProfile(b)).toBe(await hashProfile(a));
    expect(await hashProfile(a)).toBe(GOLDENS[0].hash);
  });

  it("an unsupported version FAILS CLOSED (never runs current code under an old number)", async () => {
    await expect(
      deriveProductionProfileByVersion({
        secret: GOLDEN_SECRET,
        version: 2,
        sessionId: "any",
      })
    ).rejects.toThrow(/UNSUPPORTED_PROFILE_VERSION: 2/);
    await expect(
      deriveEvaluationProfileByVersion({
        secret: GOLDEN_SECRET,
        version: 99,
        sessionId: "any",
        mode: "production",
      })
    ).rejects.toThrow(/UNSUPPORTED_PROFILE_VERSION: 99/);
  });

  it("the version registry is explicit and v1 is present", () => {
    expect(isSupportedProfileVersion(1)).toBe(true);
    expect(isSupportedProfileVersion(2)).toBe(false);
    expect(isSupportedProfileVersion(0)).toBe(false);
  });

  it("reconstruction through the versioned path matches the goldens (drift detection armed)", async () => {
    // The hash-comparison wiring (reconstruct.ts) uses hashProfile over the
    // same derived profile — verify the comparison holds for a golden so a
    // canonicalization change cannot silently defeat the drift check.
    const p = await deriveProductionProfile({
      secret: GOLDEN_SECRET,
      version: 1,
      sessionId: GOLDENS[1].sessionId,
    });
    expect(await hashProfile(p)).toBe(GOLDENS[1].hash);
  });
});
