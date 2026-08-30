/// <reference types="@cloudflare/workers-types" />
// FR-R4-051: dedicated integration config — `vitest run tests/integration` with the
// root config found no tests because the root include pattern only matches tests/unit.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    // FR-P1-19: the stateless-envelope spec requires the production-mode
    // worker (LAB_MODE=false); it runs via `npm run test:envelope` with
    // --wrangler-env production and would fail against the lab-mode worker
    // here (production cookie shapes don't exist in lab mode).
    exclude: ["tests/integration/session-envelope-flow.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
