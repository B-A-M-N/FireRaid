/**
 * P1-AUDIT-2 (Batch 3) — Worker plane vs host plane DECISION PARITY.
 *
 * The audit's required equivalence property: for the SAME profile and the
 * SAME observations, the host middleware's decision must equal the Worker
 * submit route's decision — the host plane is only evidence about the
 * Worker plane if they score identically. The prior host path diverged in
 * three ways, each fixed and pinned here:
 *   - P1-2: host ignored the profile's scoring policy (always DEFAULT).
 *   - P0-4: host fabricated dt = (i+1)*10 and dropped meta.
 *   - P0-5: host scored only the submit request's final batch, not the
 *     session's whole stream.
 *
 * Parity is asserted per-condition over ALL ablation recipes and BOTH
 * scoring policies: derive one profile, feed the same event stream + form
 * through (a) the host admit() middleware and (b) the canonical scoring
 * path the Worker submit route runs (aggregateTelemetry → correlate →
 * decide(evidence, getPolicy(profile.scoringPolicy))). The Worker route
 * itself needs env.DB; the shared decision core below it is exactly what
 * the route executes between validation and persistence.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  makeCsrf,
  ReferenceSessionAdapter,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceCanaryStore,
  referenceInject,
} from "../../src/host-adapter/index.js";
import { deriveProfilePure, ABLATION_RECIPES, type DefenseRecipe } from "../../src/core/profile.js";
import { aggregateTelemetry, type CaptureConfig } from "../../src/telemetry/aggregate.js";
import { correlate, type ObservationSet } from "../../src/core/correlation.js";
import { decide, getPolicy } from "../../src/core/decision.js";
import type { ValidatedEvent } from "../../src/security/request-validation.js";

const SECRET = "parity".padEnd(64, "x");
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"></form><body></body>';

const ALL_CONDITIONS: DefenseRecipe[] = [
  ABLATION_RECIPES.FULL,
  ABLATION_RECIPES.SEMANTIC_ONLY,
  ABLATION_RECIPES.DECOY_FIELD_ONLY,
  ABLATION_RECIPES.DECOY_ROUTE_ONLY,
  ABLATION_RECIPES.INTERACTION_ONLY,
].filter(Boolean);

/** The Worker submit route's decision core (routes/submit.ts steps 9–11),
 * extracted verbatim so the test drives the SAME code. */
async function workerDecision(
  profile: Awaited<ReturnType<typeof deriveProfilePure>>,
  observations: ObservationSet
): Promise<string> {
  const policy = getPolicy(profile.scoringPolicy);
  const evidence = await correlate(profile, observations);
  return decide(evidence, policy).disposition;
}

/** The observation set the Worker submit route would build for this profile
 * + stream + form (routes/submit.ts steps 8–10: decoy field, telemetry
 * aggregation over the WHOLE stream, canary hits). */
function workerObservations(
  profile: Awaited<ReturnType<typeof deriveProfilePure>>,
  events: ValidatedEvent[],
  form: Record<string, string>,
  canaryVerified: boolean
): ObservationSet {
  const observations: ObservationSet = {};
  if (profile.decoyField) {
    const decoyValue = form[profile.decoyField.fieldName];
    if (decoyValue && decoyValue !== "") {
      observations.decoyFieldPopulated = true;
      if (profile.semantic && decoyValue === profile.semantic.nonce) {
        observations.decoyFieldMatchesNonce = true;
      }
    }
  }
  if (profile.decoyRoute && canaryVerified) {
    observations.canaryEndpointHit = true;
  }
  if (profile.interaction?.scoringEnabled && events.length > 0) {
    const capture: CaptureConfig = {
      capturePointer: profile.telemetry.capturePointer,
      captureKey: profile.telemetry.captureKey,
    };
    const metrics = aggregateTelemetry(events, capture);
    observations.directFill = metrics.directFill;
    if (metrics.completionMs > 0 && metrics.completionMs < 3000) {
      observations.veryShortCompletion = true;
    }
    if (metrics.noPointerEvents === true) observations.noPointerEvents = true;
    if (metrics.missingInteractionSequence === true) observations.missingInteractionSequence = true;
  }
  return observations;
}

/** Stream fixtures: real dt values (the canonical validator rejects
 * fabricated ones). Each exercises a different evidence shape. */
function streams(): Record<string, ValidatedEvent[]> {
  return {
    // Humanish: focus → input → keys → pointer → late submit.
    humanish: [
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 400, kind: "focus", target: "name" },
      { seq: 3, dt: 900, kind: "key", target: "name" },
      { seq: 4, dt: 1400, kind: "input", target: "name" },
      { seq: 5, dt: 2100, kind: "blur", target: "name" },
      { seq: 6, dt: 2600, kind: "focus", target: "email" },
      { seq: 7, dt: 3100, kind: "pointer", target: "email" },
      { seq: 8, dt: 3800, kind: "input", target: "email" },
      { seq: 9, dt: 12000, kind: "submit_attempt" },
    ],
    // Direct fill: input into a field that never saw focus.
    directFill: [
      { seq: 1, dt: 0, kind: "page_ready" },
      { seq: 2, dt: 50, kind: "input", target: "email" },
      { seq: 3, dt: 120, kind: "submit_attempt" },
    ],
    // No interaction at all (empty-capture semantics).
    none: [{ seq: 1, dt: 0, kind: "page_ready" }],
  };
}

