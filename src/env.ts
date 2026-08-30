/**
 * FireRaid environment bindings and variables.
 * Everything the Worker needs at runtime, typed.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  ASSETS: Fetcher;

  // Config (public)
  PROFILE_VERSION: string;
  LAB_MODE: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;

  // Secrets (from .dev.vars / wrangler secret)
  FIRERAID_PROFILE_SECRET: string;
  FIRERAID_CSRF_SECRET: string;
  ADMIN_SECRET?: string;
  /** Lab correlation API auth — required for lab-run create/get (FR-R4-030). */
  FIRERAID_LAB_API_SECRET?: string;

  // FR-R7-002: profile key-ring env (typed). Optional at the type level so
  // dev/test envs without rotation still bind; the validator (see
  // validateConfig in src/index.ts) is the runtime authority and rejects
  // malformed rings fail-closed.
  /** ID of the active profile key (defaults to "default" when absent). */
  FIRERAID_PROFILE_KEY_CURRENT_ID?: string;
  /** JSON object {"<id>":"<secret>"} of known previous keys. */
  FIRERAID_PROFILE_KEY_PREVIOUS?: string;

  /** FR-R7-025: scheduled retention sweep retention window (days). */
  FIRERAID_RETENTION_DAYS?: string;
  /** FR-R7-021: persist ALL production verification attempts (audit opt-in). */
  FIRERAID_AUDIT_VERIFICATION_ATTEMPTS?: string;
}

export function isLabMode(env: Env): boolean {
  return env.LAB_MODE === "true";
}

/**
 * Strict positive-integer parse (FR-R4-075).
 * Rejects "1garbage", "+1", "01", floats, and non-safe integers.
 */
export function parseStrictPositiveInt(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid PROFILE_VERSION: "${raw}" — must be a positive integer`);
  }
  const v = Number(raw);
  if (!Number.isSafeInteger(v)) {
    throw new Error(`Invalid PROFILE_VERSION: "${raw}" — exceeds safe integer range`);
  }
  return v;
}

export function profileVersion(env: Env): number {
  return parseStrictPositiveInt(env.PROFILE_VERSION);
}

/** Validate config-critical derived values at startup (FR-R5-044). */
export function validateProfileVersionConfig(env: Env): string | null {
  try {
    profileVersion(env);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid PROFILE_VERSION";
  }
}
