# FireRaid — Post-FR-R6 Execution Status

> **P1-AUDIT-2 (P1-15) — HISTORICAL DOCUMENT.** Everything below describes
> the state of the repo at the post-R6 execution mission (2026-08-30, HEAD
> `eb545d9`). Retained for archaeology, not as a statement of current
> behavior or claims — later rounds (FR-R7, P1-AUDIT-2) superseded several
> findings here (gate counts, pilot interpretation, exposure semantics).
> Where this document and current code disagree, CURRENT CODE AND ITS TESTS
> WIN; for the live experimental contract see `docs/EXPERIMENTS.md`.

**Date:** 2026-08-30 · **HEAD:** `eb545d9` (clean tree, all gates green)
**Baseline checkpoint:** `595c087` (FR-R6) → this document covers Phases 0–10 of the Post-FR-R6 Execution Mission.

Central rule applied throughout: *what exact observation would prove this claim false?* Every IMPLEMENTED claim below has a falsifiable test that was actually executed; raw outputs are archived under `harness/evidence/`.

---

## 1. Gate Status (final tree)

| Gate | Command | Result | Raw output |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | exit 0 | `harness/evidence/final/final-typecheck.txt` |
| Lint | `npx eslint .` | exit 0, 0 problems | `harness/evidence/final/final-lint.txt` |
| Unit | `npx vitest run tests/unit` | **291/291 PASS** | `harness/evidence/final/final-unit.txt` |
| Integration (real Worker + D1) | `npm run test:integration` | **32/32 PASS** | `harness/evidence/final/final-integration.txt` |
| E2E (Playwright, HTTPS) | `npm run test:e2e` | **12/12 PASS** | `harness/evidence/final/final-e2e.txt` |
| Accessibility | `npm run test:a11y` | **18/18 PASS** | `harness/evidence/final/final-a11y.txt` |

## 2. Proof Table (mission phases)

Completion labels: NOT STARTED / IMPLEMENTED / UNPROVEN / PROVEN LOCAL (E2) / PROVEN INTEGRATION (E3) / PROVEN E2E (E4) / EXPERIMENTALLY VALIDATED / PRODUCTION VALIDATED (E6) / BLOCKED.

