/**
 * FR-R7-026: Verification provider abstraction.
 *
 * The generic FireRaid core depends on a small VerificationProvider
 * interface; the concrete Turnstile provider lives in src/turnstile/. Other
 * deployments can ship a different provider (hCaptcha, Recaptcha, custom
 * signed-token challenge) without touching the core routes.
 *
 * Cloudflare's reference deployment defaults to Turnstile — its Free tier
 * is free and allows unlimited challenges, so it adds no inference bill and
 * no FireRaid-side rate limit. Operators who do not want a Cloudflare
 * dependency can swap the provider at startup.
 */

export interface VerificationRequest {
  /** Provider-issued token presented by the client. */
  token: string;
  /** Client IP per request (Cloudflare `cf-connecting-ip`). */
  remoteip?: string;
  /** Optional provider-issued nonce the provider expects to see. */
  expectedAction?: string;
  /** Optional hostname the provider asserts the challenge ran against. */
  expectedHostname?: string;
}

export interface VerificationResult {
  ok: boolean;
  hostname?: string;
  action?: string;
  errorCodes?: string[];
}

/**
 * Provider interface — one verify() per submitted token. Implementations
 * MUST be fail-closed (return ok=false rather than throw on transport
 * failures) so the route can record the attempt and surface a clear
 * "verification_required" to the client.
 */
export interface VerificationProvider {
  readonly name: string;
  verify(req: VerificationRequest): Promise<VerificationResult>;
}
