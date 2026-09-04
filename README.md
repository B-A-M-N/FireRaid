# FireRaid

> FireRaid is a deterministic, per-session, randomized defense-in-depth middleware
> for autonomous-agent admission control. Research and evaluation are subsystems
> of the product. FireRaid integrates into existing application review workflows and
> does not own account approval.

FireRaid generates unpredictable session-specific defense profiles, records causal
and behavioral signals, and evaluates those defenses against multiple browser-agent
architectures.

It is **not** a research lab. Research and evaluation are subsystems of the product.

It is **not** a universal bot detector. It is an agent-admission defense.

It is **not** model-driven. The defense path is fully deterministic with zero LLM calls.

## What FireRaid Does

- Generates unpredictable, session-specific defense profiles from a server secret
- Injects decoy fields, decoy endpoints (routes), semantic traps, and coarse
  interaction telemetry into **every** defended signup session
- Binds semantic instructions to a fill-expressible actuator (`session_response`
  sink) so an agent that obeys a delivered instruction produces server-verifiable
  causal evidence (E5 lever)
- Collects coarse interaction telemetry, including depth signals (zero-dwell
  fill, uniform input cadence, no-blur-before-submit) — no invasive fingerprinting
- Correlates observed behavior with the exact profile issued per-session
- Produces auditable decision records (ACCEPT / REVIEW / QUARANTINE) that feed
  existing application review workflows — FireRaid does not own account approval
- Measures defense effectiveness against autonomous browser agents via a
  built-in adversarial evaluation harness

## Architecture

```
Internet
   │
   ▼
Cloudflare (optional)
   │
   │ TLS / CDN / DDoS / WAF / rate limiting / Turnstile
   │
   ▼
FireRaid (origin middleware)
   │
   │ deterministic origin-side middleware
   │ no model calls
   │ no Worker requirement
   │ no D1 requirement
   │ per-session randomized defense composition
   │
   ▼
FreeInference signup/application handler
   │
   ▼
existing FreeInference approval workflow
```

Separately — the **evaluation plane** that attacks FireRaid during testing:

```
AI / AGENT EVALUATION SYSTEM
          │
          ├── Raw-DOM LLM agents
          ├── Browser Use
          ├── AX agents (accessibility-snapshot + LLM)
          ├── vision agents (screenshot-only)
          ├── FireRaid-aware agents (briefed attackers)
          ├── scripted automation
          └── human controls
          │
          ▼
production-equivalent FireRaid test deployment
```

The harness attacks the **same artifacts that production uses**. Debug
instrumentation can differ; the treatment itself cannot.

## Measured Efficacy (evidence summary)

Three completed 30-trial experiments against the production-faithful
origin runtime (the upstream's own account ledger is the endpoint):

| Run | Perception | Result |
|-----|-----------|--------|
| E4 | simplified-dom | Null — `<template>` carriers are structurally invisible to that perception (delivery artifact, proven by replay probe) |
| E5 | raw-html | Primary null, but **compliance-on-delivery measured**: 4/4 agents that received the route instruction echoed the exact token + nonce; 0/4 without delivery |
| E6 (levers) | raw-html | **Defended account-creation 2/10 vs CONTROL 10/10** (matched raw-dom cells; analyzer matched-cell ARR 53.3% [9.7%, 75.2%] with human cells included); humans 5/5 clean both arms |

E6's honest shape: most blocks are attrition (the agent exhausts its
budget inside the trap loop before submitting) rather than scored
QUARANTINE at admission; both reduce account creation. Single model
(LongCat-2.0), single agent architecture (raw-dom), n=10/arm — an
existence proof of mechanism effect, not a deploy-grade estimate. Full
caveats and evidence pointers: [docs/RELEASE-STATUS.md](docs/RELEASE-STATUS.md) claim 8.

## Product vs evaluation

The **product** is the deterministic middleware (`createFireRaidMiddleware`
+ origin runtime): zero LLM calls, zero D1, zero Worker requirement.
`npm run test:product` enforces the product/evaluation boundary at build time.

