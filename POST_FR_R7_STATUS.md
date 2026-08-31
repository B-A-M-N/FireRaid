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

## P1 audit response (this round)

The seven remaining P1 audit items plus the two umbrella closers are now landed
on a single working tree (uncommitted at time of writing; gate numbers below are
from the final green run). The audit's key milestone — the ledger experiment
(P1-24) — is what establishes whether FireRaid works, and it passes.

| P1 | Item | State | Notes |
|----|------|-------|-------|
| P1-24 | Middleware adapter + upstream ledger proof | **DONE** | `scripts/ledger-upstream.mjs` (ordinary upstream, own ledger, knows nothing of FireRaid), `scripts/ledger-proof.mjs` (reference adapter in front: inject on GET, evaluate before forwarding POST, strip FireRaid fields, forward only on ACCEPT). Primary truth = did the origin ledger contain the synthetic account. Live gate: `LEDGER PROOF: PASS`. |
| P1-25 | Host-neutral admission + adapters | **DONE** | `src/host-adapter/{interface,reference-render,reference-adapters,middleware,index}.ts`. Host-adapter seam for state/session, render/inject, verification, telemetry, enforcement. `admit()` is fail-closed. The middleware proof exercises this exact seam. |
| P1-20 | Randomized interleaved conditions | **DONE** | `harness/core/run-schema.ts` `conditions[]` + seeded per-block interleave (contemporaneous CONTROL/defended). `harness/experiments/exp-interleaved*.json`. 4 unit tests. |
| P1-26 | Correct endpoints + statistics | **DONE** | `harness/analysis/analyze.py`: primary endpoint = account-creation rate; `risk_reduction()` = ARR + RRR with propagated Wilson CIs; `false_positive_upper_bound()` replaces "zero false positives" with a one-sided upper bound. `analyze.py <exp> --endpoints` report. Verified against pilot (RRR path works on a combined CONTROL+FULL dataset). |
| P1-21 | Realistic attacker architectures | **PARTIAL** | Taxonomy + `ADAPTER_CAPABILITIES` registry + fail-closed `validateManifest` (unimplemented architectures rejected, never silently skipped). Landed + wired: `dom-automation` (visible-inputs), `fill-everything` (omnivorous incl. decoys — non-LLM; deterministic loop, P1-AUDIT-2 Phase F), `humanized-pw` (humanized timing — non-LLM, Phase F). Still `implemented:false` (model-backed; blocked on LLM spend per R7-027): `vision-only`, `fireraid-aware`. Unit tests + Phase F joined ledger proofs. |
| P1-22 | Opaque production carriers | **DONE (narrowed claim)** | `src/core/renderer.ts` strips `data-fr-*`, `fr-decoy` class, and visible `/c/<token>` text from **production**; lab keeps explicit markers (researchers can grep). The claim is deliberately scoped to FIXED presentation signatures — the profile-bound `fr_` field name and `/c/` route prefix are session-specific and remain (P1-23 residual). 4 guard tests. |
| P1-23 | Production semantic mechanism | **DECIDED (narrowed)** | Production thesis narrowed to decoy-field + decoy-route + interaction. S01–S08 semantic instruction templates remain LAB-ONLY (FR-R7-013); production renders no semantic-instruction surface. S09 stays a measurement probe, not a defense. Residual `fr_` field-name + `/c/` route prefix are profile/server-bound bindings (submit.ts/canary.ts), documented as accepted residual, not a to-do. 2 enforce tests. |
| #8 | Full gate + status doc | **DONE** | All gates green (see below). This document updated to not overstate proven claims. |
| #9 | Commit hygiene | open at time of writing — working tree held clean of survey artifacts; awaiting commit. |

### Final gate run (green)

| Gate | Result |
|------|--------|
| typecheck (`tsc --noEmit`) | clean |
| lint (`eslint --max-warnings 0`) | 0 warnings |
| unit (`vitest run tests/unit`) | **396 passed** |
| integration (`npm run test:integration`) | **33 passed** |
| envelope (`npm run test:envelope`) | **7 passed** |
| e2e (`playwright test`) | **12 passed** |
| a11y (`playwright ... a11y`) | **18 passed** |
| budget (`npm run test:budget`) | **9/9 scenarios PASS** |
| ledger proof (`npm run test:ledger-proof`) | **PASS** |

### What is proven vs still open (honest)

