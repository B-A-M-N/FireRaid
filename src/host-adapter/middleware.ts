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
import type { DefenseProfile } from "../types/profile.js";
import type {
  HostSessionAdapter,
  HostRenderAdapter,
  HostVerificationAdapter,
  HostTelemetryAdapter,
  HostEnforcementAdapter,
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
  /** "get" | "admit" | "deny" | "error". */
  kind: "get" | "admit" | "deny" | "error";
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

  // ── GET: issue session, derive profile, inject, return page ──────────────
  if (req.method === "GET") {
    try {
      const sessionId = await deps.session.createSession();
      const profile = await deriveProfilePure({
        secret: deps.secret,
        version: deps.version,
        sessionId,
        mode: labMode ? "lab" : "production",
      }, deps.recipe);
      const csrfToken = await makeCsrf(sessionId);
      const html = await htmlLoader();
      const page = deps.render.inject(html, profile, csrfToken, labMode);
      return { kind: "get", html: page, setCookie: deps.session.sessionCookie(sessionId) };
    } catch {
      return { kind: "error" };
    }
  }

  // ── POST: evaluate, strip, forward only when admission allows ────────────
  if (req.method === "POST") {
    const sessionId = deps.session.readSessionId(req);
    if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };

    let body: { csrf?: string; form?: Record<string, string>; eventBatch?: unknown };
    try {
      body = await req.json();
    } catch {
      return { kind: "deny", disposition: "BAD_JSON" };
    }
    const form = (body.form ?? {}) as Record<string, string>;

    try {
      const profile = await deriveProfilePure({
        secret: deps.secret,
        version: deps.version,
        sessionId,
        mode: labMode ? "lab" : "production",
      }, deps.recipe);

      // Verification gate (Turnstile in production; no-op in reference).
      const allowed = await deps.verification.verify(req, profile);
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
      // Telemetry → interaction observations (best-effort normalization).
      const events = deps.telemetry.accept(body.eventBatch);
      if (profile.interaction?.scoringEnabled && events.length > 0) {
        const hasPointer = events.some((e) => e.kind === "pointer");
        if (!hasPointer) observations.noPointerEvents = true;
      }

      const evidence = await correlate(profile, observations);
      const decision = decide(evidence);

      if (decision.disposition === "QUARANTINE") {
        deps.enforcement.deny(sessionId, "QUARANTINE");
        return { kind: "deny", disposition: "QUARANTINE" };
      }

      // Admission allowed: strip FireRaid fields and forward to upstream.
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

/** Simple CSRF-style token for the reference adapter (host may supply its own). */
async function makeCsrf(sessionId: string): Promise<string> {
  const data = new TextEncoder().encode(`csrf:${sessionId}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// hashProfile re-exported for hosts that persist the profile hash.
export { hashProfile };
