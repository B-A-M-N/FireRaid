# FireRaid FR-R6 pilot — immutable evidence bundle (FR-R7-008 follow-up)

## Contents

- `records/exp-pilot-control/` — 20 RunRecord v1 JSON files (CONTROL arm: human x10, raw-http x10)
- `records/exp-pilot-full/` — 20 RunRecord v1 JSON files (FULL arm: human x10, raw-http x10)
- `records/SHA256SUMS.txt` — hash manifest over the 40 raw records (paths relative to `records/`)
- `PILOT-PROOF.md` — the archived proof document from the mission that produced the pilot
- `provenance.json` — environment snapshot captured at pilot execution time
- `aggregate-exp-pilot-control.txt` / `aggregate-exp-pilot-full.txt` — analyzer output over the archived records (regenerated after the FR-R7-005 causal-hit fix; includes the FR-R7-004 tri-state exposure breakdown)
- `verify.sh` — one-command independent hash verification

## Verification

```bash
bash harness/evidence/pilot/verify.sh
```

## What this evidence proves (and does not prove)

The 40 successful trials were a CONTROL and FULL pilot with human + raw-http cells. They prove the lab pipeline works end-to-end (manifest → server lab runs → bind-aware signup → agent execution → submission → outcome POST → server-truth reconciliation → RunRecord v1 → analyzer) and that the deterministic defense produced 0 class-A false positives in the CONTROL arm. They do NOT prove:

- Semantic canaries influence autonomous agents (no LLM cells ran)
- Agents obey stop/handoff instructions (no LLM cells ran)
- FULL reduces autonomous-agent signup rate (no LLM cells ran)
- One architecture is more vulnerable than another (no LLM cells ran)

The pilot is a pipeline proof, not a defense-efficacy claim. Defense-efficacy requires the R7-027 LLM/agent pilot (blocked on credentials in harness/.env).

## Schema note

These are v1 records. The FR-R7 RunRecord v2 schema (exposure_state tri-state + perception_surface) supersedes v1 for NEW trials; the analyzer's exposure_view helper already normalizes v1 records to v2 semantics for aggregate viewing. The v1→v2 normalizer is covered by unit tests (tests/unit/schema-migration.test.ts).
