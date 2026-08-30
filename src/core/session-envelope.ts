/**
 * FR-P1-19: stateless signed production session envelope (R7-024).
 *
 * Production `GET /signup` performs NO D1 write. Instead it issues a signed,
 * versioned envelope riding the existing `__Host-fr_sid` cookie:
 *
 *     fr1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)>
 *
 * payload = { v: 1, sid, iat, pv, kid }
 *
 * The FIRST stateful action (telemetry batch, canary hit, audited
 * verification failure, or submit) verifies the envelope and atomically
 * materializes the session row via INSERT OR IGNORE. Because deriveProfile
 * is deterministic from (secret, version, sessionId, mode), concurrent
 * first-writers compute IDENTICAL profile_id / profile_hash columns — the
 * race is order-independent by construction.
 *
 * What the envelope deliberately does NOT carry: the profile itself (too
 * big, and derivation is deterministic anyway), lab binding (lab sessions
 * remain stateful — they need the atomic session+claim batch), and anything
 * beyond what a signature already covers.
 *
 * Rotation: the envelope's `kid` selects the signing secret from the SAME
 * profile key ring that profile derivation uses (resolveProfileKey), so
 * envelope verification and profile reconstruction always agree on which
 * key issued a session. Verification accepts current + previous keys.
 * Tampered, expired, unknown-kid, or future-dated envelopes fail closed.
 */
import { SESSION_TTL_MS } from "../types/profile.js";
import { type ProfileKeyRing } from "./session.js";

const ENVELOPE_PREFIX = "fr1";
/** Envelope validity = session TTL (30 min). iat newer than now+slack → reject. */
const CLOCK_SKEW_SLACK_MS = 30_000;

export interface SessionEnvelope {
  /** Envelope format version. */
  v: 1;
  /** Opaque 128-bit session id (same entropy as the stateful flow). */
  sid: string;
  /** Issued-at (ms since epoch). */
  iat: number;
  /** Profile version at issuance. */
  pv: number;
  /** Profile key id that signed this envelope. */
  kid: string;
}

// ─── Encoding helpers ─────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null; // reject padding, mixed alphabets
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time string equality over the longer of the two lengths. */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ─── Issue ────────────────────────────────────────────────────────────────

/**
 * Sign a new production session envelope.
 * @param ring  the profile key ring (envelope uses the CURRENT key)
 * @param sid   the freshly generated session id
 * @param iat   issuance time (ms)
 * @param pv    profile version at issuance
 */
export async function signSessionEnvelope(
  ring: ProfileKeyRing,
  sid: string,
  iat: number,
  pv: number
): Promise<string> {
  const payload: SessionEnvelope = { v: 1, sid, iat, pv, kid: ring.current.id };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(ring.current.secret, `${ENVELOPE_PREFIX}.${body}`);
  return `${ENVELOPE_PREFIX}.${body}.${sig}`;
}

// ─── Verify ───────────────────────────────────────────────────────────────

export type EnvelopeVerdict =
  | { ok: true; payload: SessionEnvelope; secret: string }
  | {
      ok: false;
      code:
        | "MALFORMED"
        | "UNKNOWN_VERSION"
        | "UNKNOWN_KEY"
        | "BAD_SIGNATURE"
        | "EXPIRED"
        | "FROM_FUTURE"
        | "BAD_PAYLOAD";
    };

/**
 * Verify an envelope string against the key ring.
 * Accepts signatures from current AND previous keys (rotation window).
 * Rejects: wrong shape, wrong version, unknown kid, bad signature,
 * expired (older than SESSION_TTL_MS), issued in the future beyond slack.
 */
export async function verifySessionEnvelope(
  ring: ProfileKeyRing,
  envelope: string,
  nowMs: number
): Promise<EnvelopeVerdict> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) {
    return { ok: false, code: "MALFORMED" };
  }
  const [, bodyB64, sigB64] = parts;

  const bodyBytes = b64urlDecode(bodyB64);
  if (!bodyBytes) return { ok: false, code: "MALFORMED" };
  const sigBytes = b64urlDecode(sigB64);
  if (!sigBytes || sigBytes.length !== 32) return { ok: false, code: "MALFORMED" };

  let payload: SessionEnvelope;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as Partial<SessionEnvelope>;
    if (
      parsed.v !== 1 ||
      typeof parsed.sid !== "string" ||
      parsed.sid.length === 0 ||
      typeof parsed.iat !== "number" ||
      !Number.isFinite(parsed.iat) ||
      typeof parsed.pv !== "number" ||
      !Number.isInteger(parsed.pv) ||
      parsed.pv < 1 ||
      typeof parsed.kid !== "string" ||
      parsed.kid.length === 0
    ) {
      return { ok: false, code: "BAD_PAYLOAD" };
    }
    payload = { v: 1, sid: parsed.sid, iat: parsed.iat, pv: parsed.pv, kid: parsed.kid };
  } catch {
    return { ok: false, code: "BAD_PAYLOAD" };
  }

  // kid → secret (current, then previous). Unknown kid fails closed.
  let secret: string | undefined;
  if (payload.kid === ring.current.id) {
    secret = ring.current.secret;
  } else if (ring.previous && payload.kid in ring.previous) {
    secret = ring.previous[payload.kid];
  } else {
    return { ok: false, code: "UNKNOWN_KEY" };
  }

  // Signature — computed over the ORIGINAL body bytes, so any re-encoding
  // or payload edit invalidates it. Constant-time compare.
  const expected = await sign(secret, `${ENVELOPE_PREFIX}.${bodyB64}`);
  if (!timingSafeEqual(expected, sigB64)) {
    return { ok: false, code: "BAD_SIGNATURE" };
  }

  if (nowMs - payload.iat > SESSION_TTL_MS) {
    return { ok: false, code: "EXPIRED" };
  }
  if (payload.iat > nowMs + CLOCK_SKEW_SLACK_MS) {
    return { ok: false, code: "FROM_FUTURE" };
  }

  return { ok: true, payload, secret };
}

/**
 * Production cookie value is the envelope; lab stays a bare sid so the two
 * modes are distinguishable by shape alone (a lab server should never accept
 * an envelope and a production server should never accept a bare sid once
 * the legacy fallback window closes).
 */
export function isEnvelopeCookie(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}.`);
}
