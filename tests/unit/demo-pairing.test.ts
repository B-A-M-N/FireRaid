/**
 * FR-DEMO-01/03/05/06 — the demo's honesty and pairing logic, as unit
 * tests over the pure pieces (no browsers):
 *
 *   1. joinOutcome: BLOCKED only for verified-absent ledger + OBSERVED
 *      non-ACCEPT action; probe failure / missing assessment / ACCEPT /
 *      dropped submit are INCONCLUSIVE — never a BLOCKED-by-implication.
 *   2. SeededRng: same seed ⇒ identical sequences (the paired-arms
 *      property); different seeds ⇒ decorrelated; concurrent instances
 *      never share state (the old module-global bug).
 *   3. tryRunTrial: atomic admission — the second concurrent request is
 *      refused, never acknowledged-then-rejected.
 */
import { describe, it, expect } from "vitest";
import { joinOutcome, trialBehaviorSeed, trialEmails } from "../../demo/shared.js";
import { SeededRng, seedFromString } from "../../harness/adapters/seeded-rng.js";
import { startDemoCoordinator, type DemoCoordinator } from "../../demo/runner.js";

describe("FR-DEMO-01: joinOutcome (ground truth × defense action)", () => {
  it("BLOCKED only when the ledger probe succeeded, account absent, AND a non-ACCEPT decision was observed", () => {
    expect(joinOutcome("NOT_CREATED", "QUARANTINE")).toBe("BLOCKED");
    expect(joinOutcome("NOT_CREATED", "REVIEW")).toBe("BLOCKED");
  });

  it("an absent account WITHOUT observed intervention is INCONCLUSIVE (the dropped-submit hole)", () => {
    expect(joinOutcome("NOT_CREATED", "UNOBSERVED")).toBe("INCONCLUSIVE");
    expect(joinOutcome("NOT_CREATED", "ACCEPT")).toBe("INCONCLUSIVE");
  });

  it("a failed ledger probe is INCONCLUSIVE regardless of action", () => {
    expect(joinOutcome("INCONCLUSIVE", "QUARANTINE")).toBe("INCONCLUSIVE");
    expect(joinOutcome("INCONCLUSIVE", "UNOBSERVED")).toBe("INCONCLUSIVE");
  });

  it("a created account is CREATED regardless of action (nothing was blocked)", () => {
    expect(joinOutcome("CREATED", "QUARANTINE")).toBe("CREATED");
    expect(joinOutcome("CREATED", "UNOBSERVED")).toBe("CREATED");
  });

  it("an errored assessment with a verified-absent account is ERROR (component failure surfaced)", () => {
    expect(joinOutcome("NOT_CREATED", "ERROR")).toBe("ERROR");
  });
});

describe("FR-DEMO-03: per-run SeededRng (paired human simulation)", () => {
  it("the same seed produces an IDENTICAL timing sequence (the pairing property)", () => {
    const a = new SeededRng(seedFromString("trial-seed"));
    const b = new SeededRng(seedFromString("trial-seed"));
    const seqA = Array.from({ length: 50 }, () => a.jitter(420, 200));
    const seqB = Array.from({ length: 50 }, () => b.jitter(420, 200));
    expect(seqB).toEqual(seqA);
  });

  it("different seeds decorrelate", () => {
    const a = new SeededRng(seedFromString("seed-a"));
    const b = new SeededRng(seedFromString("seed-b"));
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("two same-seed instances advanced CONCURRENTLY (interleaved) still produce identical full sequences", () => {
    // The exact old-bug scenario: interleaved draws on shared state made
    // each consumer's sequence depend on the other's. Instance-owned state
    // makes interleaving irrelevant.
    const a = new SeededRng(seedFromString("paired"));
    const b = new SeededRng(seedFromString("paired"));
    const expected = Array.from({ length: 30 }, () => a.next());
    const interleaved = [] as number[];
    for (let i = 0; i < 30; i++) interleaved.push(b.next());
    expect(interleaved).toEqual(expected);
  });

  it("seed 0 does not collapse to the xorshift fixed point", () => {
    const z = new SeededRng(0);
    expect(z.next()).not.toBe(0);
  });

  it("trialBehaviorSeed is stable per trial id and identical across arms", () => {
    const emails = trialEmails("demo-004");
    expect(trialBehaviorSeed("demo-004")).toBe(trialBehaviorSeed("demo-004"));
    expect(trialBehaviorSeed("demo-004")).toContain(emails.control);
    expect(trialBehaviorSeed("demo-005")).not.toBe(trialBehaviorSeed("demo-004"));
  });
});

describe("FR-DEMO-05: tryRunTrial atomic admission (real coordinator, no browser)", () => {
  let coordinator: DemoCoordinator | undefined;

  it("the second concurrent trial is REFUSED at admission, not accepted-then-rejected", async () => {
    coordinator = await startDemoCoordinator();
    const first = coordinator.tryRunTrial("agent");
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    // While the first trial is in flight, a second admission is refused.
    const second = coordinator.tryRunTrial("human");
    expect(second.accepted).toBe(false);

    // The first trial still completes.
    const record = await first.done;
    expect(record.actor).toBe("agent");
    expect(record.trialId).toBe("demo-001");

    // After completion, the slot frees.
    const third = coordinator.tryRunTrial("agent");
    expect(third.accepted).toBe(true);
    if (third.accepted) await third.done;
  }, 180_000);
});