The **evaluation system** (harness/, experiments, Worker fixture) imports
the product; the product never imports the harness.  This asymmetry is
the testable zero-infrastructure thesis — the defense core runs standalone.

`npm run dev:origin` runs the reference origin host on Node (Node 18+).
`npm run test:origin-budget` proves the zero-infrastructure thesis by
measuring profile generation, GET inject, and POST submit timing budgets
and asserting zero network egress and zero D1 imports in the product path.

### Invariants

The authoritative invariants are in [docs/INVARIANTS.md](docs/INVARIANTS.md):

- **FR-INV-001**: The defense path MUST NOT depend on an LLM
- **FR-INV-002**: All defense profiles MUST be reproducible server-side from
  versioned server-controlled state
- **FR-INV-003**: The browser MUST NOT be authoritative for classification
- **FR-INV-004**: Class-A evidence MUST contain session-specific causal correlation
- **FR-INV-005**: Weak heuristics MUST NOT be silently promoted to causal evidence
- **FR-INV-006**: Production-eligible canaries MUST NOT degrade ordinary accessibility
- **FR-INV-007**: Canary actions MUST be harmless, local, and reversible
- **FR-INV-008**: FireRaid MUST NOT falsely report successful completion of a
  consequential real-world action that it actually discarded
- **FR-INV-009**: Experiment configuration MUST be versioned and reproducible
- **FR-INV-010**: Measured results MUST remain distinguishable from assumptions

## Defense-in-Depth Composition

Every defended session receives a coherent defense stack derived deterministically
from `(secret, version, session_id)`:

```
session PRF
   │
   ├── composition policy    — which families participate
   ├── semantic strategy     — trap type and carrier
   ├── causal channel        — how the trap becomes causal evidence
   ├── decoy-field strategy  — field name, placement, value
   ├── carrier strategy      — HTML carrier for opaque delivery
   ├── placement             — DOM insertion point (field-level)
   ├── identifiers           — opaque field names, element IDs
   ├── route                 — session-bound decoy route token
   ├── nonce                 — session-bound challenge value
   ├── telemetry mask        — which events are captured
   └── policy                — scoring policy
```

Every ordinary defended profile MUST contain:

```
≥1 causal-capable mechanism  (semantic trap + route OR nonce field)
+
≥1 independent automation trap  (decoy field OR decoy route OR interaction)
+
optional weak behavioral observations  (telemetry, timing)
```

Families vary per session to prevent systematic special-casing, but FireRaid
never creates a weak session consisting entirely of low-confidence heuristics.

### Defense Families

| Family        | What it does                                      | Causal? |
|---------------|---------------------------------------------------|---------|
| semantic      | Machine-safe semantic trap (invisible instruction) | Yes     |
| decoy-field   | Invisible decoy form field                        | Yes (with nonce) / Strong (without) |
| decoy-route   | Hidden same-origin endpoint                       | Yes     |
| interaction   | Coarse interaction telemetry (focus, key, pointer) | Weak   |

**No environment flag removes or adds families.** The family composition is
determined purely by the deterministic PRF over the session secret.

## Quick Start

```bash
git clone <repo>
cd FireRaid
npm install

# Run the reference origin host (pure Node — no Cloudflare account, no
# .dev.vars setup; it generates dev-only secrets itself)
npm run dev:origin
```

Then open http://127.0.0.1:3456/signup — a real signup page served by the
origin host with FireRaid's middleware attached (the same `public/signup.js`
client a deployment ships).

### Cloudflare Worker Deployment (Optional)

The Worker deployment is a reference implementation, not a requirement:

```bash
npx wrangler d1 create fireraid
# Paste the printed database_id into wrangler.jsonc (all env blocks)
npx wrangler d1 migrations apply fireraid --remote   # full migration chain
npm run deploy:production   # or deploy:lab — named-env deploys only
```

## Testing

