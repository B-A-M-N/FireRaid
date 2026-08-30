# FR-POST-R6-P6/P7 — Pilot execution + analyzer validation proof

## Claim (P6)

A real end-to-end pilot ran through the FULL authoritative pipeline —
manifest → server lab runs (bearer auth) → bind-aware signup → agent
execution → submission → outcome POST → server-truth reconciliation →
RunRecordV1 → analyzer — with the mission's hard invariants at 100%.

## Claim (P7)

The analyzer produces correct rates with Wilson CIs, correct denominator
classes, and correct breakdowns on the pilot data.

## Pilot shape

- exp-pilot-control: CONTROL × (human ×10, raw-http ×10) = 20 trials
- exp-pilot-full:     FULL     × (human ×10, raw-http ×10) = 20 trials
- raw-dom cells exist in the manifests but require FIRERAID_LLM_MODEL /
  FIRERAID_LLM_BASE_URL / FIRERAID_LLM_API_KEY (unset here) — those trials
  failed CLOSED with the typed provenance error (no fabricated model ids,
  no fabricated runs). LLM-dependent trials are E4-blocked, documented in
  Phase 8/unproven below.
- Worker: local Cloudflare Worker + D1 (scripts/test-worker.mjs, suite
  test-pilot, port 8787), fresh DB, LAB_MODE with bearer-auth lab API.

## Hard acceptance (mission Phase 6) — ALL PASS on 40/40

| Invariant | Result |
|---|---|
| 100% valid records (schema_version 1) | 40/40 |
| 100% server_reconciled | 40/40 |
| 0 unknown/pending profile ids | 40/40 |
| 0 missing recipe ids (CONTROL/FULL recorded from server truth) | 40/40 |
| 0 malformed records | 40/40 |
| 0 dirty-repo runs (fireraid_dirty=false; committed tree d825434) | 40/40 |
| Class-A control false positives (causal canary hits) | **0** |
| CONTROL: all submitted, 0 quarantine, 0 review | 20/20 |
| FULL: all submitted, canary_issued=true ×20 | 20/20 |

Integrity: harness/results/{exp-pilot-control,exp-pilot-full}/SHA256SUMS.txt
(40 records) verifies clean.

## Bugs the pilot found (fixed + committed before the clean runs)

1. resolveModelId threw for model-AGNOSTIC agents (human/raw-http never
   consume models — FR-R4-039). Sentinel now resolves to "none" there;
   remains a hard error for model-consuming agents.
2. writeResumeState ENOENT when every trial failed pre-record.
3. fetchServerTruth dropped the run row's recipe_id — records carried
   null, breaking the analyzer's FR-R5-049 recipe-based grouping.

## Analyzer validation (P7)

- resume.json is bookkeeping, not a run record — load_runs previously
  ingested it, creating a phantom NO_RECIPE group (n=21 "runs" for 20
  trials). Fixed: record filter on schema_version.
- CONTROL report: submission 100% CI [83.9, 100], quarantine 0% CI
  [0, 16.1], human false-positive analysis 0 causal hits, cross-sections
  by agent (human 10/10, raw-http 10/10).
- FULL report: exposure 50% [29.9, 70.1] — correct and interpretable:
  raw-http emits transport-byte perception artifacts (10/10 exposed),
  human emits none (0/10). Exposure is artifact-truthful per agent, not
  smeared. Request/reference/verified 0% — correct: neither agent type
  reasons about or fetches /c/.
- Breakdowns exercised: recipe groups, agent, model, template (S01–S09
  all drawn and grouped), placement, denominators split
  operational/effectiveness.

## Status

- Non-LLM pilot pipeline: EXPERIMENTALLY VALIDATED (E4 — real browser
  agents against a real Worker+D1 through the full lab loop).
- LLM-dependent cells (raw-dom, ax-snapshot, browser-use happy path):
  BLOCKED on external credentials (FIRERAID_LLM_*) and, for browser-use,
  `pip install browser-use openai`. Adapter error paths proven E2;
  runner degrades to typed error records, never fabricated submissions.
