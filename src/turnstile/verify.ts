/**
 * Turnstile server-side verification (FR-INV: server authoritative).
 * FIX: Single Siteverify path — no runtime mock/test-mode bypass.
 *
 * Namespace separation (FR-R3-004): Cloudflare's test credentials live in
 * two DIFFERENT namespaces. Sitekeys (public, rendered client-side) are
 * `1x00000000000000000000AA` (22 hex chars); secrets (server-side) are
 * `1x0000000000000000000000000000000AA` (31 zeros + 2 hex). Conflating them
 * is how test-mode sitekeys pass as secrets.
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

import type {
  VerificationProvider,
  VerificationRequest,
  VerificationResult,
} from "../security/verification.js";

/**
 * Verify a Turnstile token. Always calls the real Siteverify API — there is
 * no runtime test-mode path. Local/e2e environments run without
 * TURNSTILE_SECRET_KEY, in which case the submit route skips Turnstile
 * entirely (see routes/submit.ts).
 */
export async function verifyTurnstile(
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
      return { ok: false, errorCodes: [`http_${resp.status}`] };
    }
    const json = (await resp.json()) as {
      success: boolean;
      hostname?: string;
      action?: string;
      "error-codes"?: string[];
    };

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
  } catch {
    return { ok: false, errorCodes: ["fetch_error"] };
  }
}

/**
 * Documented Cloudflare TEST SECRETS (server-side namespace, 31 zeros).
 * Production config must reject these.
 */
export const KNOWN_TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA", // always passes
  "2x0000000000000000000000000000000AA", // always fails
  "3x0000000000000000000000000000000AA", // token already spent
]);

/**
 * Documented Cloudflare TEST SITEKEYS (client-side namespace, 20 zeros).
 * Used by client widgets; never valid as server secrets.
 */
export const KNOWN_TEST_SITEKEYS = new Set([
  "1x00000000000000000000AA", // always passes
  "2x00000000000000000000AA", // always fails (invisible)
  "3x00000000000000000000AA", // forced interactive
]);

const TEST_SECRET_PATTERN = /^[123]x0{31}[A-Fa-f]{2}$/;
// Documented sitekey form: 20 zeros + 2 hex (len 24). Legacy docs also used
// 22 zeros + AA (len 26) — matched for defense-in-depth.
const TEST_SITEKEY_PATTERN = /^[123]x0{20}[A-Fa-f]{2}$|^[123]x0{22}[A-Fa-f]{2}$/;

/** Detects a Cloudflare test secret (server-side namespace). */
export function looksLikeTestSecret(secret: string): boolean {
  return KNOWN_TEST_SECRETS.has(secret) || TEST_SECRET_PATTERN.test(secret);
}

/** Detects a Cloudflare test sitekey (client-side namespace). */
export function looksLikeTestSiteKey(sitekey: string): boolean {
  return KNOWN_TEST_SITEKEYS.has(sitekey) || TEST_SITEKEY_PATTERN.test(sitekey);
}

/**
 * Back-compat alias for the secret check (pre-R3 callers).
 * Namespace-correct: only matches SECRETS, never sitekeys.
 */
export function looksLikeTestKey(secret: string): boolean {
  return looksLikeTestSecret(secret);
}

/**
 * FR-R7-026: Turnstile-backed VerificationProvider for the Cloudflare
 * reference deployment. Operators can implement their own
 * VerificationProvider and inject it instead — the core submit route no
 * longer assumes Turnstile.
 */
export class TurnstileVerificationProvider implements VerificationProvider {
  readonly name = "turnstile";
  constructor(private readonly secret: string) {}

  async verify(req: VerificationRequest): Promise<VerificationResult> {
    return verifyTurnstile({
      token: req.token,
      secret: this.secret,
      remoteip: req.remoteip,
      expectedAction: req.expectedAction,
      expectedHostname: req.expectedHostname,
    });
  }
}

/**
 * Factory used by submit.ts to obtain the configured provider. The Cloudflare
 * deployment defaults to Turnstile when TURNSTILE_SECRET_KEY is set; if a
 * deployer ever supplies a different provider implementation via env /
 * plugin, this factory is the swap point.
 */
export function defaultVerificationProvider(env: {
  TURNSTILE_SECRET_KEY?: string;
}): VerificationProvider | null {
  if (!env.TURNSTILE_SECRET_KEY) return null;
  return new TurnstileVerificationProvider(env.TURNSTILE_SECRET_KEY);
}
