/**
 * Host-neutral admission middleware (P1-24 + P1-25).
 *
 * This is the reference adapter that sits in front of an ORDINARY upstream
 * signup app the host owns. The upstream knows NOTHING about FireRaid — it
 * just has a signup endpoint and an account ledger. FireRaid's job here is
 * to inject artifacts on GET, evaluate on POST, strip its own fields, and
 * forward to the upstream only when admission allows.
 *
 * The PRIMARY experimental truth becomes: did the origin ledger contain the
 * synthetic account? That is decided entirely by the upstream's own ledger —
 * not by any FireRaid-side claim. This is what lets the ledger experiment
 * establish whether FireRaid actually works, rather than measuring itself.
 *
 * Fail-closed: any adapter/verification error → deny (never forward).
 */
import { deriveProfilePure, hashProfile, type DefenseRecipe } from "../core/profile.js";
import { correlate, type ObservationSet } from "../core/correlation.js";
import { decide } from "../core/decision.js";
import { aggregateTelemetry, type CaptureConfig } from "../telemetry/aggregate.js";
import { validateSignupForm, type SubmitInbound } from "../security/request-validation.js";
import { resolveScoringPolicy } from "./reference-adapters.js";
import type { VerificationInput } from "./interface.js";
import { constantTimeTokenEqual } from "../core/tokens.js";
import type { DefenseProfile } from "../types/profile.js";
import type {
  HostSessionAdapter,
  HostRenderAdapter,
  HostVerificationAdapter,
  HostTelemetryAdapter,
  HostEnforcementAdapter,
  HostCanaryStore,
} from "./interface.js";

export interface MiddlewareDeps {
  secret: string;
  version: number;
  /** Upstream registration endpoint (e.g. http://localhost:5051/api/register). */
  upstreamRegisterUrl: string;
  session: HostSessionAdapter;
  render: HostRenderAdapter;
  verification: HostVerificationAdapter;
  telemetry: HostTelemetryAdapter;
  enforcement: HostEnforcementAdapter;
  /**
   * P1-AUDIT-2 Phase D (audit item 6): verified canary-hit storage. When
   * provided, GET <canaryPathPrefix><token> verifies the session's route
   * token (constant-time) and persists the hit; POST reads verified hits
   * back into observations.canaryEndpointHit — the same Class-A causal
   * chain the Worker's /c/:token → canary_hits → submit.ts path produces.
   * OMITTING the store leaves the host plane without route evidence (the
   * middleware then behaves as before: no /c/ route exists on the host).
   */
  canaryStore?: HostCanaryStore;
  /** Route prefix the host exposes canary probes under. Default "/c/". */
  canaryPathPrefix?: string;
  /** Lab mode emits visible markers; production stays inert. */
  labMode?: boolean;
  /**
   * Optional bound ablation recipe (the host's assigned condition). When set,
   * the middleware derives the EXACT profile the host intends — mirroring the
   * lab-run recipe flow. Omit for a random profile.
   */
  recipe?: DefenseRecipe;
}

export interface MiddlewareResult {
  /** "get" | "admit" | "deny" | "canary-verified" | "error". */
  kind: "get" | "admit" | "deny" | "canary-verified" | "error";
  /** The HTML to return on GET (kind === "get"). */
  html?: string;
  /** Set-Cookie header(s) to return. */
  setCookie?: string;
  /** Disposition recorded (admit/deny paths). */
  disposition?: string;
  /** Whether the upstream ledger created the account (the experiment's truth). */
  upstreamCreated?: boolean;
}

