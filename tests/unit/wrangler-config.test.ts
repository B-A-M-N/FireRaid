/**
 * FR-P0-15: the retention cron must be declared in wrangler.jsonc for the
 * top-level worker AND every named environment. The scheduled handler exists
 * (src/index.ts) but does nothing unless a trigger publishes it — an env
 * block that forgets `triggers.crons` would silently drop retention +
 * lab-run sweeps on that deployment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("wrangler.jsonc triggers (FR-P0-15)", () => {
  const raw = readFileSync(join(__dirname, "..", "..", "wrangler.jsonc"), "utf-8");
  // Strip // comments (no /* */ or // inside string values in this file).
  const cfg = JSON.parse(raw.replace(/\/\/[^\n]*/g, "")) as {
    triggers?: { crons?: string[] };
    env: Record<string, {
      triggers?: { crons?: string[] };
      d1_databases?: Array<{ binding?: string }>;
    }>;
  };

  it("top-level worker declares a cron trigger", () => {
    expect(cfg.triggers?.crons).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\d+ \d+ \* \* \*$/)])
    );
  });

  it("every named environment restates the cron", () => {
    const envs = Object.entries(cfg.env);
    expect(envs.length).toBeGreaterThan(0);
    for (const [name, env] of envs) {
      expect(env.triggers?.crons, `env ${name}`).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\d+ \d+ \* \* \*$/)])
      );
    }
  });

  it("every environment also restates the DB binding (inheritance guard)", () => {
    for (const [name, env] of Object.entries(cfg.env)) {
      expect(env.d1_databases?.[0]?.binding, `env ${name}`).toBe("DB");
    }
  });
});
