# FireRaid Architecture

## Overview

FireRaid is a deterministic, per-session, randomized defense-in-depth middleware
for autonomous-agent admission control. It is deliberately split into two planes:

- **Defense plane**: deterministic, no LLM, auditable, production-eligible
- **Evaluation plane**: uses LLMs, intentionally attacks the product, measures defenses

The dependency direction is **evaluation → production**, never production →
evaluation override: the production API (`createFireRaidMiddleware` +
`admit`, `deriveProductionProfile`, the Node origin runtime in
`src/runtime/node.ts`) accepts no experimental configuration, while the
evaluation API (`createEvaluationMiddleware` + `admitEvaluation`,
`deriveEvaluationProfile`) may compose production primitives into lab
treatments. The product runs on any origin — Cloudflare is one adapter,
not a requirement.

## Core Primitives

### Session
- Cryptographically random 128-bit ID (`crypto.getRandomValues`)
- Secure cookie: `__Host-fr_sid` (HttpOnly, Secure, SameSite=Strict)
  - Lab mode: bare session id (stateful rows from first request)
  - Production: HMAC-signed envelope (stateless until the first stateful
    action materializes the session row — FR-P1-19)
- 30-minute TTL

### Defense Profile
- Root key: `HMAC-SHA256(profile_secret, version:session_id)`
- Per-dimension streams: `HMAC(root, len-prefixed domain label)` —
  composition, semantic strategy/wording/nonce/spots, field name,
  field element, route token, telemetry mask each draw from their OWN
  domain, so one randomized choice can never perturb another (golden
  vectors: `tests/unit/prf-domain-golden.test.ts`)
- Derives: composition policy, semantic strategy, causal channel, decoy-field strategy, carrier strategy, placement, identifiers, route, nonce, telemetry mask, policy
- Immutable per version; exact reconstruction from
  `(secret, version, sessionId)`
- Production composition: ONE of P02/P03/P04 as the causal semantic
  strategy (`PRODUCTION_AGENT_STRATEGIES`) plus ≥1 independent trap
  layer beyond the strategy's own dependency (DiD) — a single
  deterministic seed chooses strategy, companions, and the independent
  layer per session

### Defense Families
1. **Semantic canary** — structurally inert instruction carrier (production P02–P04 + evaluation S-probes; P06 placement, invisible to humans/AX/keyboard). Route-armed strategies (P02/P04) bind their instruction to a fill-expressible `session_response` actuator sink (E5 lever): an agent that obeys the delivered instruction produces server-verifiable Class-A evidence by filling it
2. **Decoy field** — session-specific hidden input, opaque hex name (no fixed prefix)
3. **Decoy route** — session-specific probe endpoint under the operator-configured `routes.canaryPrefix`
4. **Interaction telemetry** — coarse event sequencing plus depth signals (zero-dwell fill, uniform input cadence, no-blur-before-submit)

### Evidence Taxonomy
- **Class A (causal)**: correct nonce, correct endpoint, `session_response` populated on a route-armed profile
- **Class B (strong behavioral)**: decoy manipulated, non-UI path
- **Class C (weak heuristic)**: fast completion, direct fill, no pointer events, zero-dwell fill, uniform input cadence, no-blur-before-submit

### Decision Engine
- Class A exists → QUARANTINE
- Strong + high score → REVIEW
- Weak only → ACCEPT or REVIEW per policy
- **FR-RR-15 — the version freeze covers the full admission TREATMENT
  downstream of the observation set**: correlation, the scoring-policy
  table, and the decide() rule are frozen per profile version
  (`core/correlation-v1.ts`, `core/decision-v1.ts`), dispatched by the
  reconstructed profile's version through `core/scoring-versions.ts` —
  never resolved from live code. Editing a v1 weight/threshold in the live
  modules cannot re-decide an issued pv=1 session; a semantics change
  requires v2. An unsupported version or unknown policy name fails closed
  (operational denial, never a default-policy score). Parity between the
  frozen v1 path and the live modules at the freeze is pinned exhaustively
  by `tests/unit/scoring-versions-parity.test.ts`.
- **FR-RR-32 — freeze boundary, stated exactly**: the raw-input →
  `ServerObservationSet` mapping is LIVE shared code, NOT frozen per
  version. Form-field reads, the telemetry aggregator's thresholds
  (`aggregateTelemetry`: 3s short-completion floor, dwell/cadence rules),
  and the verified-canary readback run current logic for EVERY version —
  including pv=1. The freeze therefore guarantees: the same observation
  set always produces the same v1 evidence and decision. It does NOT
  guarantee: the same raw request always produces the same observation
  set across deployments. The mapping is pinned by parity tests
  (`session-metrics-parity`, `host-worker-parity`) and changes to it are
  observable — but they are v0-rolling behavior, not frozen treatment.
  Freezing the mapper itself (a v1-frozen `observations-v1.ts`) is the
  designated v2 work item.
- **FR-RR-33 — recipes are OUTSIDE the freeze**: a `DefenseRecipe`
  (strategy/composition override) is an EVALUATION-plane experimental
  condition only. It is unreachable from production wiring (the
  production factory refuses it at validation) and is never part of any
  frozen version's treatment; recipe-schema validation may evolve without
  touching any version freeze.
- Turnstile failure → explicit path
- Risk tiers are an EXACT partition of [0, ∞) validated at startup —
  no out-of-partition fallback; a verified Class-A observation forces
  the CAUSAL tier regardless of numeric score
- Enforcement postures: `advisory` (annotate only), `review`
  (quarantine → human review), `enforcement` (CAUSAL auto-denies)

FireRaid exports recommendations (risk level + recommended action), not binary decisions.
The host integrates with its existing application review workflow.

## Request Lifecycle

Production middleware routes (from the ONE canonical `routes` table):

```
GET  <applicationPage>   → session → derive profile → render HTML with defenses (traps + neutral client config)
POST <applicationSubmit> → resolve session → CSRF → reconstruct profile → correlate server observations → decide → persist → NEUTRAL receipt
GET  <canaryPrefix>:token → resolve session → verify token → record causal hit → 204
POST <telemetry>         → resolve session → validate batch → persist
```

The submit path strips defense-owned fields (`session_response` on
route-armed profiles, plus the decoy field) before upstream forwarding, so
compliance evidence is recorded without leaking trap material to the host
application.

The applicant-facing response is decision-blind in every posture:
accepted and denied submissions receive byte-identical neutral receipts;
the host reads the assessment via the return value / `onAssessment` hook.

## Invariants (FR-INV-001 through FR-INV-010)

See [docs/INVARIANTS.md](INVARIANTS.md) for the authoritative full list. These are non-negotiable.

