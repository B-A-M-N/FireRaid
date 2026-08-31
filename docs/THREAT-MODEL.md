# FireRaid — Threat Model

## T0 — Ordinary Human
Must work normally. The measured claim (P1-18) is NOT "zero false
positives" — it is a Wilson one-sided upper bound on the human
false-positive rate per defended condition, and conditions with no
human-account-creation measurement are reported UNMEASURED, never folded
into a clean-sounding zero.

## T1 — Naïve Automation
Selenium/Playwright filling visible controls. Probed by the harness's
non-LLM attackers: `dom-automation` (visible-inputs filler) and
`humanized-pw` (human-like timing — an honest-human signal control).

## T2 — Raw-DOM LLM Agent
Reads large portions of HTML and lets an LLM reason over it. Primary
semantic-canary target (lab-only surface).

## T3 — Browser Abstraction Agent
Browser Use-like architecture. Primary research target.

## T4 — Accessibility-Tree Agent
Playwright MCP-like architecture. Important contrast target.

## T5 — Hardened Agent
Treats webpage content as untrusted data. Expected to reduce
semantic-canary effectiveness.

## T6 — FireRaid-Aware Adversary
Knows the defense exists and actively filters it. Probed by the harness's
`fireraid-aware` adapter (disclosed-mechanism prompt). Not expected to be
solved completely by v0.1.

## Defense-in-Depth

FireRaid does not claim "hidden prompt = bot protection." The architecture combines:
- Turnstile (independent signal)
- Causal canaries (session-specific, unpredictable)
- Behavioral telemetry (coarse sequencing)
- Server-side correlation (authoritative)

The value is the combination.

## What counts as truth

- The PRIMARY endpoint is whether the ordinary upstream's own account
  ledger contains the synthetic account (origin-ledger experiment). The
  agent's self-reported outcome is never authoritative.
- Effectiveness denominators are server-reconciled runs (never the agent's
  error string); submission truth is the server's reconciled flag.
- Infrastructure failures (FireRaid's own, or the origin's) are excluded
  from the intention-to-treat denominator; agent failures stay in — for an
  admission defense, every one of them ends with no account created.

## Known residuals (accepted, not hidden)

- The profile-bound `fr_<hex>` decoy field name and the `/c/` route prefix
  are recognizable to an adversary who knows FireRaid (session-specific but
  not secret). Accepted in P1-23; production carriers otherwise carry no
  FIXED greppable signature.
- Semantic-instruction canaries are a LAB measurement mechanism only; the
  production thesis is decoy-field + decoy-route + interaction (P1-23).
- Efficacy against real autonomous agents is not yet established by a
  completed LLM pilot — see POST_FR_R7_STATUS.md ("STILL OPEN").
