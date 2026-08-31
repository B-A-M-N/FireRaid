/// <reference types="@cloudflare/workers-types" />
// P1-AUDIT-2 (gate hygiene): the LIVE-model smoke — vision-only +
// fireraid-aware against the real configured OpenRouter model. Opt-in via
// `npm run test:llm-smoke` because each run spends 3+ minutes on real
// network round-trips; the deterministic `test:integration` gate excludes
// this spec. The un-credentialed fail-closed contract for the same adapters
// stays in the always-on llm-attacker-contracts spec.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    include: ["tests/integration/phase-f-llm-attacker-smoke.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    hookTimeout: 30000,
    // Generous: free-tier round-trips run ~30s each and the vision-only
    // loop carries screenshot payloads (found live: 8 steps ≈ 2–5 min).
    testTimeout: 360_000,
  },
});
