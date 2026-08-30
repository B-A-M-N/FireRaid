# FR-POST-R6-P3 — Treatment assignment pipeline proof

## Claim

For every named ablation recipe, REQUESTED == STORED == RENDERED ==
RECONSTRUCTED == RECORDED. Recipe identity round-trips from the lab API
through bind, render, submission, and canonical profile reconstruction
without drift; unknown recipes are rejected (no silent fallback); a
required-but-unconfigured Turnstile condition fails CLOSED (FR-R6-020).

## Renderer change (required to make the claim true)

`renderRouteNotice` (src/core/renderer.ts) — FR-POST-R6-P3. Before this
change a session's decoy-route token existed server-side
(profile.decoyRoute, /c/ handler live) but rendered NOWHERE unless the
semantic template body happened to name the endpoint. Consequences:

- DECOY_ROUTE_ONLY could never be REQUESTED by any agent → null condition.
- SEMANTIC_ROUTE sessions that drew a template which does not name the
  endpoint (S01–S03/S07/S09) were silent too.
- renderSignupPage now mounts a standalone `data-fr-route` notice EXACTLY
  once, only when the rendered page does not already contain
  "/c/<endpointToken>" (single-source guarantee; no double render).

Isolation preserved: DECOY_FIELD_ONLY still renders no route (no
decoyRoute → notice returns ""). The notice is NOT a hyperlink and NOT
focusable — the e2e causal gate ("normal user makes zero /c/ requests")
still passes.

## FR-R3-024 template-required families (test semantics)

Random template draws can ADD required families beyond the recipe base
list (S06 → decoy-field; S04/S05/S08 → decoy-route). This is engine
policy, not drift. The pipeline assertions are therefore template-aware:
every requested family must be present; only FR-R3-024-required extras are
allowed. Verified stable across 5 consecutive suite runs (independent
random draws each run).

## Evidence

| Proof | Command | Result |
|---|---|---|
| All 8 named recipes + pinned S01/P01 + S09/P06 + TURNSTILE fail-closed + TURNSTILE-unrequired | `npm run test:integration` | 27/27 PASS (12 pipeline tests) |
| Pipeline stability across independent random template draws | suite run ×5 | 27/27 PASS ×5 |
| Renderer unit suite (S06 modes, profile-recipe) | `npx vitest run tests/unit` | 236/236 PASS |
| E2E causal gate: normal user makes ZERO /c/ requests with route notice live | `npm run test:e2e` | 12/12 PASS |
| A11y gate (route notice introduces no AX/keyboard hazards) | `npm run test:a11y` | 18/18 PASS |
| Typecheck + lint | `npx tsc --noEmit && npx eslint …` | clean |
| Live-worker bind page probe (DECOY_ROUTE_ONLY) | curl bind URL | `data-fr-route` + `/c/6f25ec83ead4` present |

## Coverage of the named conditions

CONTROL, TURNSTILE_ONLY (both turnstile_required variants), SEMANTIC_ONLY,
DECOY_FIELD_ONLY, DECOY_ROUTE_ONLY, INTERACTION_ONLY, SEMANTIC_ROUTE, FULL
+ pinned S01/P01 (visible) and S09/P06 (hidden metadata marker).

## Status: PROVEN INTEGRATION (E3 — real Worker + real D1, HTTP boundary)

NOT yet proven E4 (real browser agent consuming the rendered conditions) —
that is Phase 6 (pilot). Server-side pipeline integrity, the prerequisite
for model trials, is proven.
