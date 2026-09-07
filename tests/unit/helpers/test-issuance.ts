/**
 * FR-RR-27 test helper — issue a REAL session cookie for direct (non-GET)
 * session construction in tests.
 *
 * The reference session adapter is an issued-hash carrier and the
 * coordinator drift-checks the signed hash against the re-derived profile
 * (FR-RR-12), so a test that mints its own cookie MUST sign the hash of
 * the profile the middleware will actually derive from
 * (secret, version, sessionId, mode/recipe). A fabricated digest fails
 * closed with PROFILE_HASH_MISMATCH — by design.
 */
import { ReferenceSessionAdapter } from "../../../src/host-adapter/index.js";
import {
  deriveProductionProfileByVersion,
  deriveEvaluationProfileByVersion,
  hashProfileByVersion,
} from "../../../src/core/profile-versions.js";
import type { DefenseRecipe } from "../../../src/core/profile.js";

/** The real (version, keyId, profileHash) issuance tuple for a test session. */
export async function issuedCookie(
  adapter: ReferenceSessionAdapter,
  secret: string,
  sessionId: string,
  version = 1,
  keyId = "default",
  lab?: { recipe?: DefenseRecipe }
): Promise<string> {
  const profile = lab
    ? await deriveEvaluationProfileByVersion(
        { secret, version, sessionId, mode: "lab" },
        lab.recipe
      )
    : await deriveProductionProfileByVersion({ secret, version, sessionId });
  const profileHash = await hashProfileByVersion(profile, version);
  return adapter.sessionCookie(sessionId, { profileVersion: version, profileKeyId: keyId, profileHash });
}

/**
 * Sign the hash of an ALREADY-DERIVED profile — for tests that know the
 * exact derivation the middleware will run (e.g. an evaluation recipe in
 * production mode) and derived that profile themselves.
 */
export async function issuedCookieForProfile(
  adapter: ReferenceSessionAdapter,
  sessionId: string,
  profile: Awaited<ReturnType<typeof deriveProductionProfileByVersion>>,
  version = 1,
  keyId = "default"
): Promise<string> {
  const profileHash = await hashProfileByVersion(profile, version);
  return adapter.sessionCookie(sessionId, { profileVersion: version, profileKeyId: keyId, profileHash });
}
