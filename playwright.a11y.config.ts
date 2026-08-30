import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/accessibility",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // HTTPS + ignoreHTTPSErrors: WebKit-safe __Host- cookie semantics; also
    // lets the pinned lab-bind tests run over the same origin policy.
    baseURL: "https://localhost:9998",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // FR-R5-001: fresh migrated D1 per run — never ambient .wrangler state.
    command: "node scripts/test-worker.mjs --suite test-a11y --port 9998 --https",
    url: "https://localhost:9998/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 90000,
  },
});
