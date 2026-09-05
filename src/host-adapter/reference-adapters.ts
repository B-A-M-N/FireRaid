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
  HostSubmissionStore,
  HostSubmissionClaimResult,
  FinalSubmissionOutcome,
  EnforcementResult,
} from "./interface.js";
import { submissionIdempotencyKey } from "./interface.js";
import {
  signSessionEnvelope,
  verifySessionEnvelope,
  type SessionEnvelope,
} from "../core/session-envelope.js";
import type { ProfileKeyRing } from "../core/session.js";
import { validateTelemetryBatch, type ValidatedEvent } from "../security/request-validation.js";
import type { HostTelemetryIngest, HostSessionContext, VerificationInput } from "./interface.js";
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

  /**
   * Create a session adapter.
   * - (secret, opts?) — legacy single-key constructor (synthesizes a ring).
   * - (ring, opts?) — new constructor accepting a full ProfileKeyRing.
   */
  constructor(secretOrRing: string | ProfileKeyRing, opts?: { version?: number; keyId?: string }) {
    if (typeof secretOrRing === "string") {
      this.ring = { current: { id: opts?.keyId ?? "default", secret: secretOrRing } };
      this.version = opts?.version ?? 1;
    } else {
      this.ring = secretOrRing;
      this.version = opts?.version ?? 1;
    }
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

  /**
   * P1-1: the VERIFIED context — the envelope's own pv/kid/iat, not the
   * deployment defaults. Middleware derives the session's profile with
   * THIS pv so a mid-session key/version bump cannot silently re-derive a
   * different treatment for an in-flight session.
   */
  async resolveSession(req: Request): Promise<HostSessionContext | null> {
    const raw = this.rawCookieValue(req);
    if (!raw) return null;
    const payload = await this.verifiedPayload(raw);
    if (!payload) return null;
    return {
      id: payload.sid,
      profileVersion: payload.pv,
      keyId: payload.kid,
      issuedAt: payload.iat,
    };
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
 *
 * AUDIT (P1 verification capability): the no-op DECLARES its mode. A
 * production deployment cannot ship it unknowingly — createFireRaidMiddleware
 * refuses verificationMode "disabled-test"; evaluation wiring accepts it
 * explicitly.
 */
export class ReferenceVerificationAdapter implements HostVerificationAdapter {
  readonly verificationMode = "disabled-test" as const;
  async verify(): Promise<boolean> {
    return true;
  }
}

/**
 * AUDIT (P1): a host that ALREADY verified the human elsewhere (the FI
 * integration: FI's own verification result consumed, no duplicate widget).
 * Production-legal by declaration — the factory accepts this mode.
 *
 * P0-3: the callback is REQUIRED (no default). A production deployment
 * must supply an explicit verification implementation that receives the
 * canonical profile + input — a no-default constructor makes it impossible
 * to accidentally ship a verifier that accepts everything.
 */
export class HostOwnedVerificationAdapter implements HostVerificationAdapter {
  readonly verificationMode = "host-owned" as const;
  constructor(private readonly verifier: (profile: DefenseProfile, input: VerificationInput) => Promise<boolean>) {}
  async verify(profile: DefenseProfile, input: VerificationInput): Promise<boolean> {
    return this.verifier(profile, input);
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
 * P1-AUDIT-2 (P0-2): the store implements the WORKER's watermark-gated
 * ingestion semantics over the canonical events:
 *   - per-session watermark = the highest stored seq;
 *   - an overlapping batch's accepted prefix is trimmed, only the
 *     never-stored suffix persists (a lost-ACK retry no longer
 *     double-counts pointer/key/focus/direct-fill evidence);
 *   - an exact replay is idempotent success reporting the watermark;
 *   - the ACK carries the authoritative acceptedThrough so a client can
 *     trim its outbox exactly like the Worker's /api/events contract.
 * Hosts with real persistence implement HostTelemetryAdapter over their own
 * store using the same watermark contract.
 */
export class ReferenceTelemetryAdapter implements HostTelemetryAdapter {
  /**
   * P1-8 / FR-P1-03: NON-PRODUCTION durability. This store is an in-process
   * Map — evidence evaporates on restart, and evidence that evaporates
   * cannot anchor a review decision. `durability` names that fact on the
   * type (production adapters declare "durable"; the production factory
   * rejects a volatile store). Mutable so a test/demo double can declare a
   * durable backing it represents; the reference default is always volatile.
   */
  durability: "durable" | "volatile" = "volatile";
  /** sessionId → events in seq order (deduplicated by the watermark gate). */
  private readonly streams = new Map<string, ValidatedEvent[]>();

  async accept(sessionId: string, batch: unknown): Promise<HostTelemetryIngest> {
    if (!this.createdAt.has(sessionId)) this.createdAt.set(sessionId, Date.now());
    const check = validateTelemetryBatch(batch);
    if (!check.ok) {
      return { kind: "invalid", code: check.code };
    }
    if (check.events.length === 0) {
      // Empty batch: idempotent, reports the current watermark (Worker
      // ingestTelemetryBatch's empty-batch branch).
      const stream = this.streams.get(sessionId) ?? [];
      return {
        kind: "accepted",
        received: 0,
        acceptedThrough: stream.length > 0 ? stream[stream.length - 1].seq : -1,
        duplicate: true,
      };
    }
    const stream = this.streams.get(sessionId) ?? [];
    // Watermark = the last stored seq (the stream is seq-ordered by
    // construction — validateTelemetryBatch enforces strictly increasing
    // seq within a batch, and the suffix filter keeps the store sorted).
    const watermark = stream.length > 0 ? stream[stream.length - 1].seq : -1;
    // Strip the already-accepted prefix; persist only the never-stored
    // suffix (Worker ingestTelemetryBatch's overlap semantics — a batch
    // may carry both stored events AND new ones).
    const suffix = check.events.filter((e) => e.seq > watermark);
    if (suffix.length === 0) {
      // Exact replay: idempotent success (never a double append).
      return { kind: "accepted", received: 0, acceptedThrough: watermark, duplicate: true };
    }
    for (const e of suffix) stream.push(e);
    this.streams.set(sessionId, stream);
    const acceptedThrough = suffix[suffix.length - 1].seq;
    return {
      kind: "accepted",
      received: suffix.length,
      acceptedThrough,
      duplicate: false,
    };
  }

  async collect(sessionId: string): Promise<ValidatedEvent[]> {
    return this.streams.get(sessionId) ?? [];
  }

  /** Test/diagnostics accessor: the raw persisted stream for a session. */
  streamsFor(sessionId: string): ValidatedEvent[] {
    return this.streams.get(sessionId) ?? [];
  }

  /**
   * Lifecycle hygiene: drop one session's stream. Unique per-trial session
   * ids mean cross-trial contamination cannot happen, but a long-lived
   * host process should not accumulate every session forever.
   */
  clearSession(sessionId: string): void {
    this.streams.delete(sessionId);
  }

  // ── HostSessionEvidenceLifecycle (audit P1: unbounded store lifecycle) ──
  readonly ttlMs = 30 * 60 * 1000;
  /** sessionId → wall-clock created-at, for the TTL sweep. */
  private readonly createdAt = new Map<string, number>();

  /**
   * finalize(sessionId): the session completed (submission resolved) —
   * aggregate what scoring needed, drop the raw transient stream.
   */
  finalize(sessionId: string): void {
    this.streams.delete(sessionId);
    this.createdAt.delete(sessionId);
  }

  /**
   * sweepExpired(): drop every session stream older than ttlMs.
   * Returns the number of sessions evicted. Called opportunistically by
   * the middleware; production stores should run it on a timer instead.
   */
  sweepExpired(): number {
    const cutoff = Date.now() - this.ttlMs;
    let evicted = 0;
    for (const [sid, created] of this.createdAt) {
      if (created < cutoff) {
        this.streams.delete(sid);
        this.createdAt.delete(sid);
        evicted++;
      }
    }
    // Streams admitted before any sweep without a createdAt entry: record
    // lazily so they eventually age out too.
    for (const sid of this.streams.keys()) {
      if (!this.createdAt.has(sid)) this.createdAt.set(sid, Date.now());
    }
    return evicted;
  }
}

/**
 * Enforcement result — discriminated outcome of forwarding to the upstream.
 *
 * P0-8: the failure taxonomy the middleware's receipt policy is built on.
 * `queued-for-retry` (durably captured) is deliberately distinct from
 * `transport-failure` (nothing captured): only the former may ever reach
 * the applicant as a neutral success receipt. Re-exported from the
 * interface module — the one definition lives there.
 */
export type { EnforcementResult } from "./interface.js";

/** HTTP statuses the reference adapter treats as TRANSIENT upstream
 * failures (worth a durable retry), as opposed to business rejections
 * (permanent — the upstream's own answer about this application). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Reference enforcement adapter — forwards to the upstream over HTTP and
 * classifies the outcome per the P0-8 taxonomy.
 *
 * This reference has no durable queue of its own: a forwarding failure
 * here is honestly `transport-failure`, never `queued-for-retry`. A host
 * that wants at-least-once forwarding implements the adapter over its own
 * durable pending store and returns `queued-for-retry` after capturing.
 * (P0-8: the previous `return resp.ok` / `catch { return false }` collapsed
 * 409-duplicate, 422-invalid, upstream 5xx, timeout, and connection-refused
 * into one boolean — indistinguishable to every consumer downstream.)
 */
export class ReferenceEnforcementAdapter implements HostEnforcementAdapter {
  /** Forward timeout (ms) — a hung upstream is a transport failure, not a
   * successful no-op. AbortSignal so the socket is actually released. */
  forwardTimeoutMs = 10_000;

  async allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string
  ): Promise<EnforcementResult> {
    let resp: Response;
    try {
      resp = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify({ form }),
        signal: AbortSignal.timeout(this.forwardTimeoutMs),
        // An admission endpoint that responds with a redirect did NOT create
        // the account — following the chain would land on a 200 HTML page
        // (a login/interstitial) and classify it `created`. A redirect is an
        // unclassifiable upstream answer: treat it as a transport failure
        // rather than a false-create.
        redirect: "error",
      });
    } catch (e) {
      // Node's fetch wraps: TimeoutError surfaces named; a refused
      // redirect: "error" surfaces as TypeError("fetch failed") with the
      // real reason on `cause` ("unexpected redirect").
      const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      return {
        kind: "transport-failure",
        reason:
          e instanceof Error && e.name === "TimeoutError"
            ? "timeout"
            : /redirect/i.test(causeMsg)
              ? "upstream_redirect"
              : "network_error",
      };
    }
    if (resp.ok) return { kind: "created" };
    if (RETRYABLE_STATUS.has(resp.status)) {
      return { kind: "transport-failure", reason: `upstream_${resp.status}` };
    }
    // Any other 4xx is the upstream's OWN answer about this application:
    // received, considered, refused. That is a terminal business outcome.
    let body: string | undefined;
    try {
      body = (await resp.text()).slice(0, 512);
    } catch {
      // body unreadable — status alone still classifies
    }
    return { kind: "business-rejected", status: resp.status, body };
  }

  deny(_sessionId: string, _reason: string): void {
    // Reference upstream keeps no denial log; production persists one.
  }
}

/**
 * P1-AUDIT-2 Phase D (audit item 6) — reference canary-hit store.
 */
export class ReferenceCanaryStore implements HostCanaryStore {
  /**
   * P1-8: see ReferenceTelemetryAdapter.durability — in-process Set, not
   * durable production storage. Causal evidence (Class-A canary hits) that
   * evaporates on restart cannot anchor an admission decision.
   */
  durability: "durable" | "volatile" = "volatile";
  private readonly hits = new Set<string>();
  /** When true, record() fails (simulates a real storage outage). */
  failStore = false;
  /** AUDIT (P1 lifecycle): TTL contract — verified hits expire too. */
  readonly ttlMs = 30 * 60 * 1000;
  private readonly recordedAt = new Map<string, number>();

  async record(sessionId: string, _token: string, _expected: string): Promise<boolean> {
    if (this.failStore) return false;
    this.hits.add(sessionId);
    this.recordedAt.set(sessionId, Date.now());
    return true;
  }

  async readVerified(sessionId: string): Promise<boolean> {
    return this.hits.has(sessionId);
  }

  /** Drop one session's verified-hit state (submit resolved / TTL). */
  async finalize(sessionId: string): Promise<void> {
    this.hits.delete(sessionId);
    this.recordedAt.delete(sessionId);
  }

  /** Evict verified hits older than ttlMs. Returns sessions evicted. */
  sweepExpired(): number {
    const cutoff = Date.now() - this.ttlMs;
    let evicted = 0;
    for (const [sid, at] of this.recordedAt) {
      if (at < cutoff) {
        this.finalize(sid);
        evicted++;
      }
    }
    return evicted;
  }
}

/**
 * FR-P0-02 — reference one-submission-per-session store.
 *
 * Atomicity model: the claim record is keyed by sessionId and created only
 * when absent (Map.set on a fresh key after a has-check is NOT atomic in a
 * concurrent host — the REFERENCE runs on the single-threaded Node event
 * loop where the check and set complete without interleaving, and the test
 * suite's "two simultaneous submissions" case exercises exactly that). A
 * production host MUST implement the same semantics over its own durable
 * store with a real atomic primitive — a UNIQUE constraint insert or a
 * conditional UPDATE (`UPDATE claims SET holder = ? WHERE session_id = ?
 * AND state = 'open'`), never check-then-insert across an await.
 *
 * P1-8 durability declaration: this in-process Map is VOLATILE — like the
 * other reference stores it exists for local development, integration
 * tests, and as the behavioral specification for a durable implementation.
 */
export class ReferenceSubmissionStore implements HostSubmissionStore {
  durability: "durable" | "volatile" = "volatile";
  /** sessionId → claim state. A completed claim holds its outcome forever. */
  private readonly claims = new Map<
    string,
    { claimId: string; idempotencyKey: string; open: boolean; outcome?: FinalSubmissionOutcome | { kind: "transport-failure"; reason: string } }
  >();

  async claim(sessionId: string, idempotencyKey: string): Promise<HostSubmissionClaimResult> {
    const existing = this.claims.get(sessionId);
    if (existing) {
      // Open claim held by another in-flight request → conflict.
      if (existing.open) return { kind: "conflict" };
      // Finalized claim → replay the durable outcome (idempotent receipt).
      if (existing.outcome) {
        const o = existing.outcome;
        return o.kind === "transport-failure"
          ? // A recorded transport failure RELEASED the slot: take it over.
            this.takeOver(sessionId, idempotencyKey)
          : { kind: "replay", outcome: o };
      }
      return { kind: "conflict" };
    }
    return this.takeOver(sessionId, idempotencyKey);
  }

  /** Create a fresh open claim for a session with no live claim. */
  private takeOver(sessionId: string, idempotencyKey: string): HostSubmissionClaimResult {
    const claimId = `${sessionId}:${crypto.randomUUID()}`;
    this.claims.set(sessionId, { claimId, idempotencyKey, open: true });
    return { kind: "claimed", claimId, idempotencyKey: submissionIdempotencyKey(sessionId) };
  }

  async complete(
    claimId: string,
    outcome: FinalSubmissionOutcome | { kind: "transport-failure"; reason: string }
  ): Promise<void> {
    for (const [sessionId, claim] of this.claims) {
      if (claim.claimId !== claimId) continue;
      claim.open = false;
      claim.outcome = outcome;
      // A transport failure releases the slot entirely — a genuine client
      // retry must be able to re-attempt the forward.
      if (outcome.kind === "transport-failure") this.claims.delete(sessionId);
      return;
    }
    // Unknown claimId: the claim record was lost (volatile-store restart).
    // Fail loudly — the middleware treats a throw as fail-closed.
    throw new Error(`ReferenceSubmissionStore: unknown claimId ${claimId}`);
  }

  /** Test/diagnostics accessor. */
  stateFor(sessionId: string): { open: boolean; outcome?: unknown } | undefined {
    const c = this.claims.get(sessionId);
    return c ? { open: c.open, outcome: c.outcome } : undefined;
  }
}
