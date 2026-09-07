/**
 * FR-DEMO-03 — per-run seeded RNG for behavior-parameterized adapters.
 *
 * The humanized adapter previously mutated a MODULE-GLOBAL rngState. The
 * paired demo drives CONTROL and FIRERAID arms CONCURRENTLY, so both arms
 * interleaved mutations of one shared state — the "same humanized actor
 * configuration" claim was false at the timing level (each arm's cadence
 * depended on scheduler interleaving), and run 2 began from whatever state
 * run 1 left behind.
 *
 * A SeededRng is owned by ONE run. The demo derives the seed from the
 * trial id (hash(trialId)) and gives the SAME seed to both arms: the arms
 * are then independent (no shared mutable state) but identically
 * parameterized (same generated timing sequence) — actually paired.
 */

/** Deterministic xorshift32 → unit interval, instance-owned state. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    // Avoid the all-zero fixed point (xorshift of 0 is 0 forever).
    this.state = (seed >>> 0) || 0x2f6e2b1;
  }

  /** Next draw in [0, 1). */
  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s >>> 0;
    // FR-DEMO-12: divide by 2^32, not 0xffffffff — the uint32 state CAN be
    // 0xffffffff, and `0xffffffff / 0xffffffff` returned 1.0, escaping the
    // documented [0, 1) range (an off-by-one that could, e.g., push a
    // jitter or threshold draw past its bound).
    return this.state / 0x100000000;
  }

  /** Jittered delay: base ± spread (centered), humanish integer ms. */
  jitter(base: number, spread: number): number {
    return Math.max(0, Math.round(base + (this.next() - 0.5) * 2 * spread));
  }
}

/** FNV-1a — a stable string → u32 seed (same trial id ⇒ same behavior). */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
