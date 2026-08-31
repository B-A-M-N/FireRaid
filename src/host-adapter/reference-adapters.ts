/**
 * Reference host adapters for the P1-24 middleware proof (Node/Express-style
 * ordinary upstream). Each adapter is fail-closed: throwing means "deny".
 */
import type {
  HostSessionAdapter,
  HostVerificationAdapter,
  HostTelemetryAdapter,
  HostEnforcementAdapter,
  HostCanaryStore,
} from "./interface.js";
import {
  signSessionEnvelope,
  verifySessionEnvelope,
  type SessionEnvelope,
} from "../core/session-envelope.js";
import type { ProfileKeyRing } from "../core/session.js";
import { validateTelemetryBatch, type ValidatedEvent } from "../security/request-validation.js";
import type { DefenseProfile } from "../types/profile.js";
import { getPolicyOrThrow, type ScoringPolicy } from "../core/decision.js";

const SESSION_COOKIE = "__Host-fr_sid";
const SESSION_TTL_S = 30 * 60;

/**
 * Reference session adapter — opaque id + SIGNED SESSION ENVELOPE cookie
 * (P1-AUDIT-2 Phase D, audit item 9: FR-P1-19 parity).
 *
 * History: the bare sid cookie was forgeable (an attacker could rewrite
 * `__Host-fr_sid` to any target session and have the victim's profile score
 * the attacker's submission). The first fix wrapped the sid in an HMAC tag
 * (`sid.marker`) — tamper-proof but context-free: no issued-at (no TTL) and
 * no profile version (a mid-session key bump silently re-derived a
 * DIFFERENT profile for an in-flight session — the exact rotation hazard
 * FR-P1-19 eliminated on the Worker).
 *
 * Now the cookie value IS the core production envelope:
 *
 *     fr1.<base64url({v,sid,iat,pv,kid} JSON)>.<base64url(HMAC-SHA256)>
 *
 * issued and verified through core/session-envelope.ts — the SAME functions
 * the Worker path uses — so both planes share one format, one verification
 * (signature, TTL expiry, future-dating, unknown-kid fail-closed) and one
 * rotation story (kid selects the signing key from the profile key ring).
 * Hosts that persist their own session state can consume the verified
 * payload via verifiedPayload() (e.g. to derive with the envelope's pv/kid
 * instead of the deployment default, mirroring ensureSessionRow).
 */
export class ReferenceSessionAdapter implements HostSessionAdapter {
  private readonly ring: ProfileKeyRing;
  private readonly version: number;

  constructor(secret: string, opts?: { version?: number; keyId?: string }) {
    this.ring = { current: { id: opts?.keyId ?? "default", secret } };
    this.version = opts?.version ?? 1;
  }

  async createSession(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async sessionCookie(sessionId: string): Promise<string> {
    const envelope = await signSessionEnvelope(this.ring, sessionId, Date.now(), this.version);
    return `${SESSION_COOKIE}=${envelope}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
  }

  /** Verify a raw cookie value; null when malformed/tampered/expired. */
  async verifiedPayload(raw: string): Promise<SessionEnvelope | null> {
    const verdict = await verifySessionEnvelope(this.ring, raw, Date.now());
    return verdict.ok ? verdict.payload : null;
  }

  async readSessionId(req: Request): Promise<string | null> {
    const raw = this.rawCookieValue(req);
    if (!raw) return null;
    const payload = await this.verifiedPayload(raw);
    return payload ? payload.sid : null;
  }

  private rawCookieValue(req: Request): string | null {
    const cookies = req.headers.get("cookie") ?? "";
    for (const part of cookies.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
}

/**
 * No-op verification adapter — the reference upstream performs its own
 * admission (the ledger is the truth). Production adapters wrap Turnstile
 * over the CANONICAL VerificationInput fields (P1-4): token, action,
 * hostname, remoteIp, userAgent, requestUrl.
 */
export class ReferenceVerificationAdapter implements HostVerificationAdapter {
  async verify(): Promise<boolean> {
    return true;
  }
}

/**
 * P1-AUDIT-2 (P1-2): scoring-policy parity. The host decision must honor
 * the profile's OWN policy (strict-v1 / permissive-v1 are real treatments)
 * exactly as the Worker submit route does. The prior host middleware called
 * decide(evidence) with the DEFAULT policy for every profile, so the host
 * plane could not reproduce Worker decisions under non-default policies.
 * An unknown persisted policy FAILS CLOSED (null → caller denies) rather
 * than silently scoring under a different rule.
 */
export function resolveScoringPolicy(
  profile: DefenseProfile
): ScoringPolicy | null {
  try {
    return getPolicyOrThrow(profile.scoringPolicy);
  } catch {
    return null;
  }
}

/**
 * Reference telemetry adapter — a STATEFUL in-memory observation store over
 * the CANONICAL validation (P0-4/P0-5). Every batch goes through
 * validateTelemetryBatch() — the exact function the Worker's /api/events
 * and /api/submit run — so the host plane accepts the same events, rejects
 * the same events, and preserves the same seq/dt/kind/target/meta as the
 * Worker plane. No synthetic timestamps, no weaker normalizer.
 *
 * In-memory per-isolate state, like ReferenceCanaryStore; hosts with real
 * persistence implement HostTelemetryAdapter over their own store using the
 * same canonical validation.
 */
export class ReferenceTelemetryAdapter implements HostTelemetryAdapter {
  /** sessionId → events in arrival (seq) order. */
  private readonly streams = new Map<string, ValidatedEvent[]>();

  async accept(sessionId: string, batch: unknown): Promise<number | null> {
    const check = validateTelemetryBatch(batch);
    if (!check.ok) return null;
    const stream = this.streams.get(sessionId) ?? [];
    for (const e of check.events) stream.push(e);
    this.streams.set(sessionId, stream);
    return check.events.length;
  }

  async collect(sessionId: string): Promise<ValidatedEvent[]> {
    return this.streams.get(sessionId) ?? [];
  }

  /** Test/diagnostics accessor: the raw persisted stream for a session. */
  streamsFor(sessionId: string): ValidatedEvent[] {
    return this.streams.get(sessionId) ?? [];
  }
}

/** Reference enforcement adapter — forwards to the upstream over HTTP. */
export class ReferenceEnforcementAdapter implements HostEnforcementAdapter {
  async allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string
  ): Promise<boolean> {
    try {
      const resp = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify({ form }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  deny(_sessionId: string, _reason: string): void {
    // Reference upstream keeps no denial log; production persists one.
  }
}

/**
 * P1-AUDIT-2 Phase D (audit item 6) — reference canary-hit store.
 *
 * In-memory set of (sessionId) verified hits, mirroring the Worker's
 * canary_hits semantics: idempotent replays succeed; only `failStore` (a
 * test/diagnostics hook) simulates a real storage failure. Hosts with real
 * persistence implement HostCanaryStore over their own store.
 */
export class ReferenceCanaryStore implements HostCanaryStore {
  private readonly hits = new Set<string>();
  /** When true, record() fails (simulates a real storage outage). */
  failStore = false;

  async record(sessionId: string, _token: string, _expected: string): Promise<boolean> {
    if (this.failStore) return false;
    this.hits.add(sessionId);
    return true;
  }

  async readVerified(sessionId: string): Promise<boolean> {
    return this.hits.has(sessionId);
  }
}
