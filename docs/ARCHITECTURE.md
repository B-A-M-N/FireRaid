# FireRaid Architecture

## Overview

FireRaid is a research platform for testing automated signup defenses. It is deliberately split into two planes:

- **Defense plane**: deterministic, no LLM, auditable, production-eligible
- **Attack/research plane**: uses LLMs, intentionally attacks the lab, measures defenses

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
- Deterministic expansion via HKDF-like byte stream
- Derives: families, template, placement, nonce, decoy field, endpoint token, telemetry mask
- Immutable per version (FR-INV-011)

### Defense Families
1. **Semantic canary** — hidden/session-specific instructions
2. **Decoy field** — session-specific hidden input
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

## Request Lifecycle

```
GET /signup → generate session → derive profile → persist → render HTML with defenses
POST /api/submit → resolve session → CSRF → reconstruct profile → correlate → decide → persist
GET /c/:token → resolve session → verify token → record causal hit → 204
POST /api/events → resolve session → validate batch → persist
```

## Invariants (FR-INV-001 through FR-INV-010)

See CONCEPT.md §130 for the full list. These are non-negotiable.
