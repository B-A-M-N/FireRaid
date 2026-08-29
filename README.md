# FireRaid

FireRaid is an experimental agent-admission defense lab for studying autonomous browser registration.

It generates deterministic per-session defense profiles, records causal and behavioral signals, and evaluates those defenses against multiple browser-agent architectures.

FireRaid is a research prototype, not a universal bot detector.

The project intentionally separates deterministic production defense logic from model-driven attack harnesses.

## What FireRaid Does

- Generates unpredictable, session-specific defense profiles from a server secret
- Injects semantic canaries, decoy fields, and decoy endpoints into a signup flow
- Collects coarse interaction telemetry (no invasive fingerprinting)
- Correlates observed behavior with the exact profile issued
- Produces auditable decision records (ACCEPT / REVIEW / QUARANTINE)
- Measures defense effectiveness against autonomous browser agents

## Architecture

```
DEFENSE PLANE (deterministic, no LLM, auditable)
─────────────────────────────────────────────────
Cloudflare Worker → Session Factory → HMAC Profile Seed
                                          ↓
                              Defense Profile (semantic, decoy, telemetry)
                                          ↓
                              HTML Injection → Browser → Submit
                                                      ↓
                              Turnstile + Correlation + Decision Engine → D1

ATTACK / RESEARCH PLANE (uses LLMs, experimental)
─────────────────────────────────────────────────
normal Playwright control │ raw-DOM + LLM │ Browser Use │ Playwright MCP
```

### Invariants

- **FR-INV-001**: The defense path MUST NOT depend on an LLM
- **FR-INV-002**: All defense profiles MUST be reproducible server-side from versioned server-controlled state
- **FR-INV-003**: The browser MUST NOT be authoritative for classification
- **FR-INV-004**: Class-A evidence MUST contain session-specific causal correlation
- **FR-INV-005**: Weak heuristics MUST NOT be silently promoted to causal evidence
- **FR-INV-006**: Production-eligible canaries MUST NOT degrade ordinary accessibility semantics
- **FR-INV-007**: Canary actions MUST be harmless, local to the research flow, and reversible

## Quick Start

```bash
git clone <repo>
cd FireRaid
npm install

# Set up secrets
cp .env.example .dev.vars
# Edit .dev.vars with real values (or use the test defaults)

# Create local D1 database
npx wrangler d1 create fireraid
# Update wrangler.jsonc database_id with the returned ID
npx wrangler d1 execute fireraid --local --file=./migrations/0001_initial.sql

# Run locally
npx wrangler dev
```

Then open http://localhost:8787/signup

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
npm run experiment -- --agent raw-dom --model model-a --runs 100
npm run analyze           # Compute rates + confidence intervals
```

## Repository Layout

```
src/            Worker source (defense plane)
  core/         Profile engine, catalog, correlation, decision
  routes/       HTTP handlers (signup, submit, canary, telemetry, health)
  security/     CSRF, cookies, headers
  turnstile/    Turnstile verification
harness/        Attack/research plane
  core/         Runner, adapter interface, recorder
  adapters/     Human control, raw-DOM, Browser Use, Playwright MCP
  extractors/   HTML, simplified DOM, accessibility
  experiments/  Declarative manifests
  results/      Structured run output
  analysis/     Python stats + confidence intervals
public/         Static signup + admin pages
migrations/     D1 schema
tests/          Unit, integration, e2e, accessibility
docs/           Architecture, integration, threat model
```

## License

TBD
