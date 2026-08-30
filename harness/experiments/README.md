# FireRaid experiment manifests (FR-POST-R6 Phase 5)

One manifest per named ablation condition — the treatment identity is the
manifest's `recipe_id`, resolved server-side against `ABLATION_RECIPES`
(single source of truth; FR-R6-009/010). `exp-001` remains the smoke
experiment.

## Matrix discipline (FR-R4-039)

The runner varies ONLY dimensions an adapter consumes:
- `raw-http` (no model/prompt/extractor) → 1 cell per repetition
- `human` (no model/prompt/extractor) → 1 cell per repetition
- `raw-dom` (model+prompt+extractor) → models × prompts × extractors cells
- `ax-snapshot` (model+prompt, accessibility extractor) → models × prompts
- `browser-use` (model+prompt) → models × prompts

## Conditions

| manifest | recipe_id | families |
|---|---|---|
| exp-control | CONTROL | — |
| exp-turnstile | TURNSTILE_ONLY | — (+ Turnstile gate) |
| exp-semantic | SEMANTIC_ONLY | semantic |
| exp-decoy-field | DECOY_FIELD_ONLY | decoy-field |
| exp-decoy-route | DECOY_ROUTE_ONLY | decoy-route |
| exp-interaction | INTERACTION_ONLY | interaction |
| exp-semantic-route | SEMANTIC_ROUTE | semantic + decoy-route |
| exp-full | FULL | all four |
| exp-holdout | SEMANTIC_ONLY + holdout_mode | semantic (holdout partition only) |
| exp-pilot | CONTROL + FULL (pilot mix) | — |

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
- `exp-pilot.json` is the Phase 6 pilot: human + raw-http + raw-dom on
  CONTROL vs FULL. LLM-dependent agents require FIRERAID_LLM_* credentials;
  without them those trials fail closed with typed error records.
