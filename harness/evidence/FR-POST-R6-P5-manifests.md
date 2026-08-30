# FR-POST-R6-P5 — Experiment manifest suite proof

## Claim

The full ablation matrix is expressed as validated, immutable manifests:
8 named conditions (+ holdout + 2 pilot manifests), prompt conditions
(baseline / cautious "informed" / hardened), dev-vs-holdout frozen via a
server-enforced holdout_mode, and NO manifest varies a dimension an agent
does not consume.

## holdout_mode wired end-to-end (new plumbing, server-enforced)

The manifest schema already declared `holdout_mode` (FR-R6) but it reached
NOWHERE — declared dead. Now:

- migration 0009: `lab_runs.holdout_mode` column
- lab API: accepts + persists + returns `holdout_mode` (both pending and
  terminal payloads)
- signup (issuance): passes the bound run's flag into deriveProfile
- submit / canary / lab-truth reconstruction: pass the persisted flag into
  the canonical reconstruction — holdoutMode changes the random template
  pool (FR-R5-034), so reconstruction without it would drift the draw (the
  same drift class the Phase 4 canary fix addressed; prevented by design
  here)
- runner: transmits manifest.holdout_mode to the lab API per run

Integration proof: 4/4 holdout-labeled SEMANTIC_ONLY runs drew S07/S08
only (never S01–S06), the recorded truth reconstructed the SAME template
the render issued, and holdout_mode=1 round-trips. Non-holdout draws
remain unrestricted.

## Model-id resolution (no fabricated provenance)

Manifest model entries may be the sentinel "FIRERAID_LLM_MODEL" — resolved
from env at trial start, resolved once per process, and the RESOLVED id is
what every RunRecord records. Unset env + sentinel → hard error, never a
fabricated model string.

## Validator contract fix

Manifest extractor lists are shared across agents (the format has no
per-agent extractor dimension). The old validator rejected any agent that
didn't support EVERY listed extractor, making raw-dom+ax-snapshot
manifests unexpressible. New contract matches expandManifest's actual
behavior: each extractor-consuming agent needs a NON-EMPTY intersection
with its supported list; zero intersection fails validation.

## Evidence

| Proof | Command | Result |
|---|---|---|
| 12 manifests validate (8 ablations + holdout + 2 pilots + smoke), fixtures exist, extractor intersections non-empty, recipe_ids canonical | `npx vitest run tests/unit/manifests.test.ts` | 50/50 PASS |
| holdout_mode round-trip: issued template ∈ {S07,S08} ×4, recorded == rendered, flag persisted | `npm run test:integration` | 32/32 PASS |
| Full unit suite (incl. 291 tests after validator contract change) | `npx vitest run tests/unit` | 291/291 PASS |
| Typecheck + lint | `npx tsc --noEmit && npx eslint …` | clean |

## Manifest inventory (harness/experiments/)

exp-control, exp-turnstile, exp-semantic, exp-decoy-field,
exp-decoy-route, exp-interaction, exp-semantic-route, exp-full,
exp-holdout (SEMANTIC_ONLY + holdout_mode), exp-pilot-control +
exp-pilot-full (human + raw-http + raw-dom, baseline prompt),
exp-001 (legacy smoke). README.md documents matrix discipline and the
immutability rule (never edit a collected manifest; new id instead).

## Status: PROVEN LOCAL (E2) for schema/validator; PROVEN INTEGRATION (E3)
for holdout_mode round-trip. NOT EXPERIMENTALLY VALIDATED — that is the
Phase 6 pilot's product.
