import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "harness/results/e2e-report.json" }]],
  use: {
    baseURL: "http://localhost:9999",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npx wrangler dev --port 9999",
    url: "http://localhost:9999/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
