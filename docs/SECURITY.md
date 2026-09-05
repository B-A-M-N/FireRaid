# FireRaid — Security

## Secrets

- `FIRERAID_PROFILE_SECRET` — 64-char hex, never logged, never client
- `FIRERAID_CSRF_SECRET` — 64-char hex
- `TURNSTILE_SECRET_KEY` — from Cloudflare
- `ADMIN_SECRET` — for admin route auth (HMAC session token; constant-time compare; login rate-limited)

## What Is Never Logged

- Profile secret, CSRF secret, Turnstile secret, LLM API key, admin secret
- Raw passwords, cookies, credential contents

## Input Validation

- Body size limits (submit: 32KB; telemetry batch: 16KB per event)
- Event count limits (256 per batch — the P1-14 bounded submit attaches at
  most ONE client batch to a submission; overflow is a 413, never a silent drop)
- String length limits
- Session lifetime: 30 minutes
- One final submission per session (concurrent losers are constraint-free
  no-ops; exact replays are idempotent via the evidence fingerprint)
- Lab-assignment reads fail closed: an unreadable bound treatment is a 500,
  never a silent random-profile fallback

## Token Comparison

All secret/token comparisons go through ONE constant-time primitive
(`src/core/tokens.ts`); length is folded into the accumulator — comparison
time never leaks token length.

## Retention (P1-10)

- Raw telemetry (`event_batches` payloads — keystroke-level events): 7-day
  default window (`FIRERAID_RAW_TELEMETRY_RETENTION_DAYS`), clamped to at
  most the derived-records window. Raw payloads have no reader after the
  30-minute session TTL; this is the most sensitive data the store holds.
- Derived records (dispositions, evidence, canary hits): 30-day default
  (`FIRERAID_RETENTION_DAYS`). These are the experiment's durable observables.
- The cron sweep (daily) deletes in bounded batches; `/api/admin/cleanup`
  runs the same statements unbounded with `?days=` / `?rawDays=` overrides.

## Canary Safety

- Canary actions are bounded: stop, handoff, harmless same-origin request
- No destructive behavior, no credential requests, no external contact
- Canary linter enforces prohibited patterns

## Production Carrier Opacity

Production rendering carries no FIXED greppable FireRaid presentation
signature (no `data-fr-*` attributes, no `fr-*` class, no strategy IDs,
no FireRaid route prefix in markup; instruction carriers are structurally
inert — bare `<template>`, `<meta name="verification-context">`, HTML
comments). Since P0-7, production decoys hide via a CONSTANT self-contained
inline style (fixture parity: hiding must not depend on a host stylesheet
rule existing); the style string is allowlisted in the CSP via a SHA-256
hash so `style-src` stays restrictive — the `fr-*` hiding classes in
signup.css are a LAB-plane presentation and are stripped from production
markup by `stripFireRaidSignatures`.
Deliberate residuals: decoy field names, element IDs, and route tokens
are per-session random hex tokens (session-specific, unpredictable, but
recognizable in SHAPE to an adversary who knows FireRaid), and the canary
route prefix is operator-configured. Accepted residual (P1-23),
regression-pinned by `tests/unit/production-carrier-opacity.test.ts`.

## HTML Injection Boundaries

Values interpolated into emitted markup pass through
`src/security/html.ts`: `escapeHtml()` for text/attribute contexts
(client script src, Turnstile site key, CSRF token, decoy field names),
`jsonForScriptIsland()` for the client-config `<script
type="application/json">` island (JSON-native `<` escaping, so an
operator-configured endpoint containing `</script>` cannot terminate the
island; `JSON.parse` on the client restores the value losslessly).
Server-internal material (nonce, field name, route token) uses fixed
reviewed alphabets. Pinned by `tests/unit/html-config-escaping.test.ts`.

## CSP

Conservative policy compatible with Turnstile. The constant decoy-hiding
inline style is allowlisted via a SHA-256 hash so `style-src` stays restrictive
(no `'unsafe-inline'`):
```
default-src 'self';
script-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
connect-src 'self' https://challenges.cloudflare.com;
style-src 'self' 'sha256-bR67piDoV29bfjsHPn9ssw5vXmLWyHHw3fPPMv8edFU=';
img-src 'self' data:;
object-src 'none';
base-uri 'none';
form-action 'self'
```

## Supported Versions

FireRaid follows semantic versioning. Security patches are applied to the
latest minor version. The project maintainers can be contacted via the
repository's issue tracker for vulnerability disclosure.

## Vulnerability Reporting

To report a security vulnerability, please open a GitHub issue or contact
the maintainers directly. Do not disclose vulnerabilities publicly until
a fix has been released.
