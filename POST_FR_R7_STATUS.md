# FireRaid — Post-FR-R7 Execution Status

**Date:** 2026-08-30 · **HEAD:** see `git rev-parse HEAD`
**Baseline checkpoint:** `9c6c8b4` (POST_FR_R6_STATUS.md) → this document covers the FR-R7 audit response.

## Honest accounting of what changed and what didn't

The audit found that the POST_FR_R6 report overstated what the 40-trial pilot
proved. FR-R7 separates the corrected claims from the still-open work.

### Tested code vs report commit

- **tested_code_sha**: `eb545d9` (the post-R6 code, unchanged by this round)
- **evidence/report_commit**: see `git rev-parse HEAD` — only the audit
  response, status docs, and one new migration were added.

### What the FR-R6 40-trial pilot actually proved

The 40 successful trials were a CONTROL (10 human + 10 raw-http) and FULL
(10 human + 10 raw-http) pilot. They prove:

| Class | Proven? |
|-------|---------|
| Typecheck / lint / unit health | yes |
| Unit suite (291/291 re-run) | yes |
| Archived integration 32/32 | credible — tested SHA |
| Archived E2E 12/12 | credible — tested SHA |
| Archived a11y 18/18 | credible — tested SHA |
| Lab requested → stored → rendered → reconstructed | substantially proven |
| Raw-http integration | proven (scripted HTTP baseline) |
| Eight-recipe treatment pipeline | substantially proven at Worker/D1 integration |
| **Semantic canaries influence agents** | **NOT PROVEN** |
| **Agents obey stop/handoff instructions** | **NOT PROVEN** |
| **Agents request decoy routes** | **NOT PROVEN** |
| **FULL reduces autonomous-agent signup rate** | **NOT PROVEN** |
| **One architecture more vulnerable than another** | **NOT PROVEN** |

### Why the 50% exposure number was misleading (FR-R7-003/004)

The pre-FR-R7 schema recorded `canary_exposed: boolean`. Human trials produced
no perception artifact, so they were recorded as `false` — a NOT-MEASURED
result treated as MEASURED-NOT-EXPOSED. Mixing that with raw-http's 10/10
MEASURED-EXPOSED gave "50% exposure", which conflated three different
statements:

- raw-http's transport layer received the HTML treatment (10/10 EXPOSED),
- the agent saw it as model input (0/0 — no model in the pilot),
- a human saw it on screen (10/10 UNMEASURED — we did not measure).

The new RunRecord v2 schema replaces the boolean with:

- `exposure_state`: EXPOSED | NOT_EXPOSED | UNMEASURED
- `perception_surface`: human-visual | transport-html | raw-html-model-input
  | simplified-dom-model-input | accessibility-model-input | browser-use-observation
  (null when UNMEASURED)

A 40-record reproduction against the pilot data shows:

```
Surface                                EXPOSED  NOT_EXPOSED   UNMEASURED
-----------------------------------------------------------------
  transport-html                              10            0            0
  (null)                                       0            0           10
  TOTAL                                       10            0           10
```

Raw-http transport exposure and human visual exposure are no longer averaged.

### Provenance corrections (FR-R7-005/008/009)

- The analyzer's "causal hit" column now counts `canary_verified_server`,
  not `disposition == "QUARANTINE"`. The pilot happened to display zero
  either way, which had hidden the bug.
- SHA256SUMS paths in the prior report were wrong (`harness/results/{...}/`
  did not exist); the actual manifest is `harness/results/SHA256SUMS.txt`.
  The 40 raw records are git-ignored in `harness/results/`; the immutable
  evidence bundle at `harness/evidence/pilot/` (this round) carries the
  verified copies + `verify.sh`.

### Stale documentation fixed (FR-R7-010)

- `harness/README.md` no longer claims browser-use / raw-http are
  `implemented: false` or that browser-use has no TS wrapper.
- Root `README.md` no longer mentions "Playwright MCP" in the repository
  layout; the adapter is named ax-snapshot.
- Root `README.md` License section no longer says "TBD"; it points to
  `./LICENSE`.

## What FR-R7 changed in the codebase

