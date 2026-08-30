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
