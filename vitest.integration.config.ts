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
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
