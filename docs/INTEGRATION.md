# FireRaid Integration Guide

## For an Arbitrary Website

FireRaid exposes a framework-independent core. A non-Cloudflare deployment can use the defense logic directly:

```ts
import { deriveProfile, correlate, decide } from "fireraid-core";

// 1. Create session (use your own session store)
const sessionId = generateSecureId();

// 2. Derive deterministic profile
const profile = await deriveProfile({
  secret: process.env.FIRERAID_PROFILE_SECRET,
  version: 1,
  sessionId,
});

// 3. Render — inject canary/decoy into your HTML
const html = renderSignupPage({ html: template, profile, csrfToken });

// 4. On submission — correlate observations
const evidence = correlate(profile, observations);
const decision = decide(evidence);
```

## Integration Points

| Step | What FireRaid Needs | What You Provide |
|------|---------------------|------------------|
| Session | Opaque ID + cookie | Your session store |
| Profile | Secret + version | Your secret management |
| Render | HTML template | Your page markup |
| Submit | Observations (canary hit, decoy, telemetry) | Your form handler |
| Decision | Evidence[] → Disposition | Your admission logic |

## Cloudflare Adapter

The Cloudflare Worker is the first adapter. It handles:
- Session cookies
- D1 persistence
- Turnstile verification
- Static asset serving

## FI Integration

See [FI-INTEGRATION.md](./FI-INTEGRATION.md) for the FreeInference reference integration.
