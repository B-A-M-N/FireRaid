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
| `ax-snapshot` | LLM agent | ARIA snapshot | **working** (renamed from `playwright-mcp` — ariaSnapshot+LLM, not the official Playwright MCP server; FR-R6-066) |
| `browser-use` | LLM agent | Browser abstraction | **integrated** (`implemented: true`; TS wrapper `harness/adapters/browser-use-adapter.ts` drives the Python worker `harness/adapters/browser-use.py` — requires the `browser-use` Python package at runtime) |
| `raw-http` | Scripted baseline | HTTP only | **integrated** (`implemented: true`; `harness/adapters/raw-http.ts` — scripted minimum-protocol baseline, no model/prompt) |

Readiness is enforced by `ADAPTER_CAPABILITIES` (`harness/core/run-schema.ts`):
`validateManifest` rejects any manifest whose agents are not `implemented: true`,
and extractor compatibility is checked per agent (FR-R4-034). All five adapters
listed above are currently `implemented: true`. Note that integration is a code
claim, not an efficacy claim: `browser-use` and `raw-http` are wired in and
runnable, but their defense-evasion efficacy is unproven until real trials are
run against the lab.

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
  "agents": ["human", "raw-dom", "ax-snapshot"],
  "models": ["gpt-4o-mini"],
  "prompts": ["baseline"]
}
```

## Results

Results are saved to `harness/results/<experiment-id>/<run-id>.json` as canonical **RunRecord v2** (tri-state exposure + perception surface + LLM provenance). Archived v1 evidence loads through the v1→v2 normalizer at analysis time.

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

- Browser-use adapter is integrated (`harness/adapters/browser-use-adapter.ts` owns
  authoritative state and drives the `harness/adapters/browser-use.py` Python worker),
  but requires the `browser-use` Python package at runtime; its efficacy is unproven
  until real trials run
- Raw-HTTP adapter (`harness/adapters/raw-http.ts`) is integrated as a scripted
  baseline; its efficacy is likewise unproven until real trials run
- Resume state is local-file based; server-side run state is not merged
- Provenance: git SHA + dirty flag + manifest hash recorded; browser version pending
- Runs publish to the D1 index via publish-runs.ts; no automatic upload
