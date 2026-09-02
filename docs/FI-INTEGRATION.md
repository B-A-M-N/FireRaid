# FreeInference Reference Integration

## Context

FreeInference.org needs better resistance against autonomous agents registering accounts. FireRaid provides a deterministic, measurable defense layer.

## Integration Boundary

```
FI signup GET
    │
    ▼
FireRaid session/profile
    │
    ▼
FI page rendering (inject canary/decoy markup)
    │
    ▼
FireRaid instrumentation (telemetry JS)
    │
    ▼
FI signup POST
    ├── existing validation
    ├── existing abuse controls
    ├── Turnstile
    └── FireRaid evidence
            │
            ▼
    admission decision (see "Decision layers" below)
```

## Decision layers

FireRaid's admission output has THREE distinct layers. Integrators should not
collapse them into one enum:

1. **Core disposition** — the engine's verdict on the evidence record
   (`src/types/event.ts`):
   `ACCEPT | REVIEW | QUARANTINE | REJECT_TURNSTILE | INVALID_SESSION`.
   This is the causal-evidence verdict. There is no "VERIFY" disposition:
   "verify the applicant further" is a HOST workflow action, expressed
   through the risk tier's recommended action, not a core verdict.

2. **Risk tier + recommended action** — `projectRisk` maps the evidence
   score to a tier (`LOW / ELEVATED / HIGH / CAUSAL`) with a
   `recommendedAction` (`CONTINUE / MANUAL_REVIEW / SUPPRESS_AUTO_APPROVAL
   / QUARANTINE`). This is advisory guidance for the host's workflow; it
   does not itself block the request.

3. **Runtime (enforcement) disposition** — `resolveRuntimeDisposition`
   combines the core disposition with the host's enforcement mode:
   - `advisory` mode → always `ACCEPT` (log only)
   - `enforcement` mode → auto-suppress tiers become `QUARANTINE`
   - `review` mode (and non-auto-suppress enforcement tiers) → core
     verdict, with `QUARANTINE` downgraded to `REVIEW`
   This is what the admission hook actually receives at request time.

## Recommended Production Behavior

Map the runtime disposition (layer 3), informed by the tier (layer 2):

- **Class A causal evidence** (core `REVIEW`/`QUARANTINE`, tier `CAUSAL`)
  → host-side verification/review queue (extra verification step, manual
  approval) — not a permanent ban
- **Turnstile failure** (`REJECT_TURNSTILE`) → retry/reject
- **Invalid session** (`INVALID_SESSION`) → reject and reissue
- **Weak behavior only** (tier `ELEVATED`/`HIGH`) → log or request extra
  verification
- **Nothing interesting** (`ACCEPT`, tier `LOW`) → normal signup

## What FI Needs to Provide

1. A secret key (`FIRERAID_PROFILE_SECRET`) — 64-char hex
2. A CSRF secret (`FIRERAID_CSRF_SECRET`) — 64-char hex
3. Turnstile credentials (or use FireRaid's)
4. A session store (or use FireRaid's cookie-based sessions)
5. An admission hook that respects FireRaid's runtime disposition
   (layer 3 above), consulting the recommended action (layer 2)

## What FI Does NOT Need

- FireRaid admin UI
- Browser Use / Playwright MCP
- Research harness
- Experiment framework

## Deliverables

1. Working local demo
2. Public lab deployment
3. Agent attack harness
4. Repeatable experiments
5. Raw results + aggregate analysis
6. Accessibility controls
7. False-positive controls
8. Integration guidance
9. Small reusable core
