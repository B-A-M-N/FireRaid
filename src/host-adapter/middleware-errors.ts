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
