# FireRaid Integration Guide

## For an Arbitrary Website

FireRaid's defense core is framework-independent — `src/core/` has no
Cloudflare imports. The names below are the real exports; a non-Cloudflare
deployment can use them directly (FR-R6-091):

```ts
import {
  deriveProfilePure,      // src/core/profile.ts — pure (no Env), host supplies secret/mode
  renderSignupPage,       // src/core/renderer.ts — injects defenses into your HTML
  correlate,              // src/core/correlation.ts — observations → Evidence[]
  decide,                 // src/core/decision.ts — Evidence[] → DecisionRecord
  DEFAULT_POLICY,         // src/core/decision.ts — scoring policy
} from "./src/core/…";    // one module per import — there is no barrel today (FR-R6-092)

// 1. Create session (use your own session store)
const sessionId = generateSecureId(); // your crypto

// 2. Derive deterministic profile — PURE API, no Cloudflare Env required.
//    mode: "lab" enables lab-only recipes; production deployments pass "production".
//    recipe (optional) pins an exact ablation condition (validated fail-closed).
const profile = await deriveProfilePure({
  secret: process.env.FIRERAID_PROFILE_SECRET!,
  version: 1,
  sessionId,
  mode: "production",
});

// 3. Render — inject canary/decoy/CSRF/client-config into your page HTML
const html = renderSignupPage({
  html: yourSignupHtml,   // must contain a </form> (injection anchor)
  profile,
  csrfToken,              // your CSRF token
  labMode: false,
});

// 4. On submission — correlate observations against the SAME profile
const evidence = await correlate(profile, observations);
const decision = decide(evidence, DEFAULT_POLICY);
// decision.disposition: "ACCEPT" | "REVIEW" | "QUARANTINE"
```

What `observations` must contain (`ObservationSet`, `src/core/correlation.ts`):
`canaryEndpointHit`, `decoyFieldMatchesNonce`, `canaryReferencedInTelemetry`,
plus harness annotations (ignored by production hosts). Every field is
server-side truth — never trust client-reported verdicts.

### Key invariants to preserve in a host integration

1. **Determinism**: the same `(secret, version, sessionId)` must derive the
   same profile for render AND submit — correlate against the profile derived
   from the session, not a re-roll.
2. **Fail-closed recipes**: `deriveProfilePure` throws (`INVALID_RECIPE`,
   lab-only-in-production) on ineligible overrides. Do not catch-and-fallback
   to a default recipe — that would assign treatment the system cannot prove.
3. **Split disposition**: `decide()` is advisory scoring. Quarantine decisions
   should still store the submission (or reject it deliberately) — FireRaid
   records the disposition and finalizes the session exactly once.

## Integration Points

| Step | What FireRaid Needs | What You Provide |
|------|---------------------|------------------|
| Session | Opaque ID + cookie | Your session store |
| Profile | Secret + version + mode | Your secret management |
| Render | HTML template with `</form>` | Your page markup |
| Submit | Observations (canary hit, decoy, telemetry) | Your form handler |
| Decision | Evidence[] → Disposition | Your admission logic |

## Cloudflare Adapter

The Cloudflare Worker (`src/` outside `src/core/`) is the first adapter. It adds:
- `__Host-fr_sid` session cookies
- D1 persistence (sessions, submissions, telemetry, lab runs)
- Turnstile verification
- Static asset serving with `style-src 'self'` CSP
- Lab-run binding (`/api/lab/*`, bearer-gated)

## Generic Renderer Contract

`src/core/renderer-interface.ts` defines the host-agnostic `Renderer`
interface (`DefenseArtifacts` → injected page). It is currently
aspirational — the Cloudflare adapter uses `renderSignupPage` directly
(FR-R6-093). New host adapters may target `Renderer`, but no runtime
dispatches through it yet.

## FI Integration

See [FI-INTEGRATION.md](./FI-INTEGRATION.md) for the FreeInference reference integration.