// Strip FireRaid-injected fields before forwarding to the upstream so the
// ordinary app's ledger never carries our decoy/telemetry artifacts.
function stripFireRaidFields(
  form: Record<string, string>,
  profile: DefenseProfile
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(["csrf"]);
  if (profile.decoyField) drop.add(profile.decoyField.fieldName);
  for (const [k, v] of Object.entries(form)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Handle one request through the admission middleware.
 * @param req          the inbound Request (from the host's fetch handler)
 * @param deps         wired host adapters + core config
 * @param htmlLoader   async loader for the upstream signup HTML (host-owned)
 */
export async function admit(
  req: Request,
  deps: MiddlewareDeps,
  htmlLoader: () => Promise<string>
): Promise<MiddlewareResult> {
  const labMode = deps.labMode === true;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    // P1-AUDIT-2 Phase D (audit item 6): canary probes are ROUTE-AWARE. The
    // prior middleware routed EVERY GET to signup injection — a probe of the
    // decoy route minted a FRESH session (and never verified anything), so
    // Class-A route evidence could not exist on the host plane at all. When
    // a canary store is wired, GET <prefix><token> is the host counterpart
    // of the Worker's GET /c/:token: resolve session, reconstruct the
    // profile, verify constant-time, persist FAIL-CLOSED.
    const prefix = deps.canaryPathPrefix ?? "/c/";
    const url = new URL(req.url);
    if (deps.canaryStore && url.pathname.startsWith(prefix)) {
      return handleCanaryGet(req, deps, url.pathname.slice(prefix.length));
    }

    try {
      const sessionId = await deps.session.createSession();
      const profile = await deriveProfilePure({
        secret: deps.secret,
        version: deps.version,
        sessionId,
        mode: labMode ? "lab" : "production",
      }, deps.recipe);
      const csrfToken = await makeCsrf(deps.secret, sessionId);
      const html = await htmlLoader();
      const page = deps.render.inject(html, profile, csrfToken, labMode);
      return { kind: "get", html: page, setCookie: await deps.session.sessionCookie(sessionId) };
    } catch {
      return { kind: "error" };
    }
  }

  // ── POST: evaluate, strip, forward only when admission allows ────────────
  if (req.method === "POST") {
    const sessionId = await deps.session.readSessionId(req);
    if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };

    // P1-AUDIT-2 Phase F: a host plane in front of an ORDINARY page receives
    // browser form posts — application/x-www-form-urlencoded, not the
    // Worker-shaped JSON {csrf, form, eventBatch} (the Worker path is
    // JSON-only because its client script intercepts submit; an ordinary
    // page has no such script). Both carriers parse into the SAME internal
    // shape; the urlencoded csrf hidden field folds into body.csrf.
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
    let body: SubmitInbound;
    if (contentType === "application/x-www-form-urlencoded") {
      let text: string;
      try {
        text = await req.text();
      } catch {
        return { kind: "deny", disposition: "BAD_FORM" };
      }
      const entries: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(text)) entries[k] = v;
      const { csrf, ...form } = entries;
      body = { csrf, form };
    } else {
      try {
        body = await req.json();
      } catch {
        return { kind: "deny", disposition: "BAD_JSON" };
      }
    }
    // P1-AUDIT-2 (P1-3): the SAME bounded form validation the Worker
    // submit route runs (field count / key bytes / value bytes). The prior
    // host path cast body.form unchecked — a much weaker contract on the
    // plane that claims production equivalence.
    const formCheck = validateSignupForm(body.form ?? {});
    if (!formCheck.ok) {
      deps.enforcement.deny(sessionId, "INVALID_FORM");
      return { kind: "deny", disposition: "INVALID_FORM" };
    }
    const form = formCheck.form;

    // P1-AUDIT-2: verify the KEYED CSRF token — the prior token was an unkeyed
    // SHA-256 of the PUBLIC sid (forgeable from the visible cookie) and was
    // never even checked on POST. Now the token is an HMAC over the session,
    // and POST rejects a missing/mismatched token before any evaluation.
    if (!body.csrf || !(await verifyCsrf(deps.secret, sessionId, body.csrf))) {
      return { kind: "deny", disposition: "CSRF_FAILED" };
    }

    try {
      const profile = await deriveProfilePure({
        secret: deps.secret,
        version: deps.version,
        sessionId,
        mode: labMode ? "lab" : "production",
      }, deps.recipe);

      // Verification gate (Turnstile in production; no-op in reference).
      // P1-AUDIT-2 (P1-4): the middleware extracts the CANONICAL
      // VerificationInput from the already-consumed body + headers ONCE —
      // a provider adapter never guesses where the token lives or re-reads
      // a consumed request stream.
      const verificationInput: VerificationInput = {
        token:
          body.turnstileToken ??
          (typeof (body as Record<string, unknown>).cf_turnstile_response === "string"
            ? ((body as Record<string, string>).cf_turnstile_response)
            : form["cf-turnstile-response"]),
        action: typeof (body as Record<string, unknown>).turnstileAction === "string"
          ? (body as Record<string, string>).turnstileAction
          : undefined,
        hostname: typeof (body as Record<string, unknown>).turnstileHostname === "string"
          ? (body as Record<string, string>).turnstileHostname
          : undefined,
        remoteIp: req.headers.get("cf-connecting-ip") ?? undefined,
        userAgent: req.headers.get("user-agent") ?? undefined,
        requestUrl: req.url,
      };
      const allowed = await deps.verification.verify(profile, verificationInput);
      if (!allowed) return { kind: "deny", disposition: "VERIFICATION_FAILED" };

      // Build server-verifiable observations from the submitted form.
      const observations: ObservationSet = {};
      if (profile.decoyField) {
        const v = form[profile.decoyField.fieldName];
        if (v && v !== "") {
          observations.decoyFieldPopulated = true;
          if (profile.semantic && v === profile.semantic.nonce) {
            observations.decoyFieldMatchesNonce = true;
          }
        }
      }
      // Telemetry → interaction observations.
      // P1-AUDIT-2 (P0-5): the batch is PERSISTED via the observation store
      // before scoring, so a session that flushed batches through earlier
      // requests scores its WHOLE stream — the Worker behavior — instead of
      // only whatever rode along on this submit. The store validates with
      // the CANONICAL validateTelemetryBatch (P0-4: same events accepted,
      // same rejected, same seq/dt/kind/target/meta — no fabricated
      // timestamps). A structurally invalid batch is a DENY, never a
      // silent repair (FR-R6-035 semantics on the host plane).
      const accepted = await deps.telemetry.accept(sessionId, body.eventBatch ?? []);
      if (accepted === null) {
        deps.enforcement.deny(sessionId, "INVALID_TELEMETRY");
        return { kind: "deny", disposition: "INVALID_TELEMETRY" };
      }
      if (profile.interaction?.scoringEnabled) {
        // Score the WHOLE persisted stream, not just the final batch.
        const events = await deps.telemetry.collect(sessionId);
        if (events.length > 0) {
          const capture: CaptureConfig = {
            capturePointer: profile.telemetry.capturePointer,
            captureKey: profile.telemetry.captureKey,
          };
          // P1-AUDIT-2: the canonical aggregator over CANONICAL events —
          // real client dt values, capture-aware metrics, the same mapping
          // submit.ts applies (veryShortCompletion threshold included).
          const metrics = aggregateTelemetry(events, capture);
          observations.directFill = metrics.directFill;
          if (metrics.completionMs > 0 && metrics.completionMs < 3000) {
            observations.veryShortCompletion = true;
          }
          if (metrics.noPointerEvents === true) observations.noPointerEvents = true;
          if (metrics.missingInteractionSequence === true) observations.missingInteractionSequence = true;
        }
      }

      // P1-AUDIT-2 Phase D (audit item 6): read back VERIFIED canary hits —
      // the host counterpart of submit.ts's canary_hits COUNT. A verified
      // probe of the decoy route before submission is Class-A causal
      // evidence (CANARY_ROUTE_MATCH, weight 100 → QUARANTINE).
      if (deps.canaryStore && profile.decoyRoute) {
        const hit = await deps.canaryStore.readVerified(sessionId);
        if (hit) observations.canaryEndpointHit = true;
      }

      const evidence = await correlate(profile, observations);
      // P1-AUDIT-2 (P1-2): the profile's OWN scoring policy decides —
      // strict-v1 / permissive-v1 are real treatments on the host plane
      // too. Unknown policy fails closed (deny, never default-score).
      const policy = resolveScoringPolicy(profile);
      if (!policy) {
        deps.enforcement.deny(sessionId, "UNKNOWN_SCORING_POLICY");
        return { kind: "deny", disposition: "UNKNOWN_SCORING_POLICY" };
      }
      const decision = decide(evidence, policy);

      // P1-AUDIT-2: forward ONLY on an explicit ACCEPT. The prior code
      // forwarded on everything but QUARANTINE, so REVIEW (unresolved),
      // REJECT_TURNSTILE and INVALID_SESSION all reached the origin — the
      // exact outcomes admission is supposed to block. REVIEW is a deny here
      // (fail-closed); only ACCEPT is unambiguous admission.
      if (decision.disposition !== "ACCEPT") {
        deps.enforcement.deny(sessionId, decision.disposition);
        return { kind: "deny", disposition: decision.disposition };
      }

      // Admission allowed: strip FireRaid fields and forward to upstream.
      // A urlencoded post carries the submit button's name/value too — the
      // strip pass only removes FireRaid fields, so non-string values can
      // never appear here (URLSearchParams yields strings), but the forward
      // payload must stay Record<string,string>-shaped.
      const cleanForm = stripFireRaidFields(form, profile);
      const cookies = req.headers.get("cookie") ?? "";
      const upstreamCreated = await deps.enforcement.allow(
        deps.upstreamRegisterUrl,
        cleanForm,
        cookies
      );
      return {
        kind: "admit",
        disposition: decision.disposition,
        upstreamCreated,
      };
    } catch {
      // Fail-closed: never forward on an evaluation error.
      return { kind: "deny", disposition: "EVAL_ERROR" };
    }
  }

  return { kind: "deny", disposition: "METHOD_NOT_ALLOWED" };
}

