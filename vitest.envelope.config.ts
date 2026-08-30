/// <reference types="@cloudflare/workers-types" />
// FR-P1-19: production-mode envelope spec. Sibling of
// vitest.integration.config.ts — that config excludes this spec (the lab-mode
// worker has no envelope path); this one includes ONLY it.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    include: ["tests/integration/session-envelope-flow.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
