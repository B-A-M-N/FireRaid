# Baseline Gates — FR-R6 Commit

## Environment

| Item | Value |
|---|---|
| Git SHA | `595c0871d629e64881a5f2618f4d3293a30b61de` |
| Git dirty | false |
| Node | v22.22.3 |
| npm | 10.9.8 |
| Wrangler | 4.127.1 |
| Playwright | 1.62.1 |
| Python | 3.11.15 |
| browser-use (python lib) | **NOT INSTALLED** |
| OS | Linux 7.0.11-76070011-generic |
| Captured | 2026-08-30T06:00:27Z |

## Gate Results (run sequentially — e2e and a11y never concurrent)

| Gate | Command | Result | Evidence |
|---|---|---|---|
| TypeScript | `npm run typecheck` | **PASS** (exit 0, 0 errors) | `typecheck.txt` |
| ESLint | `npm run lint` | **PASS** (exit 0, 0 problems) | `lint.txt` |
| Unit | `npm run test:unit` | **PASS** — 220/220 (15 files) | `unit.txt` |
| Integration | `npm run test:integration` | **PASS** — 15/15 (2 files) | `integration.txt` |
| E2E | `npm run test:e2e` | **PASS** — 12/12 | `e2e.txt` |
| Accessibility | `npm run test:a11y` | **PASS** — 17 passed + 1 designed conditional skip, exit 0 | `a11y.txt` |

## Notes

- The a11y "skip" is the random-profile smoke test's designed conditional skip
  (`test.skip(true, "no semantic canary in this random session")` — the random
  profile drew no semantic family this run). The deterministic pinned tests
  (S01/P01 visible-in-AX, S09/P06 excluded-from-AX) all PASSED.
- First a11y invocation hit a leftover workerd from the e2e run's webServer
  (port 9999 not released when `timeout` killed playwright). This is an
  invocation-ordering hazard, not a FireRaid defect: kill stragglers between
  serial gate runs. Recorded as a known operational caveat.
- External prerequisites probed: no LLM API credentials configured
  (`FIRERAID_LLM_*` unset), `browser-use` python package not installed. These
  gate Phases 2/6 (Browser Use integration and the LLM pilot) until provided.

## Verdict

**BASELINE GREEN — proceed to Phase 1 (raw-http integration).**
