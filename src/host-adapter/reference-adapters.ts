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

const SESSION_COOKIE = "__Host-fr_sid";
const SESSION_TTL_S = 30 * 60;

/**
 * Reference session adapter — opaque id + SIGNED cookie, host owns storage.
 *
 * P1-AUDIT-2: the bare sid cookie was forgeable — an attacker could rewrite
 * their `__Host-fr_sid` to any target session id, and the POST path trusted
 * it, so a victim's profile (derived from the victim's sid) would be scored
 * against the attacker's submission, and a decoy hit attributed to the wrong
 * session. The cookie value is now a signed envelope `sid.marker` where
 * marker = HMAC-SHA-256(secret, "fr-sid:" + sid). readSessionId REJECTS any
 * cookie whose signature does not verify, so a tampered/forged sid is treated
 * as "no session" (admission denied, never forwarded).
 */
export class ReferenceSessionAdapter implements HostSessionAdapter {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  async createSession(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Signed cookie value: bare sid, then an HMAC tag over it. */
  private async sign(sid: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`fr-sid:${sid}`)
    );
    const tag = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${sid}.${tag}`;
  }

  async sessionCookie(sessionId: string): Promise<string> {
    const signed = await this.sign(sessionId);
    return `${SESSION_COOKIE}=${signed}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
  }

  async readSessionId(req: Request): Promise<string | null> {
    const cookies = req.headers.get("cookie") ?? "";
    let raw = "";
    for (const part of cookies.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      if (part.slice(0, i).trim() === SESSION_COOKIE) raw = part.slice(i + 1).trim();
    }
    if (!raw) return null;
    // Split and verify the HMAC tag; reject tampered/forged cookies.
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;
    const sid = raw.slice(0, dot);
    const provided = raw.slice(dot + 1);
    if (provided !== (await this.sign(sid)).slice(sid.length + 1)) return null;
    return sid;
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
