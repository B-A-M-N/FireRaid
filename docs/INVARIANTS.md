# FireRaid — Product Invariants

This document is the authoritative architectural contract for the FireRaid product.
It supersedes all prior documentation when in conflict.

## 1 — What FireRaid Is

FireRaid is a **deterministic, per-session, randomized defense-in-depth middleware**
that sits between a real user (or autonomous agent) and a signup/application form.
It injects a unique combination of invisible traps and behavioral observations into
every session from a server secret, then correlates observed behavior against that
exact combination to classify whether the submitter is a human or an automated system.

## 2 — What FireRaid Is Not

- FireRaid is **not** a research lab. Research and evaluation are subsystems
  of the product, not the product itself.
- FireRaid does **not** require Cloudflare Workers, D1, Wrangler, or any
  specific hosting platform.
- FireRaid does **not** make model (LLM) calls in the defense path.
- FireRaid does **not** determine defense capabilities based on environment
  (production vs. test vs. development).
- FireRaid does **not** own account approval or account ledger management.

## 3 — Architecture

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

The defense core (`src/core/`) is host-neutral: zero Cloudflare imports, zero D1,
zero HTTP forwarding, zero LLM. Everything platform-specific lives outside core.

## 4 — Defense-in-Depth Composition Invariant

Every defended session receives a **coherent defense stack** derived deterministically
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
must never create a weak session consisting entirely of low-confidence heuristics.

### Defense Families

| Family        | What it does                                      | Causal? |
|---------------|---------------------------------------------------|---------|
| semantic      | Machine-safe semantic trap (invisible instruction) | Yes     |
| decoy-field   | Invisible decoy form field                        | Yes (with nonce) / Strong (without) |
| decoy-route   | Hidden same-origin endpoint                       | Yes     |
| interaction   | Coarse interaction telemetry (focus, key, pointer) | Weak   |

**No environment flag removes or adds families.** The family composition is
determined purely by the deterministic PRF over the session secret.

## 5 — Per-Session Randomization Invariant

Every session gets a unique defense stack. No two sessions see the same
combination of trap type, carrier, placement, identifiers, or challenge values.

Randomization uses **domain-separated derivation**, not sequential PRNG:

```
root = HMAC(profileKey, version || sid)

families = PRF(root, "composition")
semantic = PRF(root, "semantic")
nonce    = PRF(root, "semantic-nonce")
field    = PRF(root, "decoy-field")
route    = PRF(root, "decoy-route")
...
```

Adding or removing one derivation dimension does NOT perturb unrelated defenses.

## 6 — Environment Must Not Determine Defense Capability

The environment variable `FIRERAID_ENV` (or `LAB_MODE`) controls:
- Debug output volume
- Logging verbosity
- Test API availability
- Synthetic run binding

It does NOT control which defense families are active. Production and test
see the **same defense artifacts** — test instrumentation may add optional
diagnostic labels, but the actual treatment cannot differ.

## 7 — Product vs. Evaluation Catalog

### Production Defense Catalog

Machine-safe semantic traps that satisfy ALL of:
- Not visible to ordinary human
- Not keyboard reachable
- Not accessibility-tree pollution
- Does not request secrets
- Does not request external navigation
- Does not mutate real state
- Does not make purchases/messages/etc.
- Only invokes harmless same-origin behavior

### Evaluation Probe Catalog

Separate visible disclosure probes, handoff experiments, research controls,
and measurement-only variants used exclusively in the AI evaluation harness.
These attack FireRaid during testing but never appear in production.

## 8 — Admission Risk, Not Account Approval

FireRaid returns an **admission-risk assessment**, not a binary accept/deny
of account creation:

```ts
interface FireRaidAssessment {
  riskScore: number;
  riskTier: "LOW" | "ELEVATED" | "HIGH" | "CAUSAL";
  evidence: Evidence[];
  recommendedAction:
    | "CONTINUE"
    | "MANUAL_REVIEW"
    | "SUPPRESS_AUTO_APPROVAL"
    | "QUARANTINE";
}
```

The host integration (e.g., FreeInference) owns the actual approval workflow.
FireRaid provides evidence; the host decides.

## 9 — Evidence Model

### Class A — Causal (server-verifiable)

Evidence that can ONLY be produced by an autonomous system that:
1. Saw the session-specific trap
2. Acted on it deterministically

Examples:
- `CANARY_ROUTE_MATCH` — requested session-bound route token
- `SESSION_RESPONSE_PROVIDED` — populated the `session_response` actuator sink
  (the route ask binds to this field; only an agent that read the session-bound
  instruction can produce a response there)
- `CANARY_NONCE_REPRODUCED` — placed exact session nonce into decoy field

### Class B — Strong Behavioral

Evidence strongly suggestive but not definitively causal.

### Class C — Weak Heuristic

Evidence that can have legitimate human explanations:
- Fast completion (password managers, autofill)
- No pointer events (keyboard-only, mobile, assistive software)
- Direct fill (pasted fields, browser autofill)
- Zero-dwell fill (focused-then-instant input; E5 interaction-depth lever)
- Uniform input cadence (machine-regular inter-input gaps)
- No blur before submit

**Distinction is preserved:** a Class A event >>> behavioral oddity.

## 10 — False-Postive Posture

The following MUST NOT produce high-confidence agent signals:
- No pointer events
- Fast completion (< 3s)
- Pasted fields
- Direct fill without other signals
- No keyboard input
- Mobile/browser touch patterns

These all happen legitimately via:
- Password managers
- Browser autofill
- Keyboard-only operation
- Mobile browsers
- Assistive software / accessibility automation

## 11 — Evaluation System

The AI evaluation system attacks FireRaid during testing. It includes:
- Raw-DOM LLM agents
- Browser Use agents
- AX snapshot agents
- Vision agents
- FireRaid-aware agents
- Scripted automation
- Human controls

The evaluation system attacks **the same artifacts that production uses**.
The key experiment is:

```
CONTROL (no FireRaid)
vs
exact production FireRaid stack
```

not a special lab vs. a weaker production implementation.

## 12 — Naming Convention

```
lab         → evaluation
lab run     → evaluation run
lab assign  → evaluation assignment
lab API     → evaluation API
LAB_MODE    → FIRERAID_ENV (never affects defense capability)
```

---

**Status:** Effective immediately. Supersedes all prior architectural claims
in README.md, CONCEPT.md, docs/ARCHITECTURE.md, and prior POST_FR_R*-STATUS.md
documents which described the wrong product.
