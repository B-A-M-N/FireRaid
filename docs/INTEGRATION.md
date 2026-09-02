# FireRaid Integration Guide

FireRaid has TWO API planes with a one-way dependency direction:
**evaluation → production**, never production → evaluation override.

| Plane | Entry points | May configure |
|-------|--------------|---------------|
| **Production** | `createFireRaidMiddleware` + `admit`, `createOriginServer`, `deriveProductionProfile` | Nothing experimental — no labMode, no recipe, no holdout |
| **Evaluation** | `createEvaluationMiddleware` + `admitEvaluation`, `deriveEvaluationProfile` | Treatment surface (recipes, holdout, verification condition) |

A production deployment cannot configure itself into a weak lab condition:
the production factory throws on smuggled `labMode`/`recipe`, and
`deriveProductionProfile` takes no treatment parameters at all.

## Host-Neutral Core (`src/core/`)

The defense core has no Cloudflare imports. You can use its primitives
directly, but most hosts should use the middleware instead (next section).

```ts
import { deriveProductionProfile } from "../src/core/profile.js";
import { renderSignupPage } from "../src/core/renderer.js";
import { correlate } from "../src/core/correlation.js";
import { decide, DEFAULT_POLICY } from "../src/core/decision.js";

// 1. Session — your store, your crypto.
const sessionId = generateSecureId(); // your crypto

// 2. Derive the production random composition: one of P02/P03/P04 as the
//    causal semantic strategy plus ≥1 independent trap layer (DiD). The
//    same (secret, version, sessionId) always re-derives the same profile.
const profile = await deriveProductionProfile({
  secret: process.env.FIRERAID_PROFILE_SECRET!, // ≥ 32 bytes
  version: 1,
  sessionId,
});

// 3. Render — inject traps + neutral client config into your page HTML.
const html = renderSignupPage({
  html: yourSignupHtml, // must contain a </form> (injection anchor)
  profile,
  csrfToken,            // your CSRF token
  routes,               // ONE canonical route table (see below)
});

// 4. On submission — correlate server observations against the SAME profile.
const evidence = await correlate(profile, observations);
const decision = decide(evidence, DEFAULT_POLICY);
// decision.disposition: "ACCEPT" | "REVIEW" | "QUARANTINE"
```

What `observations` must contain (`ObservationSet`, `src/core/correlation.ts`):
`canaryEndpointHit`, `decoyFieldPopulated`, `decoyFieldMatchesNonce`,
`canaryReferencedInTelemetry` — all server-side truth. Harness/LLM
self-reports are NOT part of `ObservationSet`; they ride the separate
evaluation correlation path and are never trusted by a production host.

## The Middleware (recommended)

`createFireRaidMiddleware(deps)` (src/host-adapter/middleware.ts) is the
production entry point. It validates the full capability contract at
wiring time and throws `MiddlewareConfigError` on any gap:

- `secret` ≥ 32 bytes; `version` a positive integer
- `routes` — REQUIRED, the one canonical route table:
  `{ applicationPage, applicationSubmit, telemetry, canaryPrefix }`.
  Dispatch, artifact URLs, canary parsing, and the browser client config
  all resolve from this single object. There is no separate
  `canaryPathPrefix` — configuring one is a startup error.
- `canaryStore` — REQUIRED (the P02/P04 strategies need verified
  route-evidence storage; a deployment that cannot observe a causal
  channel must not announce it)
- `session`, `render`, `telemetry`, `enforcement` adapters
- `verification` — if present, must be a real verifier (the disabled
  no-op test verifier is rejected)
- `riskTiers` — validated as an exact partition of [0, ∞) at startup
- `csrfSecret` — dedicated CSRF key; issuance and verification resolve
  through ONE resolver, so rotation of profile keys never changes CSRF
  behavior
- `profileKeys` — optional key ring, validated (ids, lengths, duplicates)

```ts
const deps = createFireRaidMiddleware({
  secret, version: 1,
  routes: {
    applicationPage: "/signup",
    applicationSubmit: "/signup",
    telemetry: "/api/events",
    canaryPrefix: "/c/",
  },
  csrfSecret,
  session: new ReferenceSessionAdapter(secret),
  render: { inject: referenceInject },
  telemetry: new ReferenceTelemetryAdapter(),
  enforcement: { allow: myUpstreamCreate, deny: myDenyHook },
  canaryStore: new ReferenceCanaryStore(),
  verification: myVerifier, // optional
});

// GET applicationPage → inject page (sets the signed session cookie)
// POST applicationSubmit → admit():
const result = await admit(request, deps);
// result.disposition / result.score / result.risk — HOST-INTERNAL.
// The middleware's HTTP responses are decision-blind: a denied submission
// and an accepted one are indistinguishable on the wire.
```

