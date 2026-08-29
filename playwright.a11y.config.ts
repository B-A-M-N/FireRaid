import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/accessibility",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:44444",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npx wrangler dev --port 44444",
    url: "http://localhost:44444/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
