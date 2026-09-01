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
- Collects coarse interaction telemetry (no invasive fingerprinting)
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

# Set up environment
cp .env.example .dev.vars
# Edit .dev.vars with real values (or use the test defaults)

# Run locally (as origin middleware — no Cloudflare required)
npx tsx src/host-adapter/middleware.ts
```

Then open http://localhost:8787/signup

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
npm test                  # Unit + integration tests
npm run test:unit         # Profile engine, catalog, correlation, decision
npm run test:integration  # Full signup → canary → submit flow
npm run test:e2e          # Playwright browser tests (normal user, keyboard, autofill)
npm run test:a11y         # Accessibility assertions
```

## Running Experiments

```bash
npm run experiment -- harness/experiments/exp-001.json   # run a manifest
python3 harness/analysis/analyze.py <experiment-id>      # rates + group deltas
```

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
  results/      Structured run output
  analysis/     Python stats + confidence intervals
scripts/        Ledger proof, upstream, budget harness, test worker
public/         Static signup + admin pages
migrations/     D1 schema (apply the whole chain, never just 0001; optional)
tests/          Unit, integration, e2e, accessibility
docs/           Architecture, integration, threat model, invariants
```

## Acknowledgements

FireRaid exists to serve the mission of [FreeInference.org](https://freeinference.org) —
free, open access to inference for everyone. If you find this project useful,
please support FreeInference.org and the work they do.

This project is an independent effort: **we were not asked or commissioned by
FreeInference.org to build it, and nothing here has been reviewed or endorsed
by them.** Any errors, overclaims, or odd design decisions are entirely ours.

## License

Defined in [./LICENSE](LICENSE): FireRaid is provided as-is for academic and
educational purposes — copyright (c) 2026, FireRaid Contributors. See the
Research Use Notice at the end of that file.
