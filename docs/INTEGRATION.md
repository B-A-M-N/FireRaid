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
- `submissionStore` — REQUIRED (FR-P0-02: the durable
  claim/replay/complete record that makes "one session → one irreversible
  forward" true across retries and restarts)
- `session`, `render`, `telemetry`, `enforcement` adapters
- `verification` — if present, must be a real verifier (the disabled
  no-op test verifier is rejected)
- `riskTiers` — validated as an exact partition of [0, ∞) at startup
- `csrfSecret` — dedicated CSRF key; issuance and verification resolve
  through ONE resolver, so rotation of profile keys never changes CSRF
  behavior
- `profileKeys` — REQUIRED production key ring, validated (ids, lengths,
  duplicates); production configurations without it are rejected at
  wiring time
- **Durability is asserted, exactly**: every evidence store
  (`telemetry`, `canaryStore`, `submissionStore`) must carry
  `durability: "durable"` — the literal string. An adapter that omits the
  field, misspells it, or declares `"volatile"` fails wiring. There is no
  production opt-out; in-memory stores belong to the evaluation plane
  (below).

```ts
const deps = createFireRaidMiddleware({
  profileKeys: { current: { id: "default", secret } }, // key ring (REQUIRED)
  version: 1,
  routes: {
    applicationPage: "/signup",
    applicationSubmit: "/api/submit",
    telemetry: "/api/events",
    canaryPrefix: "/c/",
  },
  csrfSecret,
  session: new ReferenceSessionAdapter(secret),
  render: { inject: referenceInject },
  // ── Durable evidence stores (YOUR adapters over YOUR database) ──────
  // Each MUST set durability: "durable" — the exact string. Implement the
  // interface over D1/Postgres/R2/…; the reference in-memory stores are
  // "volatile" and are REJECTED here.
  telemetry: myDurableTelemetry,    // { durability: "durable", accept, collect }
  canaryStore: myDurableCanaryStore,// { durability: "durable", record, readVerified, drop }
  submissionStore: myDurableSubmissions, // { durability: "durable", claim, complete, lookupFinal? }
  enforcement: { allow: myUpstreamCreate, deny: myDenyHook },
  verification: myVerifier, // optional — must be a real verifier
});

// GET applicationPage → inject page (sets the signed session cookie)
// POST applicationSubmit → admit():
const result = await admit(request, deps, htmlLoader);
// result.disposition / result.score / result.risk — HOST-INTERNAL.
// The middleware's HTTP responses are decision-blind: a denied submission
// and an accepted one are indistinguishable on the wire.
```

A minimal durable `submissionStore` over SQL looks like:

```ts
const submissionStore = {
  durability: "durable" as const,
  async claim(sessionId: string, idempotencyKey: string) {
    // Conditional INSERT/UPDATE: succeeds exactly once per session.
    // INSERT INTO submission_claims (session_id, idempotency_key, state)
    // VALUES (?, ?, 'open') — unique(session_id) → conflict when held,
    // replay when a terminal outcome row exists.
    ...
  },
  async complete(claimId: string, outcome) { /* persist outcome; release on definite transport failure */ },
  async lookupFinal(sessionId: string) { /* stored terminal outcome or null */ },
};
```

Send the claim's `idempotencyKey` to your upstream with the forward
(`Idempotency-Key` header) when the upstream supports it — that is what
makes a post-send timeout reconcilable instead of a possible duplicate.

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
  routes,
  // public/signup.js ships in the npm tarball ("files" includes public/) —
  // read it from the installed package, or vendor your own copy.
  clientScriptSource: () =>
    readFileSync(join("node_modules", "fireraid", "public", "signup.js"), "utf-8"),
  onAssessment: (a) => persistAnnotation(a), // host-internal hook
});
server.listen(8443); // the host owns binding (P1-1: no `port` option)
```

`onAssessment` receives the full assessment (disposition, score, tier,
evidence) for every evaluated submission — admit AND decision-deny. That
hook is the ONLY channel carrying decision material; the applicant always
receives the same neutral receipt:

```json
{"status": "received", "message": "Application received."}
```

**`onAssessment` is a durability seam**: return a `Promise` and the
runtime awaits it BEFORE writing the receipt — an application is only
acked once its annotation is durable. A rejecting hook fails the request
with a generic 5xx (never a success receipt), because a receipt for an
annotation that failed to persist is a promise the review pipeline cannot
keep.

Two storage caveats:

- The reference stores (`ReferenceTelemetryAdapter`,
  `ReferenceCanaryStore`, `ReferenceSubmissionStore`) are **volatile** —
  in-process, lost on restart. They declare `durability: "volatile"`
  (FR-P1-03) and the PRODUCTION factory (`createFireRaidMiddleware`)
  THROWS `MiddlewareConfigError` when handed one — evidence that
  disappears on restart cannot anchor review decisions or a one-submission
  claim. The durable check is EXACT: a store whose `durability` is
  `undefined` (the field never set) is equally rejected. The sanctioned
  non-durable path is `createEvaluationMiddleware` (or
  `createEvaluationOriginServer` for the Node runtime) — there is no
  production opt-out and no public bypass. Fine for local development and
  integration; production deployments must wire durable adapters and
  label them truthfully.
- **`forward-failed`**: when the upstream registration cannot be forwarded
  AND your enforcement adapter did not durably capture the application,
  `admit()` returns `kind: "forward-failed"` and the reference runtime
  answers 502 — never a success receipt. Return
  `{ kind: "queued-for-retry", retryId }` from `allow()` after capturing
  the application in your own durable pending store to get the admit path
  with at-least-once forwarding semantics.

`examples/origin-server.mjs` is a complete runnable integration (local-dev
posture: honestly-volatile stores through `createEvaluationOriginServer`;
its header documents exactly what a production wiring must change).

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
