/**
 * Shared Worker entry foundation — the production config gate both Worker
 * entrypoints (src/index.ts = lab/evaluation plane, src/worker-production.ts
 * = product plane) run before serving any request.
 *
 * FR-P0-05-style closure: a misconfigured deployment (weak secrets, a
 * malformed profile-version/key-ring, a production deployment carrying test
 * Turnstile credentials, or a production deployment whose envelope key is a
 * known test key) must 503, never serve traffic. Both planes share THIS
 * gate so the eval plane and the production plane cannot diverge on what is
 * a runnable configuration.
 */
import type { Env } from "./env.js";
import { isLabMode, validateProfileVersionConfig } from "./env.js";
import { validateProfileKeyRing } from "./core/session.js";
import { looksLikeTestSiteKey, looksLikeTestSecret } from "./turnstile/verify.js";

/** FR-P1-05: name the config the production Worker must reject as a whole;
 * this helper is the single source of truth for "is this configuration
 * safe to start a worker with". */
export function validateConfig(env: Env): string | null {
  // Always validate cryptographic secrets first
  if (!env.FIRERAID_PROFILE_SECRET || env.FIRERAID_PROFILE_SECRET.length < 32) {
    return "FIRERAID_PROFILE_SECRET must be at least 32 characters";
  }
  if (!env.FIRERAID_CSRF_SECRET || env.FIRERAID_CSRF_SECRET.length < 32) {
    return "FIRERAID_CSRF_SECRET must be at least 32 characters";
  }

  // FR-R5-044: PROFILE_VERSION must be valid at startup, not first derivation
  const versionError = validateProfileVersionConfig(env);
  if (versionError) return versionError;

  // FR-R7-002: malformed key-ring configuration is a startup failure, not a
  // silent degradation. A session written today must still reconstruct after
  // rotation tomorrow — a silently-discarded PREVIOUS map (resolved by an
  // older resolveProfileKey) would corrupt historical sessions.
  const keyRingError = validateProfileKeyRing(env);
  if (keyRingError) return keyRingError;

  // Production-specific restrictions
  if (!isLabMode(env)) {
    // P1 (P0-AUDIT-3 follow-up): the ONLY way a LAB_MODE=false deployment may
    // run without Turnstile is the explicit local-test opt-in — an env var a
    // real deployment never sets. This keeps release-test infrastructure off
    // developers' .dev.vars.production files (the review's P1 item) without
    // weakening real production: absent the flag, production still requires
    // real credentials.
    if (env.TURNSTILE_MODE === "disabled-test") {
      // Local production-shape testing: Turnstile OFF. Any real credential
      // configured alongside the flag is a configuration mistake.
      if (env.TURNSTILE_SITE_KEY || env.TURNSTILE_SECRET_KEY) {
        return "TURNSTILE_MODE=disabled-test forbids TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY";
      }
    } else {
      // Production: reject known test sitekeys
      if (env.TURNSTILE_SITE_KEY && looksLikeTestSiteKey(env.TURNSTILE_SITE_KEY)) {
        return "Production LAB_MODE=false but TURNSTILE_SITE_KEY looks like a test key";
      }

      // Production: reject known test secrets
      if (env.TURNSTILE_SECRET_KEY && looksLikeTestSecret(env.TURNSTILE_SECRET_KEY)) {
        return "Production LAB_MODE=false but TURNSTILE_SECRET_KEY looks like a test secret";
      }

      // Production: require TURNSTILE_EXPECTED_HOSTNAME
      if (!env.TURNSTILE_EXPECTED_HOSTNAME) {
        return "Production requires TURNSTILE_EXPECTED_HOSTNAME";
      }

      // Production: require Turnstile to be enabled
      if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
        return "Production requires both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY";
      }

      // FR-P1-07: the in-isolate login map is a secondary, per-isolate guard;
      // a production deployment MUST also declare an authoritative edge
      // limiter for /api/admin/login (Cloudflare WAF rate-limit rule / Access
      // / the ratelimit binding). FIRERAID_RATE_LIMIT_LOGIN is that
      // declaration (its value names the rule/plan; presence is what matters).
      // Without it the deployment's only login protection is a single
      // isolate's best-effort map — not an acceptable brute-force contract for
      // a real production admin surface.
      if (!env.FIRERAID_RATE_LIMIT_LOGIN || env.FIRERAID_RATE_LIMIT_LOGIN === "REPLACE_WITH_EDGE_LIMITER_NAME") {
        return "Production requires FIRERAID_RATE_LIMIT_LOGIN (declare the authoritative edge rate-limiter for /api/admin/login)";
      }
    }
  }

  // Validate Turnstile sitekey/secret pairing (all environments)
  if (env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY) {
    return "TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is missing";
  }
  if (env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY) {
    return "TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is missing";
  }

  return null;
}

/**
 * Per-request config gate with memoization. Both entrypoints run this once
 * on first request and 503 on any config problem (never leaking the config
 * detail publicly).
 */
export function makeConfigGate() {
  let configError: string | null | undefined;
  return (env: Env): string | null => {
    if (configError === undefined) {
      configError = validateConfig(env);
    }
    return configError;
  };
}