/**
 * FR-P0-04 — PROFILE VERSION selects an IMMUTABLE derivation implementation.
 *
 * Before this module, `version` only salted the PRF seed
 * (`deriveSeed(secret, version, sessionId)`) while every version executed
 * the CURRENT engine: current strategy pool, current templates, current
 * artifact rules, current scoring. A session envelope issued under one
 * deployed implementation and submitted after another deployment — both
 * claiming `pv=1` — silently reconstructed a DIFFERENT treatment than the
 * one issued, violating the architecture contract:
 *
 *     Immutable per version; exact reconstruction from
 *     (secret, version, sessionId).
 *
 * The contract now:
 *
 *   - SUPPORTED_PROFILE_VERSIONS names the versions with a FROZEN
 *     implementation on disk (v1 today). Deriving or reconstructing an
 *     unsupported version FAILS CLOSED — it never falls through to "current".
 *   - deriveProductionProfileByVersion / deriveEvaluationProfileByVersion
 *     dispatch to the frozen implementation for the requested version.
 *   - v1 is pinned by tests/unit/profile-golden.test.ts: complete golden
 *     profiles (families, strategy, template, placement, spots, field name,
 *     element id, route token, nonce, telemetry mask, scoring policy,
 *     variant id, carrier identity) for fixed (secret, version, sessionId)
 *     triples. If V1 behavior changes in ANY observable dimension, the goldens
 *     fail — the release cannot silently redefine an already-issued version.
 *     Changing treatment semantics REQUIRES introducing v2 and freezing v1.
 */

import {
  deriveProductionProfile,
  deriveEvaluationProfile,
  type EvaluationProfileOptions,
  type ProductionProfileOptions,
} from "./profile.js";
import type { DefenseRecipe } from "./recipe-schema.js";
import type { DefenseProfile } from "../types/profile.js";

/**
 * The registry of FROZEN profile versions. Version 1 is the derivation
 * engine AS SHIPPED at this source tree's v1 freeze — pinned by golden
 * profiles, never edited except to fix a proof of incorrectness in the
 * freeze itself (and then with a ledger note). A semantics change must add
 * `2: ...` here and leave v1 untouched.
 */
export const SUPPORTED_PROFILE_VERSIONS = [1] as const;

export type SupportedProfileVersion = (typeof SUPPORTED_PROFILE_VERSIONS)[number];

export function isSupportedProfileVersion(v: number): v is SupportedProfileVersion {
  return (SUPPORTED_PROFILE_VERSIONS as readonly number[]).includes(v);
}

/** Fail-closed version resolution for any derivation/reconstruction entry. */
export function assertSupportedProfileVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0 || !isSupportedProfileVersion(version)) {
    throw new Error(
      `UNSUPPORTED_PROFILE_VERSION: ${version} (supported: ${SUPPORTED_PROFILE_VERSIONS.join(", ")}) — ` +
        `derivation refuses to run CURRENT code for an unknown version; ` +
        `freeze an implementation for it first`
    );
  }
}

/**
 * Production derivation with TRUE version dispatch. The version selects the
 * frozen implementation; an unsupported version is a hard error, never a
 * silent run of current code under an old number.
 */
export async function deriveProductionProfileByVersion(
  opts: ProductionProfileOptions
): Promise<DefenseProfile> {
  assertSupportedProfileVersion(opts.version);
  // v1: the engine as frozen at this tree (pinned by profile-golden tests).
  return deriveProductionProfile(opts);
}

/**
 * Evaluation derivation with the same true version dispatch.
 */
export async function deriveEvaluationProfileByVersion(
  opts: EvaluationProfileOptions,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  assertSupportedProfileVersion(opts.version);
  return deriveEvaluationProfile(opts, recipe);
}
