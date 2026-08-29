/**
 * Turnstile server-side verification (FR-INV: server authoritative).
 * FIX: Test mode uses structural validation without calling Cloudflare API.
 */
export interface TurnstileVerifyResult {
  ok: boolean;
  hostname?: string;
  action?: string;
  errorCodes?: string[];
}

export interface TurnstileVerifyRequest {
  token: string;
  secret: string;
  remoteip?: string;
  expectedAction?: string;
  expectedHostname?: string;
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token.
 * In test mode, validates structure without calling Cloudflare API.
 * In production, always uses real Siteverify API.
 */
export async function verifyTurnstile(
  req: TurnstileVerifyRequest
): Promise<TurnstileVerifyResult> {
  // Test mode: validate structure without Cloudflare API call
  if (TURNSTILE_TEST_MODE) {
    return mockVerifyTurnstile(req);
  }

  // Production: real Cloudflare Siteverify
  return realVerifyTurnstile(req);
}

async function realVerifyTurnstile(
  req: TurnstileVerifyRequest
): Promise<TurnstileVerifyResult> {
  const body = new URLSearchParams();
  body.set("secret", req.secret);
  body.set("response", req.token);
  if (req.remoteip) body.set("remoteip", req.remoteip);

  try {
    const resp = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      return { ok: false, errorCodes:[`http_${resp.status}`] };
    }
    const json = (await resp.json()) as { success: boolean; hostname?: string; action?: string; "error-codes"?: string[] };
    
    // Validate action if expected
    if (req.expectedAction && json.success) {
      if (json.action !== req.expectedAction) {
        return { ok: false, errorCodes: ["wrong_action"] };
      }
    }
    
    // Validate hostname if expected
    if (req.expectedHostname && json.success) {
      if (json.hostname !== req.expectedHostname) {
        return { ok: false, errorCodes: ["wrong_hostname"] };
      }
    }
    
    return {
      ok: json.success === true,
      hostname: json.hostname,
      action: json.action,
      errorCodes: json["error-codes"],
    };
  } catch (err) {
    return { ok: false, errorCodes: ["fetch_error"] };
  }
}

/**
 * Mock verification for test mode.
 * Validates token structure without calling Cloudflare API.
 * 
 * Cloudflare test secrets behavior:
 * - always-pass: any non-empty token succeeds
 * - always-fail: any token fails
 * - duplicate: first call succeeds, subsequent fail
 */
function mockVerifyTurnstile(
  req: TurnstileVerifyRequest
): TurnstileVerifyResult {
  // Check for known test secrets
  const isAlwaysPass = req.secret === "1x00000000000000000000000000000000AA";
  const isAlwaysFail = req.secret === "1x00000000000000000000000000000000BB";
  
  // Validate token is non-empty
  if (!req.token || req.token.length === 0) {
    return { ok: false, errorCodes: ["missing_input_response"] };
  }
  
  if (isAlwaysPass) {
    // Always-pass secret: any non-empty token succeeds
    return {
      ok: true,
      hostname: req.expectedHostname || "localhost",
      action: req.expectedAction || "fireraid_signup",
    };
  }
  
  if (isAlwaysFail) {
    return { ok: false, errorCodes: ["invalid_input_response"] };
  }
  
  // For non-test secrets in test mode, validate token format
  // Real tokens are ~200 chars, dummy test tokens are short
  if (req.token.length < 10) {
    return { ok: false, errorCodes: ["invalid_input_response"] };
  }
  
  return {
    ok: true,
    hostname: req.expectedHostname || "localhost",
    action: req.expectedAction || "fireraid_signup",
  };
}

/**
 * Test mode flag.
 * Set via environment variable TURNSTILE_TEST_MODE=true
 */
let TURNSTILE_TEST_MODE = false;

export function setTurnstileTestMode(enabled: boolean): void {
  TURNSTILE_TEST_MODE = enabled;
}

export function isTestMode(): boolean {
  return TURNSTILE_TEST_MODE;
}

/**
 * Initialize test mode from environment.
 * Call this during Worker startup.
 */
export function initTestMode(env: { TURNSTILE_TEST_MODE?: string }): void {
  TURNSTILE_TEST_MODE = env.TURNSTILE_TEST_MODE === "true";
}

/** Known Cloudflare test secrets — production config must reject these. */
export const KNOWN_TEST_SECRETS = new Set([
  "1x00000000000000000000000000000000AA", // always passes
  "1x00000000000000000000000000000000BB", // always fails
  "1x00000000000000000000000000000000CC", // token already spent
]);

export function looksLikeTestKey(secret: string): boolean {
  return KNOWN_TEST_SECRETS.has(secret) || /^1x0{30}[A-Fa-f]{2}$/.test(secret);
}
