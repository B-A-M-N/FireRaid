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
  FinalSubmissionRecord,
  FinalizeDecisionResult,
  AssessmentSnapshot,
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
import type { HostTelemetryIngest, HostSessionContext, HostSessionIssuance, VerificationInput } from "./interface.js";
import { resolveKeySecret } from "./profile/resolve-session-profile.js";
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

  /**
   * FR-RR-27: the reference adapter always signs the issued profile hash
   * (fr2) and always returns it from resolveSession — the drift check has
   * full coverage on this carrier.
   */
  readonly profileIntegrity = "issued-hash" as const;

  /**
   * Create a session adapter.
   * - (secret, opts?) — legacy single-key constructor (synthesizes a ring).
   * - (ring, opts?) — new constructor accepting a full ProfileKeyRing.
   *
   * FR-RR-17: the adapter no longer owns a profile version. The DEPRECATED
   * `opts.version` is accepted (and silently ignored with a warning in
   * development) so old wirings keep constructing — but the version that
   * lands in a session envelope now comes ONLY from the middleware's
   * issuance call, the single configuration source.
   */
  constructor(secretOrRing: string | ProfileKeyRing, opts?: { version?: number; keyId?: string }) {
    if (typeof secretOrRing === "string") {
      this.ring = { current: { id: opts?.keyId ?? "default", secret: secretOrRing } };
    } else {
      this.ring = secretOrRing;
    }
  }

  async createSession(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async sessionCookie(sessionId: string, issuance?: HostSessionIssuance): Promise<string> {
    // FR-RR-17: the adapter signs what FireRaid tells it was issued — the
    // profile version and key id come from the issuance call, never from
    // adapter-local configuration. The profile hash (required on the fr2
    // path) selects the fr2 format and carries the signed drift anchor.
    // FR-RR-27: with profileIntegrity === "issued-hash", a hashless
    // issuance is a CALLER BUG — this adapter's guarantee is that every
    // cookie it mints carries the signed hash, so it throws rather than
    // silently minting an unverifiable fr1 carrier.
    if (issuance?.profileHash === undefined) {
      throw new Error(
        "ReferenceSessionAdapter: profileIntegrity 'issued-hash' requires issuance.profileHash — " +
          "the middleware must pass the complete HostSessionIssuance (hashless carriers are an " +
          "evaluation-plane posture, not this adapter's contract)"
      );
    }
    const pv = issuance.profileVersion;
    const kid = issuance?.profileKeyId ?? this.ring.current.id;
    const signed = await signSessionEnvelope(
      // Sign under the ISSUING key (the issuance names it).
      { ...this.ring, current: { id: kid, secret: resolveKeySecret(this.ring, kid) } },
      sessionId,
      Date.now(),
      pv,
      { profileHash: issuance.profileHash }
    );
    return `${SESSION_COOKIE}=${signed}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
  }

  /** Verify a raw cookie value; null when malformed/tampered/expired. */
  async verifiedPayload(raw: string): Promise<SessionEnvelope | null> {
    const verdict = await verifySessionEnvelope(this.ring, raw, Date.now());
    return verdict.ok ? verdict.payload : null;
  }

  /**
   * P1-1: the VERIFIED context — the envelope's own pv/kid/iat, not the
   * deployment defaults. Middleware derives the session's profile with
   * THIS pv so a mid-session key/version bump cannot silently re-derive a
   * different treatment for an in-flight session.
   *
   * FR-RR-12: the fr2 envelope's SIGNED profile hash (`ph`) is surfaced as
   * `profileHash` instead of being dropped after signature verification.
   * The signature proves the hash is the one issuance recorded; the
   * middleware's derive-and-verify step uses it to prove the treatment it
   * is about to evaluate against is the treatment that was issued.
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
      ...(payload.ph !== undefined ? { profileHash: payload.ph } : {}),
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

/**
 * FR-RR-13 — HTTP statuses the reference adapter treats as TRANSIENT
 * upstream failures (worth reconciliation), as opposed to business
 * rejections (permanent — the upstream's own answer about this
 * application). A received-and-answered retryable status is still
 * AMBIGUOUS about whether the upstream committed before failing (an
 * origin can INSERT+COMMIT and then throw before its handler returns —
 * or a reverse proxy can fail after the upstream did the work), so the
 * classification carries uncertain: true and the claim slot is held.
 */
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
 *
 * FR-RR-13 — AMBIGUITY IS CONSERVATIVE BY DEFAULT. The Fetch API gives no
 * protocol-level proof of WHEN a thrown failure happened relative to the
 * request hitting the origin: a TypeError can surface after the origin
 * received the POST, committed the account, and dropped the socket before
 * replying. This adapter therefore classifies EVERY fetch() failure and
 * every received-but-ambiguous answer as an UNCERTAIN transport failure —
 * the middleware holds the session's forward slot on those (fail closed,
 * operator reconciliation) instead of releasing it for an automatic retry
 * that could create a second irreversible forward. Only a response with
 * positive semantics settles the outcome:
 *   - a documented CREATED status (createdStatuses, default [201] —
 *     plain `resp.ok` would treat a 202 Accepted as a durable create)
 *     → created;
 *   - a definite business rejection (the other 4xx: received, considered,
 *     refused) → business-rejected;
 *   - anything else → transport-failure, uncertain.
 * A host whose upstream has richer application semantics wraps or replaces
 * this adapter (the HostEnforcementAdapter seam) rather than loosening
 * these defaults.
 */
export class ReferenceEnforcementAdapter implements HostEnforcementAdapter {
  /** Forward timeout (ms) — a hung upstream is a transport failure, not a
   * successful no-op. AbortSignal so the socket is actually released. */
  forwardTimeoutMs = 10_000;
  /**
   * FR-RR-13: the response statuses this upstream DOCUMENTS as "the
   * requested account is durably created". Default [201] — 201 Created is
   * the one status whose HTTP semantics assert a resource was created.
   * Any other 2xx (200/202/204, …) is deliberately NOT a create: it may
   * be queued, proxied, or merely acknowledged. A host whose upstream
   * answers a different documented status passes that here explicitly.
   */
  createdStatuses: readonly number[] = [201];

  async allow(
    upstreamUrl: string,
    form: Record<string, string>,
    cookies: string,
    signal?: AbortSignal,
    opts?: { idempotencyKey?: string }
  ): Promise<EnforcementResult> {
    // FR-P0-02: a request that was actually SENT carries the idempotency key
    // so the upstream can deduplicate its side of the irreversible act. A
    // failure AFTER send is uncertain (the upstream may have committed); a
    // definite pre-send failure may release the slot.
    let resp: Response;
    try {
      // FR-P1-11: combine the middleware's request deadline with the adapter's
      // own forward timeout so an aborted request cancels the socket early.
      // AbortSignal.any is universal on the Node 22.5+ floor; the guard
      // remains a defensive fallback for embedded runtimes that lack it.
      const requestSignal = signal ?? new AbortController().signal;
      const combined = typeof AbortSignal.any === "function"
        ? AbortSignal.any([requestSignal, AbortSignal.timeout(this.forwardTimeoutMs)])
        : AbortSignal.timeout(this.forwardTimeoutMs);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        cookie: cookies,
      };
      if (opts?.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
      resp = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ form }),
        signal: combined,
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
      const reason =
        e instanceof Error && e.name === "TimeoutError"
          ? "timeout"
          : /redirect/i.test(causeMsg)
            ? "upstream_redirect"
            : "network_error";
      // FR-RR-13: EVERY thrown fetch failure is uncertain. A timeout after
      // dispatch, a refused redirect (received, answered non-locally), AND
      // a generic network error are all incapable of proving the request
      // did not cross the irreversible boundary — an origin can receive
      // and commit before a mid-response socket reset surfaces here as a
      // bare TypeError. Nothing in the Fetch API offers positive
      // protocol-level proof of a pre-send failure, so nothing in this
      // catch releases the claim slot.
      return { kind: "transport-failure", reason, uncertain: true };
    }
    if (this.createdStatuses.includes(resp.status)) {
      // The documented CREATED response — positive evidence the account
      // is durably created.
      return { kind: "created" };
    }
    if (RETRYABLE_STATUS.has(resp.status)) {
      // FR-RR-13: a received-and-answered 408/425/429/5xx is NOT proof the
      // upstream did not commit (INSERT + COMMIT + a later handler throw,
      // or a proxy failing after the origin did the work, both answer 5xx
      // over a completed upstream write). Ambiguous → uncertain, slot held.
      return {
        kind: "transport-failure",
        reason: `upstream_${resp.status}`,
        uncertain: true,
      };
    }
    if (resp.status >= 200 && resp.status < 300) {
      // FR-RR-13: a 2xx that is NOT the documented CREATED status (202
      // Accepted, 200 with a non-create contract, 204, …) does not assert
      // a durable create. It also is not a refusal. Ambiguous → uncertain.
      return {
        kind: "transport-failure",
        reason: `undocumented_success_${resp.status}`,
        uncertain: true,
      };
    }
    if (resp.status >= 400 && resp.status < 500) {
      // FR-RR-28: the branch is now EXHAUSTIVE — only a client-error status
      // is the upstream's OWN answer about this application (received,
      // considered, refused): a terminal business outcome. The retryable
      // members (408/425/429) were already diverted above.
      let body: string | undefined;
      try {
        body = (await resp.text()).slice(0, 512);
      } catch {
        // body unreadable — status alone still classifies
      }
      return { kind: "business-rejected", status: resp.status, body };
    }
    // FR-RR-28: everything else — every unclassified 5xx (501 Not
    // Implemented, 505 Version Not Supported, 507 Insufficient Storage,
    // 511 Network Authentication Required, …) and any 1xx/3xx that slipped
    // past redirect:"error" — is a SERVER-side or unclassifiable condition.
    // It is NOT the upstream's answer about the application, and it may
    // have committed before failing. Conservative: UNCERTAIN transport
    // failure, slot held.
    return {
      kind: "transport-failure",
      reason: `upstream_${resp.status}`,
      uncertain: true,
    };
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
  /**
   * FR-RR-40: the per-session submission state machine.
   *
   *   NONE ─claimForward──────────→ FORWARD_CLAIMED
   *                                   ├─ complete(terminal)  → TERMINAL
   *                                   └─ complete(uncertain) → FORWARD_UNCERTAIN
   *   NONE ─finalizeDecision──────→ TERMINAL (decision-denied)
   *
   * A DEFINITE transport-failure complete() releases a FORWARD_CLAIMED
   * slot back to NONE (the upstream captured nothing — a genuine retry may
   * re-attempt). FORWARD_UNCERTAIN has NO automatic exit.
   */
  private readonly claims = new Map<
    string,
    {
      state: "forward-claimed" | "forward-uncertain" | "terminal";
      claimId: string;
      idempotencyKey: string;
      /** TERMINAL only. */
      outcome?: FinalSubmissionOutcome;
      /** TERMINAL only — FR-RR-14/26: the immutable assessment snapshot. */
      assessment?: AssessmentSnapshot;
      /**
       * FR-RR-42: the enforcement.deny PROJECTION state for a terminal
       * decision-denied record — "pending" until the deny side effect has
       * landed durably, so a retry can repair it before acknowledging.
       */
      denyProjection?: "pending" | "complete";
    }
  >();

  async claim(sessionId: string, idempotencyKey: string): Promise<HostSubmissionClaimResult> {
    const existing = this.claims.get(sessionId);
    if (existing) {
      switch (existing.state) {
        case "forward-claimed":
          // Open claim held by another in-flight request → conflict.
          return { kind: "conflict" };
        case "forward-uncertain":
          // FR-RR-41: the upstream outcome is UNKNOWN — an automatic retry
          // must NEVER re-forward. Held until operator reconciliation.
          return { kind: "conflict" };
        case "terminal": {
          const o = existing.outcome!;
          return { kind: "replay", record: this.finalRecord(o, existing.assessment) };
        }
      }
    }
    return this.takeOver(sessionId, idempotencyKey);
  }

  /** FR-RR-26: a stored record is ALWAYS v2 (assessment-bearing). */
  private finalRecord(
    outcome: FinalSubmissionOutcome,
    assessment?: AssessmentSnapshot
  ): FinalSubmissionRecord {
    if (!assessment) {
      throw new Error(
        "ReferenceSubmissionStore: internal invariant violated — terminal outcome without its assessment snapshot"
      );
    }
    return { version: 2, outcome, assessment };
  }

  /** Create a fresh open claim for a session with no live claim. */
  private takeOver(sessionId: string, idempotencyKey: string): HostSubmissionClaimResult {
    const claimId = `${sessionId}:${crypto.randomUUID()}`;
    this.claims.set(sessionId, { state: "forward-claimed", claimId, idempotencyKey });
    return { kind: "claimed", claimId, idempotencyKey: submissionIdempotencyKey(sessionId) };
  }

  /**
   * FR-RR-21/40 — atomically finalize a DECISION denial as the session's
   * TERMINAL outcome. The transition is legal ONLY from NONE: an existing
   * FORWARD_CLAIMED or FORWARD_UNCERTAIN state yields conflict — the
   * decision never overwrites a forward that may already have crossed the
   * irreversible boundary, and never fabricates "blocked" for an UNKNOWN
   * upstream state. (The in-memory Map is single-threaded-synchronous, so
   * the conditional set below IS the atomic transition; the durable SQL
   * implementation must express the same shape as a conditional UPDATE.)
   */
  async finalizeDecision(
    sessionId: string,
    record: FinalSubmissionRecord
  ): Promise<FinalizeDecisionResult> {
    const existing = this.claims.get(sessionId);
    if (existing) {
      if (existing.state === "forward-claimed") {
        return { kind: "conflict", state: "forward-claimed" };
      }
      if (existing.state === "forward-uncertain") {
        // FR-RR-41: absorbing — only operator reconciliation may resolve.
        return { kind: "conflict", state: "forward-uncertain" };
      }
      // TERMINAL → replay the EXISTING record verbatim (first writer wins;
      // a concurrent finalizer must not overwrite the original denial).
      return { kind: "replay", record: this.finalRecord(existing.outcome!, existing.assessment) };
    }
    this.claims.set(sessionId, {
      state: "terminal",
      claimId: `decision:${sessionId}`,
      idempotencyKey: submissionIdempotencyKey(sessionId),
      outcome: record.outcome,
      assessment: record.assessment,
      // FR-RR-42: the deny side effect has NOT run yet — the projection is
      // born pending; the coordinator marks it complete after deny lands.
      denyProjection: "pending",
    });
    return { kind: "stored", record };
  }

  /**
   * FR-RR-42 — mark the enforcement.deny projection durably complete for a
   * terminal decision-denied record. Only a "pending" decision-denied
   * record transitions; anything else is a no-op throw (call-shape bug).
   */
  async markDenyProjectionComplete(sessionId: string): Promise<void> {
    const existing = this.claims.get(sessionId);
    if (
      !existing ||
      existing.state !== "terminal" ||
      existing.outcome?.kind !== "decision-denied" ||
      existing.denyProjection !== "pending"
    ) {
      throw new Error(
        `ReferenceSubmissionStore.markDenyProjectionComplete: no pending deny projection for ${sessionId}`
      );
    }
    existing.denyProjection = "complete";
  }

  /** FR-RR-42: the pending-projection state, for retry repair. */
  async denyProjectionState(
    sessionId: string
  ): Promise<"pending" | "complete" | undefined> {
    return this.claims.get(sessionId)?.denyProjection;
  }

  /**
   * FR-P0-02 (rereview P0-E): read the finalized outcome WITHOUT claiming.
   * A FORWARD_UNCERTAIN state has NO final record — the upstream outcome is
   * genuinely unknown; the caller proceeds, hits claim() → conflict, and
   * fails closed. FR-RR-14: the COMPLETE record (outcome + assessment) is
   * returned so the replay reproduces the original assessment.
   */
  async lookupFinal(sessionId: string): Promise<FinalSubmissionRecord | null> {
    const existing = this.claims.get(sessionId);
    if (!existing || existing.state !== "terminal" || !existing.outcome) return null;
    return this.finalRecord(existing.outcome, existing.assessment);
  }

  async complete(
    claimId: string,
    outcome: FinalSubmissionOutcome | { kind: "transport-failure"; reason: string; uncertain?: boolean },
    signal?: AbortSignal,
    meta?: { assessment?: AssessmentSnapshot }
  ): Promise<void> {
    void signal; // accepted for contract parity; the in-memory store is synchronous
    const assessment = meta?.assessment;
    for (const [sessionId, claim] of this.claims) {
      if (claim.claimId !== claimId) continue;
      // FR-P0-02: a DEFINITE transport failure releases the slot entirely —
      // back to NONE, so a genuine client retry can re-attempt the forward.
      if (outcome.kind === "transport-failure" && outcome.uncertain === true) {
        // FR-RR-41: FORWARD_UNCERTAIN is absorbing — no outcome recorded,
        // no exit by retry, deny, or finalizeDecision.
        claim.state = "forward-uncertain";
        return;
      }
      if (outcome.kind === "transport-failure") {
        claim.state = "forward-claimed";
        this.claims.delete(sessionId); // → NONE (slot released)
        return;
      }
      // FR-RR-26: a replayable terminal outcome REQUIRES its assessment —
      // writing one without the other would manufacture exactly the
      // degraded-replay state this rereview removed.
      if (!assessment) {
        throw new Error(
          "ReferenceSubmissionStore.complete: terminal outcome without its assessment snapshot — the v2 record contract requires both"
        );
      }
      claim.state = "terminal";
      claim.outcome = outcome;
      claim.assessment = assessment;
      return;
    }
    // Unknown claimId: the claim record was lost (volatile-store restart).
    // Fail loudly — the middleware treats a throw as fail-closed.
    throw new Error(`ReferenceSubmissionStore: unknown claimId ${claimId}`);
  }

  /** Test/diagnostics accessor. */
  stateFor(sessionId: string): { state: string; outcome?: unknown } | undefined {
    const c = this.claims.get(sessionId);
    return c ? { state: c.state, outcome: c.outcome } : undefined;
  }
}