/**
 * P1-AUDIT-2 Phase D (audit item 6): host-side canary probe — the
 * presentation-neutral counterpart of routes/canary.ts. Same verification
 * ORDER and the same failure semantics:
 *   no session        → deny (403-equivalent)
 *   no decoyRoute     → deny NO_ROUTE (404-equivalent: FR-R6-028 — a
 *                       DECOY_ROUTE-less session must 404, not fall back)
 *   wrong token       → deny INVALID_TOKEN (403-equivalent)
 *   store failure     → deny CANARY_PERSIST_FAILED (FAIL-CLOSED, 500-
 *                       equivalent: a verified hit lost while returning
 *                       success would corrupt the causal signal)
 * Verified hits persist via HostCanaryStore (idempotent replays OK).
 */
async function handleCanaryGet(
  req: Request,
  deps: MiddlewareDeps,
  token: string
): Promise<MiddlewareResult> {
  const store = deps.canaryStore!;
  if (!token) return { kind: "deny", disposition: "MISSING_TOKEN" };
  const sessionId = await deps.session.readSessionId(req);
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };
  try {
    const profile = await deriveProfilePure({
      secret: deps.secret,
      version: deps.version,
      sessionId,
      mode: deps.labMode === true ? "lab" : "production",
    }, deps.recipe);
    if (!profile.decoyRoute) return { kind: "deny", disposition: "NO_ROUTE" };
    const expected = profile.decoyRoute.endpointToken;
    if (!constantTimeTokenEqual(token, expected)) {
      return { kind: "deny", disposition: "INVALID_TOKEN" };
    }
    const persisted = await store.record(sessionId, token, expected);
    if (!persisted) return { kind: "deny", disposition: "CANARY_PERSIST_FAILED" };
    return { kind: "canary-verified", disposition: "CANARY_VERIFIED" };
  } catch {
    return { kind: "deny", disposition: "EVAL_ERROR" };
  }
}

/**
 * P1-AUDIT-2: KEYED CSRF token. The prior `makeCsrf(sessionId)` was an unkeyed
 * SHA-256 of the PUBLIC sid — anyone who saw the cookie could forge the token.
 * Now it's HMAC-SHA-256 keyed with the deployment secret, so the token is
 * unforgeable without the secret and is bound to the session.
 */
export async function makeCsrf(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`csrf:${sessionId}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a keyed CSRF token against a session (constant-time compare). */
export async function verifyCsrf(
  secret: string,
  sessionId: string,
  token: string
): Promise<boolean> {
  const expected = await makeCsrf(secret, sessionId);
  // Constant-time compare with length folded in (no early return — mirrors
  // constantTimeTokenEqual; an early length-check would leak token length).
  const len = Math.max(expected.length, token.length);
  let diff = expected.length ^ token.length;
  for (let i = 0; i < len; i++) {
    const x = i < expected.length ? expected.charCodeAt(i) : 0;
    const y = i < token.length ? token.charCodeAt(i) : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

// hashProfile re-exported for hosts that persist the profile hash.
export { hashProfile };