| # | Deliverable | Label | Proof record | Key evidence |
|---|---|---|---|---|
| 0 | Baseline gates + evidence archive | PROVEN LOCAL | `evidence/baseline/SUMMARY.md` | all 6 gates green at `595c087`; environment.json pins toolchain |
| 1 | raw-http adapter integrated | PROVEN E2E (non-LLM) | `evidence/adapters/FR-POST-R6-P1-raw-http.md` | 9 unit tests on real node:http boundary + **ran 40 real trials in the pilot** |
| 2 | Browser Use thin backend | IMPLEMENTED / PROVEN LOCAL | `evidence/adapters/FR-POST-R6-P2-browser-use.md` | real worker spawn proven (DEPENDENCY_MISSING path); authority boundaries source-tested; happy path BLOCKED on `pip install browser-use openai` |
| 3 | Treatment pipeline (requested==stored==rendered==reconstructed==recorded) | PROVEN INTEGRATION | `evidence/treatments/FR-POST-R6-P3-treatment-pipeline.md` | all 8 recipes + S01/P01 + S09/P06 + TURNSTILE fail-closed; stable ×5 independent template draws; DECOY_ROUTE_ONLY was a null condition (fixed: `renderRouteNotice`) |
| 4 | Perception measurement (issued/exposed/referenced/requested/verified distinct) | PROVEN INTEGRATION (server) / PROVEN LOCAL (harness scans) | `evidence/adapters/FR-POST-R6-P4-perception.md` | **found + fixed canary.ts reconstruction drift** (lab-bound /c/ 403'd on its own rendered token); ISSUED covers all material families; exposure scan covers 4 structure signatures, artifact-only |
| 5 | Experiment manifest suite (8 ablations × prompts, dev/holdout frozen) | PROVEN LOCAL + PROVEN INTEGRATION | `evidence/FR-POST-R6-P5-manifests.md` | 12 manifests validated (50/50 checks); `holdout_mode` wired end-to-end (migration 0009 → lab API → issuance → all 3 reconstruction paths → runner) with 4× holdout-draw round-trip |
| 6 | 100–200 trial pilot | EXPERIMENTALLY VALIDATED (non-LLM portion) / BLOCKED (LLM cells) | `evidence/FR-POST-R6-P6-P7-pilot.md` | **40/40 trials, every hard invariant 100%**: reconciled 40/40, 0 unknown profiles, recipe ids from server truth, 0 dirty runs, **0 control causal false positives**, FULL issued ×20; SHA256SUMS verify clean |
| 7 | Analyzer validation | EXPERIMENTALLY VALIDATED (on pilot data) | same as P6/P7 | Wilson CIs correct (100% → [83.9,100]), denominators split operational/effectiveness, cross-sections by agent/model/template/placement/recipe; phantom-group bug (resume.json ingested) found + fixed |
| 8 | Provenance completion | PROVEN INTEGRATION | `evidence/FR-POST-R6-P8-provenance.md` + `evidence/provenance.json` | browser_name/version captured for real (was null forever — schema-declared, never populated); canonical key-sorted manifest hash (scrambled-key copy hashes identically); LLM ids honestly absent |
| 9 | Real Playwright MCP decision | NOT STARTED (deliberate) | `evidence/adapters/FR-POST-R6-P9-playwright-mcp-decision.md` | documented future work with a concrete design; ax-snapshot NOT renamed; blocked on the same LLM credentials as all of E4 |
| 10 | Public-lab readiness | PROVEN LOCAL (config) / PRODUCTION VALIDATION BLOCKED (needs live Cloudflare) | `evidence/FR-POST-R6-P10-public-lab-readiness.md` | env separation verified (top-level LAB_MODE=false; public-lab has own DB name); lab API 404s in production; 6 explicit deploy-time items listed |

## 3. Research results from the pilot (the actual science)

| Condition | n | Submission | Quarantine | Review | Exposure | Verified causal | Undetected |
|---|---|---|---|---|---|---|---|
| CONTROL (human, raw-http) | 20 | 100% [83.9, 100] | 0% [0, 16.1] | 0% | 0% | **0** | 100% [83.9, 100] |
| FULL (human, raw-http) | 20 | 100% [83.9, 100] | 0% [0, 16.1] | 0% | 50% [29.9, 70.1] | 0% | 100% [83.9, 100] |

- **Class-A control gate passes:** zero causal canary hits, zero accidental quarantines across 20 control trials (10 human, 10 raw-http).
- Exposure 50% on FULL is the measurement working, not noise: raw-http's perception IS the transport bytes (10/10 exposed); the human-control adapter records no DOM perception artifacts (0/10). Exposure is artifact-truthful per architecture.
- No agent architecture in this pilot reasons about or fetches `/c/` (no LLM in the loop), so request/reference/verified are correctly 0 — the LLM-dependent cells are where those signals can go nonzero.
- Defenses did not obstruct honest submissions (100% submission on FULL) — consistent with FireRaid's design goal: defense against agents, transparency to normal users.

## 4. What the pilot's first invocation caught (verification working as designed)

1. `resolveModelId` hard-failed model-agnostic agents → sentinel resolves to `none` there, hard error retained for model-consuming agents (no fabricated model ids).
2. `writeResumeState` crashed when every trial failed pre-record.
3. `fetchServerTruth` dropped the server's `recipe_id` — records had null; the analyzer's baseline grouping had nothing to group on.
4. (P3) DECOY_ROUTE_ONLY rendered no route anywhere — a null condition since FR-R5; fixed with exactly-once route notice; e2e causal gate still 0 hits.
5. (P4) `canary.ts` reconstructed lab-bound sessions WITHOUT the bound recipe — every legitimate REQUEST→VERIFY causal hit from a lab session would 403. Found BY the new perception-chain test; fixed symmetric with submit.ts.
6. (P5) `holdout_mode` was declared in the manifest schema and plumbed NOWHERE; now a persisted treatment-identity component.
7. (P7) Analyzer ingested `resume.json` as a run record (phantom NO_RECIPE group).

## 5. BLOCKED items (external prerequisites, precisely stated)

| Item | Blocker | Degrades how |
|---|---|---|
| LLM-dependent trials (raw-dom, ax-snapshot full runs; browser-use happy path; future playwright-mcp) | `FIRERAID_LLM_BASE_URL` / `_API_KEY` / `_MODEL` unset | Fail CLOSED: typed error RunRecords, zero fabricated submissions/provenance |
| browser-use python deps | `pip install browser-use openai` | DEPENDENCY_MISSING error results (proven clean) |
| Production validation (E6) of public-lab | live Cloudflare deployment (6 deploy-time steps listed in P10 record) | Config-level proofs complete; nothing deployed |

## 6. Integrity

- `harness/results/{exp-pilot-control,exp-pilot-full}/SHA256SUMS.txt` — 40 records, verifies clean.
- No real credentials, API keys, raw Turnstile secrets, PII, or FI account data anywhere in the repo or results (synthetic fixtures only; secrets gitignored and untracked).
- Evidence-first discipline maintained: each phase's raw gate outputs archived before the next phase began.

## 7. Recommended next actions

1. Supply LLM credentials (`harness/.env`) → rerun `exp-pilot-{control,full}` with raw-dom cells → first REAL agent-vs-defense measurements (the E4 unblocking event).
2. `pip install browser-use openai` → browser-use pilot cells.
3. Scale to the mission's 150-trial matrix (5 conditions × 3 architectures × 2 models × 5 reps) once 1–2 hold.
4. Execute P10's deploy-time list → public-lab E6 smoke.
