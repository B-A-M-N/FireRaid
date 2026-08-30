# FR-POST-R6-P4 — Perception measurement proof

## Claim

The five exposure states are DISTINCT and each is measured from its own
authoritative source:

| State | Owner | Source |
|---|---|---|
| ISSUED | server | profile projections (semantic/decoyField/decoyRoute) |
| EXPOSED | harness | perception artifacts ONLY (never server truth) |
| REFERENCED | harness | agent output containing EXACT session material |
| REQUESTED | harness | client fetched /c/ (agent-side request listener) |
| VERIFIED | server | canary_hits row, verified=1 (constant-time token match) |

## Bugs found and fixed by this phase

1. **canary.ts render/reconstruct drift** (critical, E3): the /c/ handler
   reconstructed lab-bound sessions WITHOUT the bound recipe — the
   reconstructed endpointToken differed from the RENDERED token, so every
   legitimate REQUESTED→VERIFIED causal hit for lab sessions returned 403
   "invalid token". This is exactly the drift class FR-R6-050 exists to
   prevent; submit.ts already did it right, canary.ts did not. Fixed:
   canary.ts now loads recipe_json by session_id the same way submit.ts
   does. Found BY the new perception-chain integration test — the first
   test that ever exercised REQUEST→VERIFY on a lab-bound session.
   Before fix: lab-bound GET /c/<own-rendered-token> → 403. After: 204.
2. **ISSUED under-reporting** (E3): lab truth `canary_issued` counted only
   `profile.semantic` — DECOY_FIELD_ONLY and DECOY_ROUTE_ONLY sessions were
   reported as "nothing issued" despite the server rendering an fr_* field
   or a /c/<token> notice. Fixed: issued = semantic OR decoyField OR
   decoyRoute (interaction remains non-material).
3. **EXPOSED scan gaps** (E2): the runner's structural scan knew only
   data-fr-canary / data-fr-marker — the route notice (data-fr-route) and
   decoy fields (name="fr_<hex>") were invisible to it, so DECOY_*_ONLY
   exposure would have read false even when the artifacts contained the
   material. Fixed: CANARY_STRUCTURES covers all four signatures; scan is
   artifact-only and never overwritten by server truth (source-order
   contract asserted in tests).

## Evidence

| Proof | Command | Result |
|---|---|---|
| Structural scan per condition: semantic/marker/route/field → exposed; CONTROL + TURNSTILE_ONLY → not exposed; ablation isolation (field artifacts ≠ route/semantic structures and vice versa) | `npx vitest run tests/unit/perception-measurement.test.ts` | 11/11 PASS |
| ISSUED: DECOY_ROUTE_ONLY → true; CONTROL/INTERACTION_ONLY → false | `npm run test:integration` | PASS |
| REQUEST→VERIFY causal leg: rendered token → 204 → canary_verified_server=true; wrong token → 403, no hit; CONTROL route → 404; no cookie → 403 | `npm run test:integration` | PASS |
| Lab-bound /c/ reconstruction drift fixed (before: 403 with own token) | live worker probe (documented in tests) | 204 after fix |
| Full unit suite | `npx vitest run tests/unit` | 247/247 PASS |
| Integration suite | `npm run test:integration` | 31/31 PASS |
| E2E causal gate (zero /c/ hits from normal users) | `npm run test:e2e` | 12/12 PASS |
| A11y gate | `npm run test:a11y` | 18/18 PASS |
| Typecheck + lint | `npx tsc --noEmit && npx eslint …` | clean |

## EXPOSED vs REFERENCED discipline preserved

raw-http still proves exposure-without-reference: artifacts contain the
material (exposed=true) while canaryReferenced stays false — there is no
reasoning process. The generic "/c/" shape signal
(canary_generic_referenced) remains separate from exact-material reference
(FR-R6-055), and neither the runner nor any adapter lets a generic mention
set the exact metric.

## Hidden-marker semantics

S09/P06 (data-fr-marker) counts as EXPOSED when present in artifacts: it
is a probe of whether the agent's EXTRACTOR carries the marker, which is a
perception-architecture question (raw-html: yes; accessibility tree: no,
aria-hidden). Visibility differences are analyzed downstream by comparing
artifact content across extractor conditions; the boolean itself is
artifact-truthful.

## Status: PROVEN INTEGRATION (E3) for server states; PROVEN LOCAL (E2) for
harness-side scans. Browser-agent exposure (EXPOSED for raw-dom /
ax-snapshot on live sessions) is E4 and lands with the Phase 6 pilot.
