import { defineConfig, devices } from "@playwright/test";

// Overridable so the suite can dodge an unrelated listener on the default
// port (test-worker.mjs refuses occupied ports rather than reusing them —
// P0-AUDIT-4). Port and webServer command must stay in lockstep.
const PORT = Number(process.env.FIRERAID_E2E_PORT ?? 9999);
const BASE = `https://localhost:${PORT}`;

export default defineConfig({
  // FR-R4-052: scope to e2e specs only — prevents Playwright from discovering
  // Vitest unit/integration tests and crashing on vitest internals.
  testDir: "./tests/e2e",
  // The production plane has its OWN config (playwright.production.config.ts):
  // LAB_MODE=false asserts the lab banner ABSENT, which contradicts this
  // suite's lab banner assertions. Exclude it here so `playwright test` with
  // the default config never discovers it.
  testMatch: "**/*.spec.ts",
  testIgnore: "**/production-plane.spec.ts",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "harness/results/e2e-report.json" }]],
  use: {
    // HTTPS (wrangler self-signed) so WebKit accepts __Host- Secure cookies
    // on loopback — it does not grant localhost the Secure-cookie exception
    // Chromium/Firefox do. ignoreHTTPSErrors accepts the self-signed cert.
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // FR-R5-001: fresh migrated D1 per run — never ambient .wrangler state.
    command: `node scripts/test-worker.mjs --suite test-e2e --port ${PORT} --https`,
    url: `${BASE}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    // 180s: fresh D1 migration + first workerd boot can exceed 90s on a
    // loaded machine (observed under unrelated CPU contention).
    timeout: 180000,
  },
});
