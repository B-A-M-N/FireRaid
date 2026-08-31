/**
 * Host-neutral admission service — adapter contracts (P1-25, FR-R7-034).
 *
 * FireRaid's defense core (src/core/*) is host-independent. This module
 * defines the seam a host integration plugs into so the SAME deterministic
 * core can sit in front of an ordinary upstream signup app the host owns
 * (the P1-24 middleware proof) or a Cloudflare Worker (the existing path).
 *
 * The middleware proof exercises exactly this seam: an ordinary upstream
 * ledger app that knows nothing about FireRaid, with a reference adapter in
 * front that injects artifacts on GET, evaluates before forwarding POST,
 * strips FireRaid fields, and forwards only when admission allows.
 *
 * Contracts:
 *  - HostSessionAdapter    — opaque session id + cookie issuance/parsing.
 *  - HostRenderAdapter      — inject DefenseArtifacts into the upstream HTML.
 *  - HostVerificationAdapter— verify the admission decision is enforceable.
 *  - HostTelemetryAdapter   — receive/normalize coarse interaction telemetry.
 *  - HostEnforcementAdapter — emit the admission decision to the upstream.
 *
 * Every adapter is fail-closed: a thrown error MUST be treated by the
 * middleware as "do not forward" (admission denied), never "forward anyway".
 */

import type { DefenseProfile } from "../types/profile.js";

/** Re-exported so adapters need not reach into core directly. */
export type { DefenseProfile };

/**
 * Opaque session identity + cookies.
 * The host owns storage; FireRaid only needs a stable opaque id.
 */
export interface HostSessionAdapter {
  /** Create a new opaque session id (host may persist whatever it needs). */
  createSession(): Promise<string>;
  /** Build the Set-Cookie header value(s) for a fresh session. */
  sessionCookie(sessionId: string): string;
  /** Parse the incoming session id from a Request (null = no session). */
  readSessionId(req: Request): string | null;
}

/**
 * Render/inject adapter — mutate the upstream signup HTML to carry the
 * FireRaid artifacts. Implementations: Cloudflare HTMLRewriter, string
 * replacement (reference/Node), or a DOM library.
 */
export interface HostRenderAdapter {
  /**
   * Inject the artifacts produced by the core into the upstream page.
   * @param html        the upstream signup page HTML (must contain </form>)
   * @param profile     the issued defense profile (carries decoy field, route)
   * @param csrfToken   the CSRF token to embed
   * @param labMode     whether to emit lab-only visible markers
   */
  inject(
    html: string,
    profile: DefenseProfile,
    csrfToken: string,
    labMode: boolean
  ): string;
}

/**
 * Verification adapter — confirm the submission's admission decision is
 * enforceable before forwarding to the upstream. In production this wraps
 * Turnstile; the reference adapter can use a no-op (verification "none").
 */
export interface HostVerificationAdapter {
  /**
   * @returns true if the submission may be forwarded (verification passed or
   *          not required); false if admission must be denied.
   */
  verify(req: Request, profile: DefenseProfile): Promise<boolean>;
}

/**
 * Telemetry adapter — accept a coarse interaction batch from the client and
 * return the observations the core correlates. The upstream never sees the
 * raw stream; only the derived verdict matters.
 */
export interface HostTelemetryAdapter {
  /** Normalize a submitted telemetry batch into a consumption-safe shape. */
  accept(batch: unknown): { seq: number; kind: string; target?: string }[];
}

/**
 * Enforcement adapter — emit the decision to the upstream.
 *
 * The middleware calls `allow()` only when the core's disposition is not
 * QUARANTINE/REVIEW-deny. `deny()` records the refusal without forwarding.
 *
 * The upstream ledger is the PRIMARY experimental truth in the middleware
 * proof: a synthetic account exists in the origin ledger IFF `allow()` was
 * called AND the upstream accepted the forwarded registration.
 */
export interface HostEnforcementAdapter {
  /**
   * Forward the (FireRaid-stripped) registration to the upstream.
   * @returns true if the upstream created the account (the experiment's
   *          positive event); false if the upstream rejected it.
   */
  allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string
  ): Promise<boolean>;
  /** Record a denied submission (never forwarded). */
  deny(sessionId: string, reason: string): void;
}
