import { defineConfig, devices } from "@playwright/test";

// Overridable so the suite can dodge an unrelated listener on the default
// port (test-worker.mjs refuses occupied ports rather than reusing them —
// P0-AUDIT-4). Port and webServer command must stay in lockstep.
const PORT = Number(process.env.FIRERAID_A11Y_PORT ?? 9998);
const BASE = `https://localhost:${PORT}`;

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
  ],
  webServer: {
    // FR-R5-001: fresh migrated D1 per run — never ambient .wrangler state.
    command: `node scripts/test-worker.mjs --suite test-a11y --port ${PORT} --https`,
    url: `${BASE}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180000,
    // FR-P0-14: the pinned lab-bind tests derive their lab API base from
    // FIRERAID_TEST_BASE_URL. The a11y webServer command runs with no suite
    // child (Playwright owns the test process), so the bootstrap's suite-env
    // export path never fires — export it here, bound to the SAME port.
    env: {
      ...process.env,
      FIRERAID_TEST_BASE_URL: BASE,
      FIRERAID_TEST_LAB_SECRET: "local-lab-secret-do-not-use-in-prod",
    },
  },
});
