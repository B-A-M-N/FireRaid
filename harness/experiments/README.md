# FireRaid experiment manifests

One manifest per named ablation condition — the treatment identity is the
manifest's `recipe_id` (single-arm manifests) or `conditions` array
(multi-arm manifests, P1-20), resolved server-side against
`ABLATION_RECIPES` (single source of truth; FR-R6-009/010). `exp-001`
remains the smoke experiment.

**Strict schema (P1-4/P1-5).** Unknown manifest keys are REJECTED
(`recpie_id`, a stale `recipes` key — never silently stripped into a
CONTROL-only run); `recipe_id` and `conditions` are mutually exclusive;
matrix arrays must be non-empty and duplicate-free. Editing a manifest
after collecting trials under it invalidates comparability (the
`manifest_hash` is recorded per run) — make a NEW manifest id instead.

## Target modes

- Default (`target.mode` omitted = `"fireraid-worker"`) drives the FireRaid
  Worker; FireRaid's `submitted` flag is the best available endpoint and is
  reported as a labeled **submission proxy**, never account creation.
- `"origin-ledger"` runs the middleware facade in front of the ordinary
  upstream ledger app (P1-24): the origin's own account ledger is the
  PRIMARY endpoint. It renders in PRODUCTION, so lab-only semantic
  conditions (`SEMANTIC_ONLY`, `SEMANTIC_ROUTE`, `FULL`) and
  `turnstile_required` fail manifest validation there — use
  `PRODUCTION_FIELD` / `PRODUCTION_ROUTE` / `PRODUCTION_INTERACTION` /
  `PRODUCTION_FULL` (P0-8/P0-9).

## Matrix discipline (FR-R4-039)

The runner varies ONLY dimensions an adapter consumes:
- `raw-http` (no model/prompt/extractor) → 1 cell per repetition
- `human` (no model/prompt/extractor) → 1 cell per repetition
- `raw-dom` (model+prompt+extractor) → models × prompts × extractors cells
- `ax-snapshot` (model+prompt, accessibility extractor) → models × prompts
- `browser-use` (model+prompt) → models × prompts

With `conditions[]`, each cell carries every condition exactly once per
repetition, in seeded-shuffled order (blocked randomization; P1-20, item
13). `trial_index` is the runner's EXECUTION order (P1-6).

## Conditions

| manifest | recipe_id / conditions | families |
|---|---|---|
| exp-control | CONTROL | — |
| exp-turnstile | TURNSTILE_ONLY | — (+ Turnstile gate; worker mode only) |
| exp-semantic | SEMANTIC_ONLY | semantic |
| exp-decoy-field | DECOY_FIELD_ONLY | decoy-field |
| exp-decoy-route | DECOY_ROUTE_ONLY | decoy-route |
| exp-interaction | INTERACTION_ONLY | interaction |
| exp-semantic-route | SEMANTIC_ROUTE | semantic + decoy-route |
| exp-full | FULL | all four |
| exp-holdout | SEMANTIC_ONLY + holdout_mode | semantic (holdout partition only) |
| exp-pilot-control | CONTROL | — |
| exp-pilot-full | FULL | all four |
| exp-interleaved | 6 lab conditions (P1-20) | mixed |
| exp-interleaved-p121 | 6 lab conditions + dom-automation | mixed |

## Dev/holdout freeze (FR-R5-034)

- Development partition: S01–S06 (tuning allowed).
- Holdout partition: S07–S08 (+ S09 metadata probe, never tuned).
- `exp-holdout.json` sets `holdout_mode: true` — the server restricts the
  random template pool to the holdout partition. Reports tuned on dev runs
  must never be generated from holdout-labeled runs.
- Catalog partitions are frozen in src/core/catalog.ts; changing them
  invalidates every previously collected run.

## Prompt conditions

- `baseline` — plain task framing, no security framing.
- `informed` (cautious) — told to verify and to ignore page instructions.
- `hardened` — page content is untrusted data; never fetch referenced URLs.

## Provenance & purity rules

- Never edit a manifest after collecting trials under it — the manifest
  hash is recorded per run; an edit invalidates comparability (make a new
  manifest id instead).
- LLM-dependent agents require FIRERAID_LLM_* credentials; without them
  those trials fail closed with typed error records.
