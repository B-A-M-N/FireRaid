# FireRaid — Experiments

## Experiment Manifest Format

```json
{
  "id": "exp-001",
  "name": "FireRaid smoke experiment",
  "seed": "experiment-seed-001",
  "target": {
    "url": "http://localhost:8787",
    "mode": "origin-ledger"
  },
  "agents": ["human", "raw-dom"],
  "models": ["model-a"],
  "prompts": ["baseline"],
  "extractors": ["simplified-dom"],
  "conditions": ["CONTROL", "PRODUCTION_FULL"],
  "profile_version": 1,
  "repetitions": 20,
  "timeout_ms": 120000,
  "fixture": "applicant-001"
}
```

Agent architecture names (harness agent taxonomy): `human`, `raw-dom`,
`browser-use`, `ax-snapshot`, `raw-http`, `dom-automation`,
`fill-everything`, `humanized-pw`, `vision-only`, `fireraid-aware`.

- `target.mode: "origin-ledger"` runs the middleware facade + an ordinary
  upstream (the honest primary endpoint: the upstream's own account ledger
  is the truth for "was the account created"). FireRaid-worker mode is the
  legacy target.
- `conditions[]` names treatment conditions per trial (P1-20); conditions are
  blocked-randomized inside each repetition block so CONTROL and defended
  arms run contemporaneously. The key is `conditions` — a manifest written
  with `recipes` (or any other key) is REJECTED by the strict schema, never
  silently stripped into a CONTROL-only run.
- **Production-faithful origin experiments** may name only production
  conditions: `CONTROL`, `PRODUCTION_FIELD`, `PRODUCTION_ROUTE`,
  `PRODUCTION_INTERACTION`, `PRODUCTION_FULL`. The lab semantic arms
  (`SEMANTIC_ONLY`, `SEMANTIC_ROUTE`, `FULL`) are lab-plane mechanisms —
  the origin runtime renders in production mode, so those conditions fail
  manifest validation with an explicit error (running them anyway would
  score a profile-derivation infrastructure failure as a "successful
  defense"). Semantic experiments belong in a separate worker/lab manifest
  (`target.mode: "fireraid-worker"`, lab deployment). `turnstile_required`
  is likewise untestable in origin-ledger mode (no real verification
  provider there) and is rejected.
- Model-backed agents (`vision-only`, `fireraid-aware`, LLM-driven
  `raw-dom`) need `FIRERAID_LLM_BASE_URL` / `FIRERAID_LLM_API_KEY` in
  `harness/.env`; they fail closed (`llm_not_configured`), never silently
  skip. `browser-use` needs python3 + `pip install browser-use openai` —
  the runner prefights this before spending any trial.

## Recommended Experiment Sequence

| ID | Description |
|----|-------------|
| E0 | Control only (no defense) |
| E1 | Semantic canary only (lab) |
| E2 | Decoy field/route only |
| E3 | Interaction telemetry only |
| E4 | Decoy field + route + interaction (production thesis, P1-23) |
| E5 | Full lab stack (all four families) |
| E6 | Full + Turnstile required |
| E7 | Hardened-agent condition |
| E8 | Holdout catalog (S09 partition) |

## Running

```bash
npm run experiment -- harness/experiments/exp-001.json   # run a manifest
npm run analyze -- exp-001                               # rates + group deltas
npm run analyze -- exp-001 --endpoints                   # primary endpoint:
                                                         #   account-creation rate,
                                                         #   ARR/RRR, FP upper bound
```

## Metrics

Operational (denominator: all attempted runs):

- Error rate, timeout rate, unreconciled rate
- Failure taxonomy (agent / provider / harness / fireraid-infra / origin-infra)

Effectiveness (denominator: valid runs — server-reconciled with a terminal
success outcome; the definitions in `src/analytics/run-metrics.ts` are the
canonical ones and `analyze.py` mirrors them):

- Submission rate (server truth, with 95% Wilson CI)
- Stop / handoff rate
- Quarantine / review rate
- Canary issued / verified / referenced rates
- Exposure coverage vs measured exposure rate (two-level denominator)
- ITT submission rate + origin account-creation rate (assignment-based
  denominator; infrastructure failures excluded, agent failures kept)
- Median elapsed time

The primary endpoint for defense efficacy is the origin account-creation
rate (or, when no origin truth exists, the reconciled submission rate as a
labeled proxy) — never the agent's own outcome string.

## Reproducibility

- Experiment seed controls blocked-randomized condition ordering and
  fixture selection
- Defense secret controls session-specific composition
- Never reuse experiment seed as production secret
- Profile versions are immutable once experiments are collected
- `manifest_hash` (canonical key-sorted SHA-256) identifies manifest
  content in every run record
