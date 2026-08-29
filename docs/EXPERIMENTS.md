# FireRaid — Experiments

## Experiment Manifest Format

```json
{
  "id": "exp-001",
  "target": { "url": "http://localhost:8787/signup" },
  "agents": ["human-control", "raw-dom"],
  "models": ["model-a"],
  "prompts": ["baseline"],
  "extractors": ["simplified-dom"],
  "profile_version": 1,
  "repetitions": 20,
  "timeout_ms": 120000,
  "fixture": "applicant-001",
  "seed": "experiment-seed-001"
}
```

## Recommended Experiment Sequence

| ID | Description |
|----|-------------|
| E0 | Control only (no defense) |
| E1 | Semantic canary only |
| E2 | Decoy field/route only |
| E3 | Telemetry only |
| E4 | Semantic + decoy |
| E5 | Full FireRaid |
| E6 | Full FireRaid + Turnstile |
| E7 | Hardened-agent condition |
| E8 | Holdout catalog |

## Running

```bash
npm run experiment -- --agent raw-dom --model model-a --runs 100
npm run analyze -- exp-001
npm run analyze -- exp-001 --csv results.csv
```

## Metrics

- Submission rate (with 95% Wilson CI)
- Stop rate
- Handoff rate
- Canary trigger rate
- Quarantine rate
- Review rate
- Median elapsed time
- Error rate

## Reproducibility

- Experiment seed controls run ordering and fixture selection
- Defense secret controls session-specific composition
- Never reuse experiment seed as production secret
- Profile versions are immutable once experiments are collected
