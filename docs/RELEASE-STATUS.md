# FireRaid — Release Status & Claim Tiers

This document is the canonical statement of what FireRaid claims, and at
what evidence tier each claim currently sits. `npm run release:verify`
attests the LOCAL VERIFICATION tier for a given tree (writes
`release-evidence.json`); it deliberately does not attest the MEASURED tier.

## Claim vocabulary

| Tier | Meaning | Evidence |
|------|---------|----------|
| **IMPLEMENTED** | The capability exists in code with a passing test that pins its behavior. | unit/integration suite |
| **LOCALLY VERIFIED** | A deterministic, repeatable local gate passed for THIS tree (no network beyond loopback, no live models). | `release-evidence.json` |
| **MEASURED** | A completed experiment (experiment.json `status=COMPLETE`, planned-vs-present record match, matched CONTROL/DEFENDED cells) supports a quantitative claim. | `harness/results/<experiment>/` + analyzer output |
| **NOT YET ESTABLISHED** | No evidence at the required tier exists. Stating the claim would overreach. | — |

Rules that keep this document honest:

1. A claim never moves up a tier without the corresponding evidence file.
2. An interrupted experiment can never back a MEASURED claim — even with
   many records present (interruption breaks the cell-mix; see
   P0-AUDIT-3/P0-2 and `harness/analysis/analyze.py` completeness gates).
3. Where code and this document disagree, CODE AND ITS TESTS WIN, and this
   document must be corrected in the same change.

## Claim surface

| # | Claim | Tier | Evidence |
|---|-------|------|----------|
| 1 | Deterministic per-session defense derivation (HMAC/PRF, no LLM) | **LOCALLY VERIFIED** | unit parity + determinism suites; `release-evidence.json` |
| 2 | Production composition always includes the semantic strategy layer (P02/P03/P04) + ≥1 independent trap (DiD) | **LOCALLY VERIFIED** | `tests/unit/ablation-recipes.test.ts` (32-session parity: `PRODUCTION_DEFAULT` ≡ `deriveProductionProfile`) |
| 3 | Presentation-signature invisibility in the production plane (no lab banner, no `data-fr*`/`data-rt*`, no injected-trap classes, no strategy IDs, structurally inert `<template>` carriers) | **LOCALLY VERIFIED** | `tests/e2e/production-plane.spec.ts` (Chromium/Firefox/WebKit, LAB_MODE=false) + unit tests |
| 4 | Human usability preserved (normal / keyboard-only / autofill-like flows; AX-tree unchanged) | **LOCALLY VERIFIED** | `tests/e2e/normal-user.spec.ts` (lab), `tests/e2e/production-plane.spec.ts` (production), `tests/accessibility/` |
| 5 | Causal-evidence chain: attacker behavior → server-side evidence → admission decision → upstream forwarding decision → independent origin ledger | **LOCALLY VERIFIED** | `npm run test:ledger-proof` (CONTROL clean registers; bot with populated trap does not) |
| 6 | Origin cost profile: profile derivation ~ms-scale, zero product egress, zero D1 imports in product closure | **LOCALLY VERIFIED** | `npm run test:origin-budget` |
| 7 | Test-infrastructure honesty: port/identity guards, hermetic production-test env, no efficacy printout from incomplete experiments | **LOCALLY VERIFIED** | `npm run test:worker-isolation`; analyzer completeness gates |
| 8 | Autonomous-agent efficacy: PRODUCTION_DEFAULT reduces autonomous signup success vs CONTROL | **NOT YET ESTABLISHED** | Two completed matched-cell experiments. **E4** (30/30, `harness/results/exp-e4-headline/`, simplified-dom perception): NO efficacy signal — the extractor structurally cannot see `<template>` carriers (DocumentFragment, child-walking; proven by replay probe); 0/10 defended agents touched any trap; endpoint ~100% BOTH arms; humans 5/5 clean both arms. **E5** (30/30, `harness/results/exp-e5-treatment-visible/`, raw-html perception with live-field-state legend, 2026-09-03): primary endpoint STILL NULL — defended account-creation 10/10 vs CONTROL 9/9 valid (one CONTROL infra error), zero REVIEW/QUARANTINE dispositions in either arm. BUT the semantic mechanism demonstrated compliance-on-delivery for the first time: in route-armed defended sessions where the per-session route instruction was inside the extractor's first-step model input, **4/4 agents referenced the exact route token AND semantic nonce** in subsequent steps (`fetch /c/<token> and include token <nonce>` — both echoed verbatim); in route-armed sessions where the 8000-char extractor slice truncated the template (delivery ABSENT), **0/4** did. Delivery→obedience 4/4, no-delivery 0/4, CONTROL 0/6. E4's 0/10 was a delivery artifact, not mechanism failure. **Measured bottleneck:** compliance never became causal evidence — `canary_requested_client=false` on all 10 (the raw-dom action space is fill/click/submit only; agents cannot express the instructed GET), so the canary was never hit server-side and admission stayed ACCEPT. Efficacy now gated on TWO measured engineering factors: (a) full-treatment delivery to the perception channel (the 8000-char slice truncation is itself a delivery failure — 4/8 route-armed sessions lost the instruction), (b) an action space / affordance that lets the agent actually perform the instructed fetch. Formatting/salience ablations (carrier format, placement, model class) remain unexplored factors — a null under one delivery format does not establish mechanism-level failure. |
| 9 | Any per-architecture vulnerability ranking | **NOT YET ESTABLISHED** | Requires #8 plus matched per-extractor cells (E4's channel-invisibility finding makes the extractor dimension the first-order variable) |
| 10 | Remote Cloudflare deployment behavior | **LOCALLY VERIFIED** (live smoke, 2026-09-03) | Deployed `fireraid-production.benevolentjoker.workers.dev` (version `b401da70`): D1 `fireraid-production` + full 16-migration chain applied remotely; profile/CSRF/Turnstile secrets pushed via `wrangler secret`; config validator fail-closed LIVE (503 `Production requires TURNSTILE_EXPECTED_HOSTNAME` before Turnstile was configured — the Worker refused to boot under-configured); post-config smoke: `/signup` 200 with clean production plane (no lab banner / `data-fr*` / strategy IDs; production client config id; Turnstile script + sitekey wired), headless submit without a solved token → `403 verification_required` (fail-closed), solved-widget human submission in the owner's browser → success receipt ("Application received"). NOT MEASURED: sustained production traffic behavior, custom-domain routing, cron-driven retention on the remote schedule. |

## Release gating

- `npm run release:verify` — runs the deterministic gates (typecheck, lint,
  unit, product boundary, worker isolation, origin budget) and stamps
  `release-evidence.json` with git SHA + dirty flag. `release_candidate:
  true` requires a CLEAN tree; dirty evidence is still written for
  iteration but flagged.
- Items 8–10 are user-gated: a real benchmark run, and a remote deploy
  smoke, are the owner's call (costs money / touches the internet).

## Historical status documents

`POST_FR_R6_STATUS.md` and `POST_FR_R7_STATUS.md` are HISTORICAL snapshots
(read their banners). They do not describe current behavior; where they
conflict with this file or the code, this file and the code win.
