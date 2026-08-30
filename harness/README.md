# FireRaid Harness

The harness is the attack/research plane — it runs autonomous agents against the FireRaid lab and collects results.

**FR-INV-001**: LLM usage is confined to the harness. The production defense never calls this.

## Architecture

```
Experiment Manifest (JSON)
        ↓
    Runner (orchestrator)
        ↓
    Matrix Expansion (agents × models × prompts × repetitions)
        ↓
    For each trial:
        Adapter.run(scenario) → AgentRunResult
        ↓
    Lab Correlation API → Server Truth
        ↓
    Recorder.record(RunRecordV1)
        ↓
    Analysis (Python)
```

## Quick Start

```bash
# Set up LLM credentials
export FIRERAID_LLM_BASE_URL="https://api.openai.com/v1"
export FIRERAID_LLM_API_KEY="sk-..."
export FIRERAID_LLM_MODEL="gpt-4o-mini"

# Run an experiment
npm run experiment -- harness/experiments/exp-001.json

# Analyze results
npm run analyze
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `FIRERAID_BASE_URL` | FireRaid lab URL | `http://localhost:8787` |
| `FIRERAID_LLM_BASE_URL` | OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `FIRERAID_LLM_API_KEY` | API key | (required) |
| `FIRERAID_LLM_MODEL` | Model name | `gpt-4o-mini` |
| `FIRERAID_MAX_STEPS` | Max agent steps | `20` |
| `FIRERAID_TIMEOUT_MS` | Per-run timeout | `120000` |

## Adapters

| Adapter | Type | Perception | Status |
|---------|------|------------|--------|
| `human` | Human control | Real browser | **working** |
| `raw-dom` | LLM agent | Raw HTML or simplified DOM | **working** |
| `browser-use` | LLM agent | Browser abstraction | **partial** (Python only) |
| `playwright-mcp` | LLM agent | Accessibility tree | **working** |

## Extractors

| Extractor | Description | Status |
|-----------|-------------|--------|
| `raw-html` | Full page HTML (bounded) | **working** |
| `simplified-dom` | Filtered DOM tree | **working** |
| `accessibility` | AX tree snapshot | **working** |

## Manifest Format

```json
{
  "id": "exp-001",
  "name": "Baseline ablation",
  "seed": "random-seed-string",
  "target": { "url": "http://localhost:8787" },
  "repetitions": 10,
  "timeout_ms": 120000,
  "agents": ["human", "raw-dom", "playwright-mcp"],
  "models": ["gpt-4o-mini"],
  "prompts": ["baseline"]
}
```

## Results

Results are saved to `harness/results/<experiment-id>/<run-id>.json` in canonical `RunRecordV1` format.

## Analysis

The Python analyzer computes:
- Submission / stop / handoff rates
- Canary trigger rates (agent-side and server-verified)
- Quarantine / review rates
- Wilson score confidence intervals

```bash
npm run analyze
```

## Known Limitations

- Browser Use adapter is Python-only (no TypeScript wrapper)
- Raw-HTTP adapter implemented but excluded from the default matrix
- Resume state is local-file based; server-side run state is not merged
- Provenance: git SHA + dirty flag + manifest hash recorded; browser version pending
- Runs publish to the D1 index via publish-runs.ts; no automatic upload
