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
  claim/replay/complete/finalizeDecision record that makes "one session →
  one irreversible forward" true across retries and restarts — the full
  state machine is documented below)
- `session`, `render`, `telemetry`, `enforcement` adapters
- `session` — must declare `profileIntegrity: "issued-hash"` (FR-RR-27)
  and honor it: sign the issued profile hash into the session envelope
  (`fr2` with the `ph` claim) and return it from `resolveSession()`, so
  every derivation is drift-checked against the treatment that was issued
  (FR-RR-12). Hashless session carriers are the evaluation plane's domain
  and are REJECTED here.
- `verification` — REQUIRED. Every submit passes through it on the way to
  the forward. It must declare `verificationMode: "host-owned"` (you
  verified the human elsewhere and hand FireRaid the verdict) or
  `"provider"` (a real external challenge is wired); the disabled no-op
  test verifier (`"disabled-test"`) is REJECTED at wiring time. An
  adapter that silently waves submissions through is not a verifier.
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
  submissionStore: myDurableSubmissions, // { durability: "durable", claim, complete, finalizeDecision, lookupFinal? }
  enforcement: { allow: myUpstreamCreate, deny: myDenyHook },
  verification: myVerifier, // REQUIRED — "host-owned" or "provider"
});

// GET applicationPage → inject page (sets the signed session cookie)
// POST applicationSubmit → admit():
const result = await admit(request, deps, htmlLoader);
// result.disposition / result.score / result.risk — HOST-INTERNAL.
// The middleware's HTTP responses are decision-blind: a denied submission
// and an accepted one are indistinguishable on the wire.
```

### The Submission Store Is a State Machine

The store guards the ONE irreversible forward per session AND every
terminal decision. Its states and legal transitions (FR-RR-40/41):

```
NONE ─claim───────────────────→ FORWARD_CLAIMED
                                  ├─ complete(terminal outcome) → TERMINAL
                                  └─ complete(uncertain)        → FORWARD_UNCERTAIN
NONE ─finalizeDecision───────→ TERMINAL (decision-denied)
```

There is NO automatic transition out of `FORWARD_CLAIMED` or
`FORWARD_UNCERTAIN` into a decision denial:

- `FORWARD_CLAIMED` — another request may be mid-forward across the
  irreversible boundary. `finalizeDecision` returns
  `{ kind: "conflict", state: "forward-claimed" }`; it must never
  overwrite the claim.
- `FORWARD_UNCERTAIN` — the forward MAY have reached the upstream but its
  outcome is unknown. This state is ABSORBING for automatic processing: a
  later denial must NOT convert "unknown" into "blocked". Only an explicit
  operator reconciliation may resolve it. `claim` and `finalizeDecision`
  both return conflict.
- `TERMINAL` — first writer wins, verbatim: a second finalizer (or a
  claiming retry) receives `{ kind: "replay", record }` carrying the
  EXACT original record.

Methods (all REQUIRED in production — the factory checks at startup):

```ts
const submissionStore = {
  durability: "durable" as const,

  // NONE → FORWARD_CLAIMED (or replay/conflict). Implement as a
  // conditional INSERT — unique(session_id) → conflict when held;
  // a TERMINAL row → replay.
  async claim(sessionId, idempotencyKey) { ... },

  // Record the forward's outcome. FR-RR-45 overloads: a TERMINAL outcome
  // (created / business-rejected / queued-for-retry) REQUIRES the
  // assessment snapshot in the trailing meta object; only a
  // transport-failure outcome may omit it.
  async complete(claimId, outcome, signal, meta) { ... },

  // NONE → TERMINAL (decision-denied). Returns:
  //   { kind: "stored", record }                       — this call won
  //   { kind: "replay", record }                       — first writer wins
  //   { kind: "conflict", state: "forward-claimed" | "forward-uncertain" }
  async finalizeDecision(sessionId, record, signal) { ... },

  // Return the stored terminal record ({ version: 2, outcome,
  // assessment }) or null. FORWARD_UNCERTAIN has NO final record.
  async lookupFinal(sessionId) { ... },

  // OPTIONAL (recommended): the deny PROJECTION ledger (FR-RR-42).
  // enforcement.deny is a replayable projection of the durable record;
  // these track whether the host-side denial annotation actually landed.
  async markDenyProjectionComplete(sessionId) { ... },
  async denyProjectionState(sessionId) { ... }, // "pending"|"complete"|undefined
};
```

Every transition MUST be an atomic conditional write in SQL (a single
`UPDATE … WHERE state = …` or an equivalent unique-index insert) — never a
read-then-write decided in application logic, which races concurrent
requests.

Record shape: ONLY the v2 schema is accepted at the parser boundary —
`{ version: 2, outcome, assessment }` with the assessment snapshot
mandatory. Older assessment-less records are rejected as malformed
(FR-RR-46); a host with genuine pre-release data migrates it with an
explicit reconciliation tool rather than keeping a compatibility window
open in the runtime.

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

**Replay safety (FR-RR-14)**: when a client retries after such a failure,
the retried `onAssessment` carries the ORIGINAL assessment — the
disposition, score, email, and risk evidence captured when the forward
finalized — with `replayed: true` set (the semantic disposition is never
replaced by "REPLAY"). Persist assessments with an UPSERT keyed on
`assessment.sessionId`; a replay then rewrites the same review row
idempotently instead of duplicating it.

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