- **PROVEN this round:** the host-neutral middleware seam correctly gates an
  ordinary upstream and the origin ledger is the ground truth; production
  rendering carries no FIXED greppable presentation signature and no
  semantic-instruction surface (the profile-bound `fr_` field name and the
  `/c/` route prefix remain as accepted residuals — see P1-23); the
  endpoints/statistics analyzer no longer claims "zero false positives".
- **PROVEN in the P1-AUDIT-2 phases (b960fad…46e7b45):** Phase A self-audit
  corrections (visible production decoy hidden, capture-mask session binding,
  fail-closed lab-assignment reads, fail-closed canary persistence); Phase B
  experiment validity (recipeId in trial identity, blocked-randomized
  interleaving, exact model-input evidence, ITT taxonomy + origin-ledger
  endpoints in the analyzer); Phase C the JOINED causal chain — real harness
  adapters drive the middleware facade over HTTP and the origin ledger
  read-back is the primary endpoint; Phase D host equivalence (shared
  `buildArtifactSet` artifact core with mapper parity tests; host canary
  route with `HostCanaryStore` — probe→QUARANTINE→empty-ledger proven; host
  session envelope byte-identical to the Worker's FR-P1-19 envelope); Phase E
  cost corrections (envelope fast-path verify-then-select, production family
  pool no longer draws a never-rendered semantic slot, bounded pagehide
  flush, honest `verified-canary` budget scenario; normal-signup reads
  14→5); Phase F adversarial breadth (`fill-everything` omnivore springs the
  decoy trap at the ledger; `humanized-pw` honest-human signals are NOT
  flagged; urlencoded form-post carrier; host plane serves the real
  telemetry client).
- **STILL OPEN (not regressed):** actual autonomous-agent *efficacy* evidence
  from a real LLM pilot (R7-027) — the `vision-only` and `fireraid-aware`
  architectures (model-backed) need real trials before any reduction in
  signup rate can be claimed. The interleaved manifest (P1-20) is the
  vehicle for those trials once credentials exist.

---

# P1-AUDIT-2 audit response (current round)

**Batch commits:** e00f71d (Batch 0–1: retention sweep module, CAS
telemetry fold, integrity gate), 6fd12ce (Batch 3: host-neutral
equivalence), f4fcf31 (Batch 4: production-faithful arms + ledger truth +
bounded submit), c9362af (Batch 5: security hardening, dead code, admin
parity) + this commit (Batch 6: docs truth pass).

## Item-by-item accounting

| Item | State | Notes |
|------|-------|-------|
| P0-1..P0-12 | **DONE** | Origin-reconciled primary outcome, ledger-proof plane, origin ITT endpoints, envelope fast-path, config validation in cron, per-request span isolation, production family pool, production-faithful recipe arms (PRODUCTION_FIELD/ROUTE/INTERACTION/FULL; FULL ≡ PRODUCTION_FULL on the production plane), honest canary budget scenario, defended-condition FP upper bound with UNMEASURED accounting. |
| P1-1 mode-family contract | **DONE** | LAB_FAMILIES/PRODUCTION_FAMILIES split; explicit semantic recipes in production fail closed (`FAMILY_NOT_ELIGIBLE_IN_MODE`); random production pool never draws semantic. |
| P1-7 constant-time consolidation | **DONE** | One primitive in `core/tokens.ts` (length folded into accumulator); session/lab/admin/envelope callers re-pointed. |
| P1-8 canary insert | **DONE** | Targeted `ON CONFLICT (session_id, family, expected_hash) DO NOTHING`. |
| P1-9 compact causal-hit state | **DONE** | `sessions.causal_route_hit` (migration 0014) set in the same batch as the hit insert; submit reads the flag from the session SELECT (per-submit COUNT gone; legacy rows fall back to EXISTS). |
| P1-10 raw telemetry retention | **DONE** | 7-day default raw window (`FIRERAID_RAW_TELEMETRY_RETENTION_DAYS`), clamped ≤ derived window; admin `?rawDays=` mirror; documented in SECURITY.md. |
| P1-12 single assignment read | **DONE** | `readLabAssignment` (submit/canary) + `readLabAssignmentByRunId` (signup bind) — one parse/fail-closed implementation. |
| P1-14 bounded submit | **DONE** | Client attaches at most ONE batch; middleware serves the telemetry-drain carrier (`kind:"ingest"`); live-found INVALID_TELEMETRY flake fixed. |
| P1-15 honest canary budget | **DONE** | Bounded retry (20 signups, miss p≈8e-20) then hard throw — silent no-op PASS impossible. |
| P1-16 budget metric naming | **DONE** | Rows read/written decoded from wrangler trace-store span attributes (the HTTP query API strips them); report separates statement calls from row movement; undecodable = n/a. |
| P1-17 exposure denominators | **DONE** | Two-level: `exposure_coverage` (data quality) vs `measured_exposure_rate` (the real rate) in the analyzer. |
| P1-18 honest FP bound | **DONE** | Per-defended-condition human FP table; Wilson one-sided upper bound; missing-human arms UNMEASURED. |
| P1-19 outcome taxonomy + ITT | **DONE** | Five failure planes; every emitted provider code classified; ITT submission rate defined for all-invalid groups (latent NameError fixed); assignment-based denominator in `compute_rates`. |
| P1-20 interleaved conditions | **DONE** | (prior round) Blocked-randomized per-repetition conditions. |
| P1-21 adapter origin-knowledge | **DONE** | `dom-automation` drops `fr_`/`fr-decoy` skip list — visibility is the only filter; decoys rendered visible MUST be filled (that's the ablation signal). |
| P1-22 browser provenance | **DONE** | Every Playwright-launched adapter carries browser_name/version; browser-use records its own worker provenance. |
| P1-23 (P1-AUDIT-2) browser-use preflight | **DONE** | python3 + browser_use import probed BEFORE the first trial; mirrors the worker's own import strategy. |
| P1-24 opaque-claim narrowing | **DONE** | Status + SECURITY.md scope the claim to FIXED presentation signatures; `fr_`/`/c/` residuals documented as accepted (P1-23). |
| P1-25 production notice | **DONE (verified)** | Classify-and-test already true: inert `data-rt-carrier` template in production, machine-targeted marker lab-only; positive + opacity tests in both renderers. |
| P1-26 finalizer concurrency | **DONE** | OR IGNORE + SELECT-form evidence inserts + migration 0013 fingerprint; concurrent loser writes NOTHING (constraint-free), exact replays idempotent. 6 real-SQLite tests. |
| P1-27 dead stores | **DONE** | D1SubmissionStore/D1EvidenceStore + their interfaces deleted (zero callers). |
| P1-28 canonical metrics | **DONE** | `src/analytics/run-metrics.ts` — admin and analyze.py share definitions; retired column never read; 5 pinning tests; analyzer docstring cross-cites. |
| P1-29 admin holdout parity | **DONE** | adminSessionDetail uses the shared resolver (holdout + turnstile carried; D1 failures surface as reconstructionError, never a silent random profile). |
| P1-32 wrangler placeholder | **DONE** | Annotated in wrangler.jsonc; README deployment section explains it. |
| P2 dead renderer interface | **DONE** | `renderer-interface.ts` deleted; INTEGRATION.md rewritten to the canonical `buildArtifactSet` contract. |
| Docs truth pass | **DONE** | README (migration chain + deploy flow + current layout), ARCHITECTURE (SameSite=Strict, envelope session), EXPERIMENTS (real agent names, origin-ledger mode, canonical metrics), SECURITY (real limits, CSP without unsafe-inline, retention, constant-time, opacity residuals), THREAT-MODEL (FP bound not zero-FP, truth hierarchy, residuals). |

## Final gate run (green, this round)

| Gate | Result |
|------|--------|
| typecheck (`tsc --noEmit`) | clean |
| lint (`eslint --max-warnings 0`) | 0 warnings |
| unit (`vitest run tests/unit`) | **515 passed** (43 files) |
| integration (`npm run test:integration`) | **40 passed** (5 files) |
| envelope (`npm run test:envelope`) | 7 passed |
| budget (`node scripts/budget-harness.mjs`) | 9/9 scenarios PASS (now with row-movement truth) |
| ledger proof (`npm run test:ledger-proof`) | PASS (3 arms) |

## Still open (unchanged, not regressed)

- Real LLM pilot efficacy evidence (R7-027): `vision-only` / `fireraid-aware`
  model-backed arms need credentials + trials. The interleaved manifest is
  the vehicle.
- Remote deploy smoke on a real Cloudflare account (blocked on
  `database_id` provisioning).
