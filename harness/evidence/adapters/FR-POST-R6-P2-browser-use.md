# FR-POST-R6-P2 — Browser Use thin-backend integration proof

## Claim

Browser Use is a thin execution worker behind the canonical TS adapter:
Python owns nothing authoritative (no run IDs, no result files, no
submission/profile/disposition truth); the complete Scenario passes to the
worker over stdin; ambiguous completion never defaults to "submitted"; the
runner's server reconciliation stays the sole submission authority.

## Status: IMPLEMENTED / PROVEN LOCAL (E2) — E2E blocked on external prerequisites

## Changes

- `harness/adapters/browser-use.py` — full rewrite as a thin worker:
  reads one Scenario JSON on stdin, emits ONE `__FIRERAID_RESULT__{...}`
  line on stdout. No uuid run ids, no experiment ids, no result-file
  writes, no disposition state. Conservative outcome classification
  (only an observed successful completion yields "submitted"; ambiguous →
  "stopped"; reconciliation decides truth). No dependency → clean
  `DEPENDENCY_MISSING` error result, never a crash.
- `harness/adapters/browser-use-adapter.ts` — full rewrite:
  spawns the worker, passes the COMPLETE scenario (entryUrl incl. bind
  params, labRun, fixture, model, promptVariant, modelConfig, timeout,
  maxSteps) as stdin JSON; parses the LAST result line; wall-clock budget =
  scenario timeout + 30s; failure modes map to typed error codes
  (BROWSER_USE_NO_RESULT / _MALFORMED_RESULT / _WORKER_TIMEOUT /
  _SPAWN_FAILED); defense-in-depth coercion — anything outside the
  outcome allowlist becomes "error", never "submitted".
- `harness/core/run-schema.ts` — browser-use: implemented:true, 0.1.0
- `harness/core/runner.ts` — `case "browser-use": return new BrowserUseAdapter()`
- `tests/unit/browser-use-adapter.test.ts` — 7 tests

## Evidence

| Proof | Command | Result |
|---|---|---|
| Real worker, no-dependency path emits clean error result | `python3 harness/adapters/browser-use.py <<< scenario` | `DEPENDENCY_MISSING`, exit 0 |
| Empty-stdin path | `echo -n \| python3 …/browser-use.py` | `EMPTY_SCENARIO`, exit 0 |
| Registry + manifest validation + authority boundaries (no uuid/results/experiment_id in worker) | `npx vitest run tests/unit/browser-use-adapter.test.ts` | 7/7 PASS |
| Full unit suite | `npx vitest run tests/unit` | **236/236 PASS** |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | 0 problems |

## UNPROVEN (blocked on external prerequisites)

- An actual browser-driven trial (E4): requires
  `pip install browser-use openai` (absent in this environment) and
  `FIRERAID_LLM_*` credentials (unset). The worker's dependency-missing path
  is proven; the happy path executes only in the Phase 6 pilot once
  dependencies + credentials exist. The runner degrades safely: a
  browser-use trial in that state yields a typed error RunRecord, which the
  analyzer counts as adapter error — never as submitted.
