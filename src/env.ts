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
  TURNSTILE_TEST_MODE?: string;

  // Secrets (from .dev.vars / wrangler secret)
  FIRERAID_PROFILE_SECRET: string;
  FIRERAID_CSRF_SECRET: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_SECRET?: string;

  // LLM harness (production defense MUST NOT use these)
  FIRERAID_LLM_BASE_URL?: string;
  FIRERAID_LLM_API_KEY?: string;
  FIRERAID_LLM_MODEL?: string;
}

export function isLabMode(env: Env): boolean {
  return env.LAB_MODE === "true";
}

export function profileVersion(env: Env): number {
  const v = Number.parseInt(env.PROFILE_VERSION, 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}