| ID | Fix |
|----|-----|
| R7-001 | `persistSession` requires `profileKeyId`; signup passes the current key; lab path unchanged. NULL-key rows are now never inserted. |
| R7-002 | Key-ring env is typed (`FIRERAID_PROFILE_KEY_CURRENT_ID`, `FIRERAID_PROFILE_KEY_PREVIOUS`); malformed JSON, duplicate IDs, current∈previous, short secrets all fail closed at startup. |
| R7-003 | RunRecord v2 schema with tri-state `exposure_state`. |
| R7-004 | RunRecord v2 schema with `perception_surface`. |
| R7-005 | Analyzer counts `canary_verified_server`, not disposition. |
| R7-006 | Harness manifest `control_variants` (normal/keyboard/autofill); human adapter expands across them. (Defense-side runner wiring is part of the next research round.) |
| R7-007 | This document. |
| R7-008 | Provenance paths and tested-vs-report SHA pinned. |
| R7-009 | Same. |
| R7-010 | Stale docs fixed. |
| R7-011 | `harness/.env.example` now documents `FIRERAID_LLM_MODEL`. |
| R7-012 | Renderer split: lab renders a visible notice; production renders an AX-inert `<template data-fr-route>` so the token exists in raw HTML but has no layout / no AX presence. |
| R7-013 | Production-only inert machine-targeted `<template data-fr-prod-notice>` — S09 is correctly described as a metadata marker, not semantic influence. |
| R7-014 | Client creates no telemetry outbox when interactionScoring=false. |
| R7-015 | The 5s periodic flush is gone; drain happens on submit and pagehide only. |
| R7-016 | `/api/events` returns `acceptedThrough`; 409 no longer drops the entire queue. |
| R7-017 | The watermark UPDATE also bumps `last_seen_at`; events route no longer calls `touchSession`. |
| R7-018 | `loadSession` returns `profileKeyId`; routes call `reconstructIssuedProfile` directly (no duplicate session SELECT). |
| R7-019 | `/c/` lab_runs query gated behind `isLabMode`. |
| R7-020 | `/api/submit` skips `canary_hits` COUNT when profile has no `decoyRoute`. |
| R7-021 | Successful production verification attempts are NOT persisted unless `FIRERAID_AUDIT_VERIFICATION_ATTEMPTS=1`. |
| R7-022 | New `session_metrics` table; production events route merges into one compact row; submit scores from it (one D1 hit). Lab mode still uses raw `event_batches`. |
| R7-023 | `MAX_EVENTS_PER_BATCH` raised 64 → 256 (re-benchmarked vs 16 KiB byte limit). |
| R7-024 | Deferred — see "Open work" below. |
| R7-025 | Cloudflare `scheduled` handler + `runRetentionSweep` covers event_batches, canary_hits, verification_attempts, submissions + evidence, abandoned + finalized sessions, orphaned session_metrics, expired lab runs. |
| R7-026 | `VerificationProvider` interface; `TurnstileVerificationProvider` in src/turnstile/; `defaultVerificationProvider(env)` is the swap point. |
| R7-028 | `browser-use.py` reports Python / browser-use / browser-engine versions; the harness records them. (Real Browser Use trial blocked on Python deps + LLM credentials — R7-027.) |
| R7-029 | `model.ts callLlm` returns served-model + provider origin (host only, never API key); threaded into `AgentRunResult.llmProvenance`. |
| R7-031 | Dead `/api/lab/runs/:id/associate` removed (export, import, route matcher). |
| R7-032 | Deferred — see "Open work". |

## Architecture invariants preserved

The deployed defense plane remained AI-free throughout FR-R7:

- `src/env.ts` declares no `FIRERAID_LLM_*` bindings.
- `src/` has no imports from `harness/`.
- The only production runtime dependency in `package.json` is `zod`.
- The only external network fetch in the defense plane is Cloudflare
  Turnstile Siteverify (managed, free, unlimited on the Free plan).
- Profile generation, correlation, scoring, decision remain deterministic.
- Semantic canaries remain static templates populated with deterministic
  session-specific values.

The LLMs exist exclusively in the attack-plane harness, and remain so.

## Open work (the next round, not done here)

1. **R7-024: Lazy-persist production sessions.** This is the biggest free-tier
   scaling lever. The blocker is non-trivial: the renderer / submit / canary
   paths would need a signed stateless envelope cookie (sid + created + profile
   version + key id + integrity) and the load-time session row INSERT
   currently used by `loadSession` would have to gracefully tolerate an
   absent row until a stateful event (telemetry / canary hit / submit)
   triggers the first INSERT. Until that's in place, every GET /signup —
   including abandoned page views — still writes one D1 row.

2. **R7-027: First real LLM/agent pilot.** Blocked on credentials. When
   `harness/.env` has `FIRERAID_LLM_BASE_URL`, `FIRERAID_LLM_API_KEY`, and
   `FIRERAID_LLM_MODEL` set, run raw-dom/raw-html, raw-dom/simplified-DOM,
   ax-snapshot, and Browser Use across CONTROL vs FULL — that's the event
   that begins testing FireRaid's actual thesis. Those credentials never
   belong in the Worker; only in `harness/`.

3. **R7-032: Production cost/overhead proof gate.** A script that counts
   Worker requests, D1 rows read/written, stored bytes, and wall latency for
   representative flows (abandoned view, accepted signup, keyboard-heavy
   signup, Turnstile failure/retry, verified canary hit), with budgets
   enforced in CI. Best done after R7-024 lands so the abandoned-view budget
   is meaningful.

4. ~~R7-008 follow-up: publish the pilot's immutable evidence bundle~~ —
   **DONE during this round.** `harness/evidence/pilot/` now contains the 40
   raw RunRecords, `SHA256SUMS.txt` (re-verified: all 40 hashes match), the
   regenerated analyzer output for both arms (post FR-R7-005), the archived
   pilot proof doc, the environment snapshot, and `verify.sh` for independent
   hash verification from a fresh clone. The bundle is git-trackable (the
   `harness/results/*.json` ignore pattern does not reach it).

## Where FireRaid stands now

| Area | State |
|------|-------|
| Deterministic defense architecture | ~92% |
| Defense-plane AI separation | 100% — verified clean |
| Treatment/reconstruction integrity | ~95% (lab/rotation proven) |
| Test infrastructure | ~92% |
| Experiment runner | ~90% (RunRecord v2 with tri-state exposure) |
| Raw-http baseline | ~95% |
| Raw-dom / AX-snapshot implementation | ~85%, efficacy untested |
| Browser Use | ~75%, happy path unproven |
| Measurement methodology | ~85% (tri-state exposure shipped) |
| Legitimate-user FP evidence | ~65% (control_variants now persisted; defended-profile trial run still pending) |
| Actual autonomous-agent efficacy evidence | ~10–15% (awaiting R7-027) |
| Production resource efficiency | ~75% (compact metrics + removed redundant writes; lazy-persist still pending) |
| Public deployment validation | not yet |
| FI production readiness | not yet |
