# FR-POST-R6-P1 — raw-http adapter integration proof

## Claim

`raw-http` is a real, runner-loadable AgentAdapter: registered in
ADAPTER_CAPABILITIES, instantiated by the runner factory, honoring the lab
bind URL and per-trial fixture, keeping transport exposure strictly separate
from (never-claimable) semantic reference.

## Status: PROVEN LOCAL (E2 — unit; E4 pending first lab-mode pilot run)

## Changes

- `harness/core/run-schema.ts`: `raw-http` → `implemented: true`, version 0.1.0
- `harness/core/runner.ts`: `case "raw-http": return new RawHttpAdapter()`
- `harness/adapters/raw-http.ts`: captures signup GET status + bounded
  transport bytes, emits them as a step-1 raw-html perception artifact
  (SHA-256 hashed) so the runner's EXPOSED computation (artifact scan) works
  uniformly; wire transcript `[GET /signup]`/`[POST /api/submit]`/disposition
- `tests/unit/raw-http-adapter.test.ts`: 9 tests

## Evidence

| Proof | Command | Result |
|---|---|---|
| Registry + manifest validation | `npx vitest run tests/unit/raw-http-adapter.test.ts` | 9/9 PASS |
| Full unit suite | `npx vitest run tests/unit` | 229/229 PASS |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |

Test highlights (real HTTP against a node:http fixture server):

- submits minimum protocol with the **per-trial fixture** values
  (asserted on the received POST body) and replays the extracted CSRF token
- **bind URL honored**: `?lab_run=&bind=` reach the server when labRun
  context is present
- **exposure ≠ reference**: canary bytes in transport → exposure observable
  via perception artifact; `canaryReferenced`/`canaryGenericReferenced`/
  `canaryTriggered` are all never claimed (no LLM exists in this agent)
- **negative exposure control**: canary-free page → no exposure
- non-2xx submit → `outcome: "error"` with the wire status preserved
- transport failure → error outcome; **never fabricates "submitted"**

## Limitations

- Submission truth in these tests comes from the fixture server; the
  server-reconciliation path (E4) is exercised for the first time in the
  Phase 6 pilot against a real Worker.
