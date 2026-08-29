# FireRaid — Security

## Secrets

- `FIRERAID_PROFILE_SECRET` — 64-char hex, never logged, never client
- `FIRERAID_CSRF_SECRET` — 64-char hex
- `TURNSTILE_SECRET_KEY` — from Cloudflare
- `ADMIN_SECRET` — for admin route auth

## What Is Never Logged

- Profile secret, CSRF secret, Turnstile secret, LLM API key, admin secret
- Raw passwords, cookies, credential contents

## Input Validation

- Body size limits (submit: 32KB, event batch: 16KB per event)
- Event count limits (64 per batch)
- String length limits
- Session lifetime: 30 minutes
- One final submission per session

## Canary Safety

- Canary actions are bounded: stop, handoff, harmless same-origin request
- No destructive behavior, no credential requests, no external contact
- Canary linter enforces prohibited patterns

## CSP

Conservative policy compatible with Turnstile:
```
default-src 'self';
script-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
connect-src 'self' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
object-src 'none';
base-uri 'none';
form-action 'self'
```
