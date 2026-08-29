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
    ACCEPT / REVIEW / VERIFY / QUARANTINE
```

## Recommended Production Behavior

- **Class A causal evidence** → verification/review queue (not permanent ban)
- **Turnstile failure** → retry/reject
- **Weak behavior only** → log or request extra verification
- **Nothing interesting** → normal signup

## What FI Needs to Provide

1. A secret key (`FIRERAID_PROFILE_SECRET`) — 64-char hex
2. A CSRF secret (`FIRERAID_CSRF_SECRET`) — 64-char hex
3. Turnstile credentials (or use FireRaid's)
4. A session store (or use FireRaid's cookie-based sessions)
5. An admission hook that respects FireRaid's disposition

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
