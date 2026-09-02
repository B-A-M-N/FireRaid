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

- Decoy field names, element IDs, and route tokens are per-session random
  hex tokens with no fixed prefix (the former `fr_<hex>` signature was
  removed; production carriers carry no FireRaid-identifying attribute,
  class, strategy ID, or route prefix — P1 opacity). An adversary who
  knows FireRaid still knows the SHAPE of the defense (some hidden input
  may exist, some same-origin probe route may exist) even though no
  greppable signature survives; per-session values remain unpredictable.
- The canary route prefix is operator-configured (`routes.canaryPrefix`),
  but a route response is an observable origin behavior (distinct status
  class for valid vs invalid tokens) an aware adversary could probe for.
- Semantic-instruction canaries: the production composition DOES deploy
  them (P02/P03/P04 as causal strategies via structurally inert carriers
  invisible to humans), but semantic carry-out evidence is bounded by the
  same unaware-vs-hardened-adversary gap as any prompt-injection channel —
  the causal load-bearing channels remain the decoy route and the
  exact-nonce field, which need no LLM compliance.
- Efficacy against real autonomous agents is not yet established by a
  completed LLM pilot — see POST_FR_R7_STATUS.md ("STILL OPEN").
- `CF-Connecting-IP` is a trusted input ONLY behind an edge that
  overwrites it (Cloudflare). This is CODE-ENFORCED on the host middleware:
  the route config carries `trustedIngress` ("cloudflare" | "direct"), and
  the middleware reads the header ONLY under an explicit
  `"cloudflare"` declaration — the default (`"direct"`, fail-closed) never
  reads it, so a forged header cannot inject an IP into verification on a
  non-Cloudflare origin. The Worker adapter may use it for rate
  limiting / verification remoteip (the Worker IS behind the trusted edge
  by construction). Origin-bypass protection (Internet must not reach the
  origin directly) is FI network policy, not an application invariant.
