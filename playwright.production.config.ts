/**
 * PRODUCTION-PLANE browser acceptance (P1, P0-AUDIT-3).
 *
 * The lab suite (playwright.config.ts) boots LAB_MODE=true — it proves
 * broad browser functionality but NOT the actual production treatment.
 * This config boots wrangler env `production-test`:
 *   - LAB_MODE=false (the production plane: stateless envelopes, inert
 *     multi-spot carriers, no lab banner, no presentation signatures)
 *   - TURNSTILE_MODE=disabled-test (tracked, explicit Turnstile-off
 *     opt-in; validateConfig rejects it alongside real credentials)
 *   - synthetic secrets injected by scripts/test-worker.mjs (no
 *     .dev.vars.production dependency)
 *   - fresh migrated D1 per run
 *
 * Run: npm run test:e2e:production
 * (FIRERAID_E2E_PRODUCTION_PORT overrides the default port 9998 when an
 * unrelated listener holds it — test-worker.mjs refuses occupied ports.)
 */
import { defineConfig, devices } from "@playwright/test";

// Overridable so the suite can dodge an unrelated listener on the default
// port (test-worker.mjs refuses occupied ports rather than reusing them —
// P0-AUDIT-4). Port and webServer command must stay in lockstep.
const PORT = Number(process.env.FIRERAID_E2E_PRODUCTION_PORT ?? 9998);
const BASE = `https://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // ONLY the production-plane spec — the lab spec asserts the lab banner,
  // which must be ABSENT here.
  testMatch: "**/production-plane.spec.ts",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "harness/results/e2e-production-report.json" }]],
  use: {
    // HTTPS (wrangler self-signed) so WebKit accepts __Host- Secure cookies
    // on loopback — same reasoning as the lab suite.
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // Dedicated port + suite persistence; production-test env, HTTPS for
    // __Host- cookies across all browsers.
    command: `node scripts/test-worker.mjs --suite test-e2e-production --port ${PORT} --https --wrangler-env production-test`,
    url: `${BASE}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    // 180s: fresh D1 migration + first workerd boot on a loaded machine can
    // exceed 120s (observed once under CPU contention from unrelated
    // processes). Better to wait than to kill a healthy boot mid-migration.
    timeout: 180000,
  },
});
