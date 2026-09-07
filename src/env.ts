/**
 * FireRaid environment bindings and variables.
 * Everything the Worker needs at runtime, typed.
 *
 * LAB_MODE marks the Cloudflare Worker as the EVALUATION FIXTURE deployment.
 * It is an evaluation-layer concept, not a product operating mode — the product
 * (host middleware) has exactly one production contract and no lab switch.
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
  /** Injected by the production deploy wrapper; exposed by /health. */
  FIRERAID_BUILD_SHA?: string;
  /**
   * P1 (P0-AUDIT-3 follow-up): the ONLY sanctioned way a LAB_MODE=false
   * deployment runs without Turnstile — the local production-shape test
   * tier (wrangler env production-test). validateConfig rejects it in any
   * deployment that also carries real Turnstile credentials, and nothing
   * sets it outside the tracked test env. A real production deployment
   * never sets this.
   */
  TURNSTILE_MODE?: string;

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
  /**
   * P1-10: raw telemetry (event_batches payloads) retention window (days).
   * Defaults to RAW_TELEMETRY_RETENTION_DAYS (7); clamped to at most
   * FIRERAID_RETENTION_DAYS — raw payloads never outlive derived records.
   */
  FIRERAID_RAW_TELEMETRY_RETENTION_DAYS?: string;
  /**
   * FR-P0-01: review dataset (review_queue + review_calibration) retention
   * window (days). Defaults to REVIEW_RETENTION_DAYS (90); these records
   * deliberately outlive ordinary derived state for human calibration, but
   * are never immortal — the sweep reclaims them on this clock.
   */
  FIRERAID_REVIEW_RETENTION_DAYS?: string;
  /**
   * FR-P0-01: terminal lab-run (EXPIRED/ABANDONED/COMPLETE) retention window
   * (days). Defaults to LAB_RETENTION_DAYS (90); without it the lab
   * lifecycle's own terminal states would accumulate forever and pin their
   * sessions past the derived-records window.
   */
  FIRERAID_LAB_RETENTION_DAYS?: string;
  /** FR-R7-021: persist ALL production verification attempts (audit opt-in). */
  FIRERAID_AUDIT_VERIFICATION_ATTEMPTS?: string;
  /**
   * FR-P1-07: REQUIRED in real production. Declares the authoritative edge
   * rate-limiter for /api/admin/login (Cloudflare WAF rate-limit rule /
   * Access / the ratelimit binding). The in-isolate login map is a secondary
   * per-isolate guard only; validateConfig refuses a production deployment
   * that has not declared this limiter. Value is informational (names the
   * rule/plan); presence is what the gate checks.
   */
  FIRERAID_RATE_LIMIT_LOGIN?: string;
  /**
   * FR-RR (P2 sunset rule): explicit expiry for the legacy bare-SID session
   * fallback — an RFC-3339 date or epoch-ms. Bare-SID cookies resolve ONLY
   * while now() < this instant; the flag's ABSENCE is itself the sunset
   * (no flag = the fallback is dead). Production deployments that still
   * need the rotation window must declare a real expiry date, so the
   * "temporary" compatibility branch can no longer persist indefinitely
   * undocumented. See cloudflare/session-envelope.ts ensureSessionRow().
   */
  FIRERAID_LEGACY_SID_UNTIL?: string;
}

export function isLabMode(env: Env): boolean {
  return env.LAB_MODE === "true";
}

/**
 * FR-RR (P2 sunset rule): is the legacy bare-SID session fallback still
 * alive at `nowMs`? Yes ONLY when FIRERAID_LEGACY_SID_UNTIL is set to a
 * parseable instant in the future. Unset, malformed, or past — the fallback
 * is SUNSET and bare-SID cookies reject. This makes the compatibility
 * window an explicit operator declaration with a hard expiry instead of an
 * indefinite "temporary" branch.
 */
export function legacySidFallbackActive(env: Env, nowMs: number): boolean {
  const raw = env.FIRERAID_LEGACY_SID_UNTIL;
  if (raw === undefined || raw.trim() === "") return false;
  const until = Date.parse(raw);
  if (Number.isNaN(until)) return false;
  return nowMs < until;
}

/**
 * True when this Worker deployment IS the evaluation fixture (LAB_MODE=true).
 * The evaluation fixture hosts the experiment control plane; the product
 * (host middleware, see src/host-adapter/) is the production entry.
 * Product code must never import evaluation code; evaluation may import product.
 */
export function isEvaluationDeployment(env: Env): boolean {
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
