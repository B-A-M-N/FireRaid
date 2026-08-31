/**
 * Reference host adapters for the P1-24 middleware proof (Node/Express-style
 * ordinary upstream). Each adapter is fail-closed: throwing means "deny".
 */
import type {
  HostSessionAdapter,
  HostVerificationAdapter,
  HostTelemetryAdapter,
  HostEnforcementAdapter,
} from "./interface.js";

const SESSION_COOKIE = "__Host-fr_sid";
const SESSION_TTL_S = 30 * 60;

/** Reference session adapter — opaque id + cookie, host owns storage. */
export class ReferenceSessionAdapter implements HostSessionAdapter {
  async createSession(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  sessionCookie(sessionId: string): string {
    return `${SESSION_COOKIE}=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
  }

  readSessionId(req: Request): string | null {
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
