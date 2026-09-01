# FireRaid Architecture

## Overview

FireRaid is a deterministic, per-session, randomized defense-in-depth middleware
for autonomous-agent admission control. It is deliberately split into two planes:

- **Defense plane**: deterministic, no LLM, auditable, production-eligible
- **Evaluation plane**: uses LLMs, intentionally attacks the product, measures defenses

## Core Primitives

### Session
- Cryptographically random 128-bit ID (`crypto.getRandomValues`)
- Secure cookie: `__Host-fr_sid` (HttpOnly, Secure, SameSite=Strict)
  - Lab mode: bare session id (stateful rows from first request)
  - Production: HMAC-signed envelope (stateless until the first stateful
    action materializes the session row — FR-P1-19)
- 30-minute TTL

### Defense Profile
- Seed: `HMAC-SHA256(profile_secret, version:session_id)`
- Deterministic expansion via domain-separated PRF (HKDF-like byte stream)
- Derives: composition policy, semantic strategy, causal channel, decoy-field strategy, carrier strategy, placement, identifiers, route, nonce, telemetry mask, policy
- Immutable per version

### Defense Families
1. **Semantic canary** — machine-safe invisible instruction (production P01–P04 + evaluation S01–S08)
2. **Decoy field** — session-specific hidden input with opaque hex name
3. **Decoy route** — session-specific `/c/:token` endpoint
4. **Interaction telemetry** — coarse event sequencing

### Evidence Taxonomy
- **Class A (causal)**: correct nonce, correct endpoint, exact acknowledgement
- **Class B (strong behavioral)**: decoy manipulated, non-UI path
- **Class C (weak heuristic)**: fast completion, direct fill, no pointer events

### Decision Engine
- Class A exists → QUARANTINE
- Strong + high score → REVIEW
- Weak only → ACCEPT or REVIEW per policy
- Turnstile failure → explicit path

FireRaid exports recommendations (risk level + recommended action), not binary decisions.
The host integrates with its existing application review workflow.

## Request Lifecycle

```
GET /signup → generate session → derive profile → persist → render HTML with defenses
POST /api/submit → resolve session → CSRF → reconstruct profile → correlate → decide → persist
GET /c/:token → resolve session → verify token → record causal hit → 204
POST /api/events → resolve session → validate batch → persist
```

## Invariants (FR-INV-001 through FR-INV-010)

See [docs/INVARIANTS.md](INVARIANTS.md) for the authoritative full list. These are non-negotiable.
