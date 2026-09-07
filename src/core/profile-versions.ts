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
  type EvaluationProfileOptions,
  type ProductionProfileOptions,
} from "./profile.js";
import {
  deriveProfileEngineV1,
  hashProfileV1,
} from "./profile/v1.js";
import type { DefenseRecipe } from "./recipe-schema.js";
import type { DefenseProfile } from "../types/profile.js";

/**
 * The registry of FROZEN profile versions. Version 1 is the derivation
 * engine AS SHIPPED at this source tree's v1 freeze — pinned by golden
 * profiles, never edited except to fix a proof of incorrectness in the
 * freeze itself (and then with a ledger note). A semantics change must add
 * `2: ...` here and leave v1 untouched.
 *
 * FR-P0-04 (rereview P0-F): v1 is a REAL frozen implementation —
 * core/profile/v1.ts + profile/catalog-v1.ts, a verbatim engine + catalog
 * snapshot that the live profile.ts engine no longer shares. The live
 * catalogs and engine can evolve for v2; v1 keeps deriving exactly what it
 * derived at the freeze (the goldens pin it). The legacy delegation to
 * deriveProductionProfile/deriveEvaluationProfile remains ONLY as a
 * byte-equality cross-check in tests (the live engine has not drifted); it
 * is NOT the v1 derivation path.
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
 * FR-RR-30 — the dispatch is a REGISTRY, not a switch with a live-code
 * default. The old `default:` branches called the CURRENT engine as a
 * "fallback": adding `2` to SUPPORTED_PROFILE_VERSIONS without wiring a
 * frozen implementation would have silently derived v2 sessions with LIVE
 * code — the exact treatment-drift hazard the freeze exists to prevent.
 * A version derives ONLY through its registered implementation; any other
 * version is a hard error.
 */
const PROFILE_VERSION_IMPLEMENTATIONS: ReadonlyMap<
  number,
  {
    deriveProduction: (opts: ProductionProfileOptions) => Promise<DefenseProfile>;
    deriveEvaluation: (
      opts: EvaluationProfileOptions,
      recipe?: DefenseRecipe
    ) => Promise<DefenseProfile>;
    hash: (profile: DefenseProfile) => Promise<string>;
  }
> = new Map([
  [
    1,
    {
      // The FROZEN v1 implementation (profile/v1.ts + profile/catalog-v1.ts).
      deriveProduction: (opts) => deriveProfileEngineV1({ ...opts, mode: "production" }),
      deriveEvaluation: (opts, recipe) => deriveProfileEngineV1(opts, recipe),
      hash: (profile) => hashProfileV1(profile),
    },
  ],
]);

function implementationFor(version: number): {
  deriveProduction: (opts: ProductionProfileOptions) => Promise<DefenseProfile>;
  deriveEvaluation: (opts: EvaluationProfileOptions, recipe?: DefenseRecipe) => Promise<DefenseProfile>;
  hash: (profile: DefenseProfile) => Promise<string>;
} {
  const impl = PROFILE_VERSION_IMPLEMENTATIONS.get(version);
  if (!impl) {
    throw new Error(
      `UNSUPPORTED_PROFILE_VERSION: ${version} has no FROZEN implementation in the ` +
        `registry (registered: ${[...PROFILE_VERSION_IMPLEMENTATIONS.keys()].join(", ")}) — ` +
        `freeze an implementation for it first; there is NO live-code fallback`
    );
  }
  return impl;
}

/**
 * Production derivation with TRUE version dispatch. The version selects the
 * frozen implementation; an unregistered version is a hard error, never a
 * silent run of current code under an old number.
 */
export async function deriveProductionProfileByVersion(
  opts: ProductionProfileOptions
): Promise<DefenseProfile> {
  assertSupportedProfileVersion(opts.version);
  return implementationFor(opts.version).deriveProduction(opts);
}

/**
 * Evaluation derivation with the same true version dispatch.
 */
export async function deriveEvaluationProfileByVersion(
  opts: EvaluationProfileOptions,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  assertSupportedProfileVersion(opts.version);
  return implementationFor(opts.version).deriveEvaluation(opts, recipe);
}

/**
 * FR-P0-G: hash with the FROZEN semantics of the named version. The signed
 * profile hash in a v1 envelope (fr2's `ph` claim) must be verifiable with
 * the SAME hash function that issued it — a future v2 hash change must not
 * invalidate v1 sessions. Today v1 hashing is identical to the shared
 * hashProfile; the dispatch is the freeze guarantee.
 */
export async function hashProfileByVersion(
  profile: DefenseProfile,
  version: number
): Promise<string> {
  assertSupportedProfileVersion(version);
  return implementationFor(version).hash(profile);
}
