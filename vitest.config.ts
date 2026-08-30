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
    include: ["tests/unit/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
