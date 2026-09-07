# FireRaid Deployment Guide

This document covers deployment operations. For the product contract and
adapter interfaces, see [INTEGRATION.md](INTEGRATION.md). For security
requirements, see [SECURITY.md](SECURITY.md).

## Deployment targets

FireRaid's core is host-neutral. A host can run the middleware on its own
origin without Cloudflare, Workers, or D1. This repository also includes a
Cloudflare Worker and D1 reference deployment used by the owner-hosted
showcase.

The reference deployment is useful for demonstrating the product boundary. It
does not define the requirements for every host, and demo mode is not a
production abuse-control strategy.

## Before deploying

Configure the target environment with:

- durable session, telemetry, canary, and submission stores;
- a production profile key ring and a dedicated CSRF secret;
- a real host-owned or provider-backed verification adapter;
- host routes for the application page, submit endpoint, telemetry, and
  canary prefix;
- an enforcement adapter for the host's upstream action;
- production rate limiting and ordinary abuse operations;
- the required Worker bindings, D1 database, and secrets when using the
  Cloudflare reference.

Production wiring fails closed if required adapters are missing, persistence is
declared volatile, verification is disabled, or the route/profile contract is
inconsistent. Do not bypass those checks to make a deployment start.

## Cloudflare reference commands

From the repository root:

~~~bash
# Owner-hosted showcase path. This explicitly enables demo behavior.
npm run deploy:demo

# Strict production path. Requires the production limiter and release gates.
npm run deploy:production
~~~

The demo path is intended for product inspection with synthetic data. It
intentionally permits the tracked edge-limiter placeholder so the owner-hosted
showcase can run. Replace that value with the operator's authoritative limiter
before using the strict production path for a customer-facing service.

## Database and environment safety

Apply migrations to the exact environment and database that will receive the
deployment. Keep development, demo, staging, and production bindings
separate. Never copy credentials, database identifiers, or live applicant data
into documentation, fixtures, screenshots, or commits.

After deployment, verify the exact deployed Worker version, build SHA,
migration state, health endpoint, signup page, and fail-closed verification
behavior. A successful wrangler deploy alone is not a release smoke test.

## Release checks

Use the fast checks during iteration:

~~~bash
npm run release:verify:fast
~~~

Use the full deterministic checks before a release:

~~~bash
npm run release:verify:full
~~~

The final npm run release:verify gate requires the repository's
release_ready evidence tier. Claim vocabulary and evidence pointers are
maintained in [RELEASE-STATUS.md](RELEASE-STATUS.md) and
[evidence-ledger.json](evidence-ledger.json).

## Operational boundary

FireRaid returns evidence and an admission assessment. The host remains
responsible for approval policy, identity, upstream side effects, rate
limiting, data retention, incident response, and operator reconciliation of
uncertain forwards.
