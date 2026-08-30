import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  // FR-R4-052: scope to e2e specs only — prevents Playwright from discovering
  // Vitest unit/integration tests and crashing on vitest internals.
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "harness/results/e2e-report.json" }]],
  use: {
    // HTTPS (wrangler self-signed) so WebKit accepts __Host- Secure cookies
    // on loopback — it does not grant localhost the Secure-cookie exception
    // Chromium/Firefox do. ignoreHTTPSErrors accepts the self-signed cert.
    baseURL: "https://localhost:9999",
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
    command: "node scripts/test-worker.mjs --suite test-e2e --port 9999 --https",
    url: "https://localhost:9999/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 90000,
  },
});