```bash
npm test                  # Runs unit tests via vitest (tests/unit/)
npm run test:unit         # Profile engine, catalog, correlation, decision
npm run test:integration  # Full signup → canary → submit flow (requires worker)
npm run test:e2e          # Playwright browser tests (lab plane, LAB_MODE=true)
npm run test:e2e:production  # Production plane (LAB_MODE=false) across Chromium/Firefox/WebKit
npm run test:a11y         # Accessibility assertions
npm run test:ledger-proof    # end-to-end: attacker behavior → evidence → admission → upstream forwarding → origin ledger
npm run test:envelope        # stateless production envelope issuance + forged-envelope rejection
npm run test:budget          # Cloudflare/D1 resource budget harness
npm run release:verify       # deterministic release gates; stamps release-evidence.json
```

## Running Experiments

```bash
npm run experiment -- harness/experiments/exp-001.json   # run a manifest
python3 harness/analysis/analyze.py <experiment-id>      # rates + group deltas
python3 harness/analysis/analyze.py <experiment-id> --endpoints   # ARR/RRR + FP bound
```

See [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) for the manifest format,
condition vocabulary (CONTROL / PRODUCTION_DEFAULT / ablations), the
matched-cell analysis contract, and the experiment-series ledger.

## Repository Layout

```
src/            Origin middleware + defense plane
  core/         Profile engine, catalog, correlation, decision (host-neutral)
  routes/       HTTP handlers (signup, submit, canary, telemetry, health)
  security/     CSRF, cookies, headers, admin auth
  analytics/    Canonical run-metric definitions (shared with the analyzer)
  host-adapter/ Host-neutral admission seam (middleware, reference render)
  cloudflare/   D1 stores, session envelopes, retention sweep (optional)
  turnstile/    Turnstile verification
harness/        Adversarial evaluation plane
  core/         Runner, adapter interface, recorder
  adapters/     Human control, raw-DOM, browser-use, ax-snapshot, raw-http,
                dom-automation, fill-everything, humanized-pw, vision-only,
                fireraid-aware
  extractors/   HTML, simplified DOM, accessibility
  experiments/  Declarative manifests
  fixtures/     Persona pool (P2-TRAFFIC): 20 synthetic identities, drawn
                per-cell (condition-independent) in "pool" mode
  results/      Structured run output + experiment.json declaration sidecar
  analysis/     Python stats + confidence intervals
scripts/        Ledger proof, upstream, budget harness, test worker
public/         Static signup + admin pages
migrations/     D1 schema (apply the whole chain, never just 0001; optional)
tests/          Unit, integration, e2e, accessibility
docs/           Architecture, integration, threat model, invariants
```

## Acknowledgements

FireRaid was originally developed in response to problems observed around open-access inference services, including [FreeInference.org](https://freeinference.org), but it is an independent, general-purpose project intended to be useful beyond any single platform or organization.

FireRaid is **not affiliated with, sponsored by, endorsed by, commissioned by, or developed under the direction of FreeInference.org**. FreeInference.org did not request this project, has not reviewed or approved its design or implementation, and is not responsible for its claims, behavior, documentation, or technical decisions.

Any references to FreeInference.org are provided for context and acknowledgement only. All responsibility for FireRaid, including any errors, overclaims, or design decisions, rests solely with this project and its maintainers.

## Supporting Public Inference

We believe providing inference to the public is a vital and increasingly necessary resource. Capable models are becoming part of writing, research, education, software, and ordinary problem-solving, but public access is still too easy to overlook or dismiss. Public inference gives more people room to learn, experiment, build, and participate. Its value is often clearest only after access disappears.

If FireRaid is useful to you, or if you share that view, please consider sponsoring [FreeInference.org](https://freeinference.org).

## License

**Source available under the [FireRaid Community Source License 1.0](LICENSE).**
Free production use is permitted for qualifying inference providers,
educational and research institutions, public-sector organizations, and
other permitted service operators. Other uses may require separate
authorization.

In plain terms: FireRaid is intended to be freely usable by organizations
operating legitimate inference and online services, including academic and
public-interest providers. The license is structured to prevent use by
deceptive or unauthorized inference-resale operations — misrepresenting
infrastructure or service, reselling without upstream authorization,
brokering credentials, circumventing access controls, or deceptively
hiding that a service is a proxy — while keeping the source available for
inspection, research, modification, and contribution. Aggregation and
routing are not prohibited as such; deception and unauthorized resale are.
