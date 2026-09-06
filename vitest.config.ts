/// <reference types="@cloudflare/workers-types" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    // FR-R3-057: Exclude integration tests by default (they require a running worker)
    // The paired-demo smoke is a REAL e2e (browsers + spawned upstream), so it
    // is only included when DEMO_SMOKE=1 — never in the default unit gate.
    include: [
      "tests/unit/**/*.test.ts",
      ...(process.env.DEMO_SMOKE === "1" ? ["tests/demo/**/*.test.ts"] : []),
    ],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
