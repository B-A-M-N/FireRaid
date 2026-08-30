# FR-POST-R6-P10 — Public-lab readiness

## Claim

The public-lab environment is CONFIGURATION-READY and separated from both
FI production and the research test env; the remaining items are deploy-
time actions that require live Cloudflare resources, listed explicitly.

## Verified ready (code/config level)

| Item | Evidence |
|---|---|
| Environment separation | wrangler.jsonc: top-level LAB_MODE=false (bare deploy safe, FR-R4-076/FR-R6-085); named envs dev/test/public-lab/production each restate bindings (FR-R6-001 no inheritance); public-lab has its OWN database name (fireraid-public-lab) distinct from production (fireraid-production) |
| Lab API surface | every lab route returns 404 "lab API disabled in production" when LAB_MODE≠true (lab.ts ×3 sites) |
| Admin protection | all /api/admin/* behind requireAdmin (constant-time secret compare, session tokens) — admin.ts |
| Secret hygiene | .dev.vars / .dev.vars.* / .env all gitignored AND untracked; harness/.env.example documents credential placement; no real credentials in repo |
| Response hygiene | Cache-Control: no-store on Worker responses (headers.ts) |
| Retention | lab runs auto-expire (PENDING→EXPIRED, BOUND→ABANDONED, 24h, expiry sweep on every lab GET; FR-R5-037/FR-R6-013/014) |
| Fail-closed conditions | FR-R6-020 (Turnstile), FR-R6-003 (unreadable recipe), bind fail-closed (FR-R5-005/028) all integration-proven |
| Public smoke gates | e2e 12/12 (normal user zero causal hits), a11y 18/18 — re-run green on the final tree |

## Deploy-time items (need live Cloudflare resources — NOT STARTED by design)

1. `wrangler d1 create fireraid-public-lab` → paste database_id into the
   public-lab env block (placeholder REPLACE_AFTER_CREATE is present and
   clearly marked).
2. `wrangler d1 migrations apply fireraid-public-lab` (0001–0009 chain;
   chain executes cleanly — proven by tests/unit/schema-migration.test.ts
   against fresh SQLite).
3. Set public-lab secrets via `wrangler secret put` (FIRERAID_PROFILE_SECRET,
   FIRERAID_CSRF_SECRET, ADMIN_SECRET, FIRERAID_LAB_API_SECRET) — real
   values, never committed.
4. Optional per-env Turnstile site key/secret if the Turnstile condition
   will be required in public lab.
5. Rate limiting / WAF rules are a Cloudflare dashboard concern (zone
   level) — no application rate limiter is implemented in the Worker; the
   public-lab posture assumes platform-level limits. Explicitly listed as
   an operational requirement, not a code feature.
6. First public-lab deploy smoke: /health, bind flow, submit, admin login
   (E6 — production validation, requires the real deployment).

## Boundary statement (mission: public-lab ≠ FI production)

public-lab is a RESEARCH environment: LAB_MODE=true, lab API enabled,
synthetic fixtures expected. FI production integration remains a separate
tracked workstream (docs/FI-INTEGRATION.md) and is deliberately NOT part
of this phase.

## Status: PROVEN LOCAL (E2/E3, config + tests); PRODUCTION VALIDATION
(E6) blocked on live Cloudflare deployment, which requires the
deploy-time items above.