Route the `Request` objects for your four routes into `admit`; it
dispatches page renders, submissions, telemetry batches, and canary-route
probes (`not-handled` is returned for foreign paths).

## Node Origin Runtime

`src/runtime/node.ts` wraps the middleware in a standalone HTTP server —
no Worker, no D1, no Cloudflare anything:

```ts
import { createOriginServer, closeServer } from "../src/runtime/node.js";

const server = createOriginServer({
  middlewareDeps: deps,          // same shape as above
  htmlLoader: async () => signupHtml,
  port: 8443,
  routes,
  clientScriptSource: () => readFileSync("public/signup.js", "utf-8"),
  onAssessment: (a) => persistAnnotation(a), // host-internal hook
});
```

`onAssessment` receives the full assessment (disposition, score, tier,
evidence) for every evaluated submission — admit AND decision-deny. That
hook is the ONLY channel carrying decision material; the applicant always
receives the same neutral receipt:

```json
{"status": "received", "message": "Application received."}
```

`examples/origin-server.mjs` is a complete runnable integration.

## The Browser Client

`public/signup.js` is the shipped applicant-side client. It is fully
config-driven — the rendered page embeds a client config artifact
(form selector, submit/telemetry endpoints, evaluation mode, telemetry
limits) and the client contains no hardcoded paths. Serve it yourself via
`clientScriptSource` (origin runtime) or from your own static origin; the
script is host-agnostic.

In production the client renders only "Submission received." — it never
invents a disposition. The internal disposition renders only when the
config explicitly marks the page as an evaluation surface
(`evaluationMode: true`).

## Evaluation Plane

Experimental conditions (ablation recipes, holdout probes, fixed
treatments) live behind the evaluation API:

```ts
import { createEvaluationMiddleware } from "../src/eval/evaluation-middleware.js";
import { deriveEvaluationProfile } from "../src/core/profile.js";

const profile = await deriveEvaluationProfile(
  { secret, version, sessionId },
  recipe // DefenseRecipe — validated fail-closed (INVALID_RECIPE on
);      //  lab-only-in-production or unknown template composition
```

`createEvaluationMiddleware` extends the production deps with
`EvaluationControls` (`labMode`, `recipe`, `holdoutMode`). The evaluation
factory performs all production validation FIRST, then layers controls.
Anything the evaluation plane can do, it does by calling production
primitives — never by weakening them.

## Key Invariants for Any Host

1. **Determinism**: render and submit must see the SAME profile — derive
   from the session envelope, never re-roll. Reconstruction from
   `(secret, version, sessionId)` is exact; the profile variant id binds
   the full treatment identity.
2. **Fail-closed**: derivation and the factory throw on invalid
   configuration. Never catch-and-fallback — a fallback silently assigns
   treatment the system cannot prove.
3. **Origin opacity**: never serialize `MiddlewareResult` to the
   applicant. Decision material flows to the host (return value /
   `onAssessment`), never to the wire. Denied and accepted submissions
   must be indistinguishable to the sender.
4. **Capability honesty**: if you deploy the production strategy pool,
   provide the capability each strategy needs (route store, telemetry,
   render). The factory enforces this; do not bypass it.
5. **Trust boundary**: `CF-Connecting-IP` is trustworthy only behind a
   Cloudflare edge that overwrites it. On a non-Cloudflare origin it is
   client-controlled and must not feed rate limiting or verification.

## Adapter Notes

- **Cloudflare Worker** (`src/index.ts` + `src/routes/`) remains the
  first-party adapter: `__Host-fr_sid` cookies, D1 persistence,
  Turnstile, static assets, lab-run binding. It is NOT required — the
  Node runtime is the Cloudflare-free path.
- **Renderer contract**: `buildArtifactSet(profile, { labMode, routes })`
  (src/core/artifacts.ts) is the ONE policy decision of what to emit; the
  Worker renderer (`renderSignupPage`) and host renderer
  (`referenceInject`) are presentation mappers that choose HTML strings,
  never policy.

## FI Integration

See [FI-INTEGRATION.md](./FI-INTEGRATION.md) for the FreeInference
reference integration.
