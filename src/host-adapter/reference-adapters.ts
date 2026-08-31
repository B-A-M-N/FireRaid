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
 * admission (the ledger is the truth). Production adapters wrap Turnstile.
 * Receives the already-consumed parsed body; returns true (no verification
 * required).
 */
export class ReferenceVerificationAdapter implements HostVerificationAdapter {
  async verify(): Promise<boolean> {
    return true;
  }
}

/** Reference telemetry adapter — pass-through normalization. */
export class ReferenceTelemetryAdapter implements HostTelemetryAdapter {
  accept(batch: unknown): { seq: number; kind: string; target?: string }[] {
    if (!Array.isArray(batch)) return [];
    const out: { seq: number; kind: string; target?: string }[] = [];
    for (const e of batch) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      if (typeof o.seq !== "number" || typeof o.kind !== "string") continue;
      out.push({ seq: o.seq, kind: o.kind, target: typeof o.target === "string" ? o.target : undefined });
    }
    return out;
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