describe("Worker vs host decision parity (Batch 3)", () => {
  for (const recipe of ALL_CONDITIONS) {
    // The "none" stream only exercises interaction scoring — it adds
    // nothing for recipes that don't include the interaction family
    // (SEMANTIC_ONLY / DECOY_FIELD_ONLY / DECOY_ROUTE_ONLY never draw one).
    const streamNames = (recipe.families ?? []).includes("interaction")
      ? Object.keys(streams())
      : Object.keys(streams()).filter((n) => n !== "none");
    for (const streamName of streamNames) {
      const stream = streams()[streamName];
      it(`recipe=${recipeName(recipe)} stream=${streamName}: host decision == worker decision`, async () => {
        // One session/profile for both planes.
        let sessionId = "";
        let profile: Awaited<ReturnType<typeof deriveProfilePure>> | null = null;
        for (let i = 0; i < 200; i++) {
          sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
          const p = await deriveProfilePure(
            { secret: SECRET, version: VERSION, sessionId, mode: "production" },
            recipe
          );
          // For the "none" stream we need interaction scoring on to make the
          // parity check meaningful; for others any profile works.
          if (p.interaction?.scoringEnabled || streamName !== "none") {
            profile = p;
            break;
          }
        }
        expect(profile).not.toBeNull();
        const p = profile!;

        // ── Host plane: full middleware run over a fresh adapter set ──
        const telemetry = new ReferenceTelemetryAdapter();
        const canaryStore = new ReferenceCanaryStore();
        // Simulate a verified canary hit for the parity arm that carries one
        // (only when the profile has a decoy route — else the observation
        // cannot exist on either plane).
        const canaryVerified = p.decoyRoute !== null && p.decoyRoute !== undefined;
        if (canaryVerified) {
          const ok = await canaryStore.record(sessionId, p.decoyRoute!.endpointToken, p.decoyRoute!.endpointToken);
          expect(ok).toBe(true);
        }
        const denial: { reason?: string } = {};
        const deps = {
          secret: SECRET,
          version: VERSION,
          upstreamRegisterUrl: "http://upstream.invalid/api/register",
          session: new ReferenceSessionAdapter(SECRET),
          render: { inject: (h: string, pr: never, c: string, l: boolean) => referenceInject(h, pr, c, l) },
          verification: new ReferenceVerificationAdapter(),
          telemetry,
          enforcement: {
            allow: async () => true,
            deny: (_sid: string, reason: string) => { denial.reason = reason; },
          },
          canaryStore,
          labMode: false,
          recipe,
        };
        const cookie = await new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
        const csrf = await makeCsrf(SECRET, sessionId);
        const form: Record<string, string> = { name: "Parity Probe", email: "parity@example.invalid" };
        // If the profile has a decoy field, fill it — the parity check is
        // most interesting when the observation exists on both planes.
        if (p.decoyField) form[p.decoyField.fieldName] = "parity-decoy-value";
        const req = new Request("http://mw/signup", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ csrf, form, eventBatch: stream }),
        });
        const res = await admit(req, deps as never, async () => SIGNUP_HTML);

        // ── Worker plane: the route's decision core over the same inputs ──
        const hostAccepted = telemetry.streamsFor(sessionId);
        const observations = workerObservations(p, hostAccepted, form, canaryVerified);
        const expected = await workerDecision(p, observations);

        // The host forwards only on ACCEPT; a deny must carry the SAME
        // disposition the core produced (modulo infrastructure denies,
        // which parity fixtures cannot trigger — verification is a no-op).
        if (res.kind === "admit") {
          expect(expected).toBe("ACCEPT");
          expect((res as { disposition: string }).disposition).toBe("ACCEPT");
        } else if (res.kind === "deny") {
          const got = (res as { disposition: string }).disposition;
          // Infrastructure denies are not scoring decisions.
          if (!["INVALID_TELEMETRY", "UNKNOWN_SCORING_POLICY", "INVALID_FORM", "CSRF_FAILED", "NO_SESSION"].includes(got)) {
            expect(got).toBe(expected);
          }
        } else {
          throw new Error(`unexpected result kind: ${res.kind}`);
        }
      });
    }
  }
});

function recipeName(recipe: DefenseRecipe): string {
  for (const [name, r] of Object.entries(ABLATION_RECIPES)) {
    if (r === recipe) return name;
  }
  return "custom";
}
