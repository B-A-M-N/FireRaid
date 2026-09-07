/**
 * Shared middleware error types (extracted from middleware.ts so config /
 * submission / handler modules can raise them without a cycle back into the
 * orchestrator).
 */

/** Error thrown when a session references a key id absent from the ring. */
export class UnknownProfileKeyError extends Error {
  constructor(kid: string) {
    super(`UNKNOWN_PROFILE_KEY: ${kid}`);
    this.name = "UnknownProfileKeyError";
  }
}

/**
 * P1-AUDIT-2 (audit item 17): startup capability validation.
 * Thrown by factory validation with a precise message on failure.
 */
export class MiddlewareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiddlewareConfigError";
  }
}

/**
 * FR-RR-12 (host parity for the Worker's FR-P0-G drift check): the profile
 * re-derived for a session does not match the profile hash SIGNED into the
 * session's fr2 envelope at issuance. The envelope signature was valid, so
 * this is not forgery — it means the deployment's derivation no longer
 * reproduces the treatment the session was actually shown (a deployment
 * straddle). Derivation succeeded but produced something else; failing
 * closed is the only honest answer. Callers surface this internally as the
 * operational reason "PROFILE_HASH_MISMATCH" (never serialized to
 * applicants).
 */
export class ProfileHashMismatchError extends Error {
  constructor(sessionId: string, expected: string, actual: string) {
    super(
      `PROFILE_HASH_MISMATCH: session ${sessionId} carries signed profile hash ` +
        `${expected.slice(0, 12)}… but re-derivation produced ${actual.slice(0, 12)}… — ` +
        `the deployed derivation no longer reproduces the issued treatment`
    );
    this.name = "ProfileHashMismatchError";
  }
}
