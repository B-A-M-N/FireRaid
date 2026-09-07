# FireRaid — Release Status & Claim Tiers

**Source of truth: [`evidence-ledger.json`](evidence-ledger.json).** Every
claim tier in this document is registered there — machine-readable, with
evidence pointers and scope limits — and validated by
`tests/unit/evidence-ledger.test.ts`. This file is the prose companion: it
explains the vocabulary and the rules; the ledger owns the tiers. Where any
document (including this one) disagrees with the ledger, **the ledger
wins**, and the prose must be corrected in the same change.

`npm run release:verify` runs the deterministic gates in FULL mode and now
REQUIRES the `release_ready` tier to exit 0 (FR-RR-50:
`--require-tier release_ready`); "all gates green but no tier satisfied"
is a failed release verification. It writes `release-evidence.json`, which
embeds the ledger's tier map; the run deliberately does not attest
MEASURED or PARTIALLY_ESTABLISHED claims. For pre-deploy iteration use
`release:verify:full` (gates only) or pass
`--require-tier local_candidate|deploy_ready` explicitly.

## Claim vocabulary

Owned by the ledger (`tier_vocabulary`), summarized here:

| Tier | Meaning | Evidence |
|------|---------|----------|
| **IMPLEMENTED** | The capability exists in code with a passing test that pins its behavior. | unit/integration suite |
| **LOCALLY_VERIFIED** | A deterministic, repeatable local gate passed for THIS tree (no network beyond loopback, no live models). | `release-evidence.json` |
| **PARTIALLY_ESTABLISHED** | Completed experiments support a bounded, qualified quantitative claim. The scope limits (n, model, architecture, effect shape) are PART of the claim — stripping them overreaches. | completed experiment dirs + analyzer output |
| **MEASURED** | A completed experiment (`experiment.json` `status=COMPLETE`, planned-vs-present record match, matched CONTROL/DEFENDED cells) supports a quantitative claim. | `harness/results/<experiment>/` + analyzer output |
| **NOT_YET_ESTABLISHED** | No evidence at the required tier exists. Stating the claim would overreach. | — |

Rules that keep this document honest:

1. A claim never moves up a tier without the corresponding evidence file
   in the ledger.
2. An interrupted experiment can never back a MEASURED claim — even with
   many records present (interruption breaks the cell-mix; see
   P0-AUDIT-3/P0-2 and `harness/analysis/analyze.py` completeness gates).
3. Where code and this document disagree, CODE AND ITS TESTS WIN, and this
   document must be corrected in the same change.

## Claim surface

The registry: [`evidence-ledger.json`](evidence-ledger.json) `claims[]`.
Summary (tiers as of the ledger's `updated` date):

| # | Claim (ledger id) | Tier | Evidence (see ledger for full pointers) |
|---|-------------------|------|-----------------------------------------|
| 1 | Deterministic per-session defense derivation (`deterministic-derivation`) | **LOCALLY_VERIFIED** | unit parity + determinism suites; `release-evidence.json` |
| 2 | Production composition always includes the semantic strategy layer + ≥1 independent trap, DiD (`production-did-composition`) | **LOCALLY_VERIFIED** | `tests/unit/ablation-recipes.test.ts` (32-session parity: `PRODUCTION_DEFAULT` ≡ `deriveProductionProfile`) |
| 3 | Production-plane presentation-signature invisibility (`production-carrier-opacity`) | **LOCALLY_VERIFIED** | `tests/e2e/production-plane.spec.ts` (Chromium/Firefox/WebKit, LAB_MODE=false) + `tests/unit/production-carrier-opacity.test.ts` |
| 4 | Human usability preserved (`human-usability`) | **LOCALLY_VERIFIED** | `tests/e2e/normal-user.spec.ts`, `tests/e2e/production-plane.spec.ts`, `tests/accessibility/` |
| 5 | Causal-evidence chain through to the independent origin ledger (`causal-evidence-chain`) | **LOCALLY_VERIFIED** | `npm run test:ledger-proof` (CONTROL clean registers; bot with populated trap does not) |
| 6 | Origin cost profile: ~ms derivation, zero product egress, zero D1 in product closure (`origin-cost-profile`) | **LOCALLY_VERIFIED** | `npm run test:origin-budget` + product-boundary gate |
| 7 | Test-infrastructure honesty (`test-infra-honesty`) | **LOCALLY_VERIFIED** | `npm run test:worker-isolation`; analyzer completeness gates |
| 8 | Autonomous-agent efficacy: PRODUCTION_DEFAULT reduces autonomous signup success vs CONTROL (`autonomous-agent-efficacy`) | **PARTIALLY_ESTABLISHED** | E4 (channel-invisibility null), E5 (compliance-on-delivery; primary null), E6 (first live-loop efficacy signal: defended account-creation 2/10 vs CONTROL 10/10 matched raw-dom cells, ARR 80%; analyzer matched-cell 46.7% defended / ARR 53.3% [9.7%, 75.2%] incl. humans; humans 5/5 clean both arms). **Scope limits are part of the claim**: single model (LongCat-2.0), single architecture (raw-dom), n=10/arm; attrition-dominant shape (defense exhausts attacker budget mostly BEFORE admission — 7/8 attrition, 1/8 scored QUARANTINE with clean origin ledger). Existence proof of mechanism effect, not a deploy-grade estimate. |
| 9 | Any per-architecture vulnerability ranking (`per-architecture-ranking`) | **NOT_YET_ESTABLISHED** | Requires #8 plus matched per-extractor cells (E4's channel-invisibility finding makes the extractor dimension the first-order variable) |
| 10 | Remote Cloudflare deployment behavior (`remote-deployment-smoke`) | **LOCALLY_VERIFIED** (live smoke, 2026-09-03) | Deployed `fireraid-production.benevolentjoker.workers.dev` (version `b401da70`): D1 + 16-migration chain applied remotely; secrets via `wrangler secret`; config validator fail-closed LIVE (503 `Production requires TURNSTILE_EXPECTED_HOSTNAME` before Turnstile configured); post-config smoke: `/signup` 200 with clean production plane, Turnstile wired; headless submit without solved token → `403 verification_required`; solved-widget human submission → success receipt. **NOT MEASURED**: sustained production traffic, custom-domain routing, remote cron retention. **FR-P0-05 freshness**: the 2026-09-03 smoke predates migration 0017 and the current HEAD — it does NOT certify the current SHA's 17-migration chain is applied remotely. A stable release requires a fresh post-deploy smoke against the exact deployed worker version (see the corrected, environment-scoped sequence in [DEPLOYMENT.md](DEPLOYMENT.md)). |

## Release gating

- `npm run release:verify` — runs the deterministic gates (typecheck, lint,
  unit, product boundary, worker isolation, origin budget) and stamps
  `release-evidence.json` with git SHA + dirty flag + the ledger tier map.
  `local_candidate: true` requires a CLEAN tree in FULL mode; dirty
  evidence is still written for iteration but flagged. A missing or
  malformed evidence ledger fails the run (fail-closed). Exit 0 additionally
  requires `release_ready` (FR-RR-50) — the release job cannot pass while
  the deploy/smoke tiers are unmet.
- Items 8 and 10 are user-gated: a real benchmark run, and a remote deploy
  smoke, are the owner's call (costs money / touches the internet).

## Historical status documents

`POST_FR_R6_STATUS.md` and `POST_FR_R7_STATUS.md` are HISTORICAL snapshots
(read their banners). They do not describe current behavior; where they
conflict with this file, the ledger, or the code, **the ledger and the
code win**.
