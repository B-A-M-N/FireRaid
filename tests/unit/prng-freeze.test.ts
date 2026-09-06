/**
 * FR-P0-04 (rereview P2) — the v1 PRNG is FROZEN, not live.
 *
 * profile/v1.ts must derive from profile/prng-v1.ts (the verbatim snapshot
 * taken at the v1 freeze), never from the live core/prng.ts — otherwise a
 * future PRNG change (counter width, rejection sampling, domain labeling)
 * silently redefines what every issued v1 session reconstructs to. The goldens
 * pin BEHAVIOR; this test pins the FREEZE STRUCTURE that makes the goldens
 * meaningful across future edits: the frozen engine's module graph reaches
 * the live prng nowhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core");

/** The frozen engine plus the frozen modules it may pull in. */
const FROZEN_FILES = [
  join(CORE, "profile", "v1.ts"),
  join(CORE, "profile", "catalog-v1.ts"),
  join(CORE, "profile", "prng-v1.ts"),
];

describe("v1 PRNG freeze structure", () => {
  it("no frozen v1 module imports the LIVE prng (./prng.js or ../prng.js)", () => {
    for (const file of FROZEN_FILES) {
      const src = readFileSync(file, "utf-8");
      expect(src, `${file} must not import the live prng`).not.toMatch(
        /from\s+["']\.\.?\/prng\.js["']/
      );
    }
  });

  it("the frozen engine imports the frozen PRNG snapshot", () => {
    const src = readFileSync(FROZEN_FILES[0], "utf-8");
    expect(src).toMatch(/from\s+["']\.\/prng-v1\.js["']/);
  });

  it("the snapshot exists and still exports the full draw surface v1 uses", async () => {
    // Structural (source) check AND a behavioral equivalence check: today the
    // snapshot must be byte-identical in behavior to the live prng — the
    // goldens depend on it. If the live prng legitimately evolves for v2 this
    // equivalence test is UPDATED AT THE V2 FREEZE, never silently.
    const { SeedStream: LiveStream, deriveSeed: liveDerive } = await import(
      "../../src/core/prng.js"
    );
    const { SeedStream: FrozenStream, deriveSeed: frozenDerive } = await import(
      "../../src/core/profile/prng-v1.js"
    );
    expect(LiveStream).not.toBe(FrozenStream); // genuinely distinct modules
    const secret = "freeze-equivalence-secret-0123456789abcdef";
    const live = await liveDerive(secret, 1, "sess-equiv");
    const frozen = await frozenDerive(secret, 1, "sess-equiv");
    expect(new Uint8Array(frozen)).toEqual(new Uint8Array(live));
    // Same draw sequence from equal roots.
    const ls = new LiveStream(live);
    const fs = new FrozenStream(frozen);
    const lDraws = [await ls.nextInt(1000), await ls.nextInt(97), await ls.nextBytes(12)];
    const fDraws = [await fs.nextInt(1000), await fs.nextInt(97), await fs.nextBytes(12)];
    expect(fDraws).toEqual(lDraws);
  });
});
