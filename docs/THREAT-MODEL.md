# FireRaid — Threat Model

## T0 — Ordinary Human
Must work normally. Zero false positives.

## T1 — Naïve Automation
Selenium/Playwright filling visible controls. Likely addressed by Turnstile/behavior signals.

## T2 — Raw-DOM LLM Agent
Reads large portions of HTML and lets an LLM reason over it. Primary semantic-canary target.

## T3 — Browser Abstraction Agent
Browser Use-like architecture. Primary research target.

## T4 — Accessibility-Tree Agent
Playwright MCP-like architecture. Important contrast target.

## T5 — Hardened Agent
Treats webpage content as untrusted data. Expected to reduce semantic-canary effectiveness.

## T6 — FireRaid-Aware Adversary
Knows the defense exists and actively filters it. Not expected to be solved completely by v0.1.

## Defense-in-Depth

FireRaid does not claim "hidden prompt = bot protection." The architecture combines:
- Turnstile (independent signal)
- Causal canaries (session-specific, unpredictable)
- Behavioral telemetry (coarse sequencing)
- Server-side correlation (authoritative)

The value is the combination.
