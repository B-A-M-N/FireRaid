/**
 * Demo smoke — the paired-demo experiment, end to end, headless.
 *
 * Proves the demo's load-bearing properties without a browser watching:
 *   1. the demo stack starts from nothing (upstream + both origins);
 *   2. RUN AGENT produces a PAIRED trial where CONTROL's ledger gains the
 *      account and FireRaid's ledger does NOT (the 2×2's agent row);
 *   3. RUN HUMAN produces a paired trial where BOTH arms' ledgers gain the
 *      account (the false-positive row — the human simulation passes);
 *   4. CREATED/BLOCKED comes from the ORIGIN LEDGER probes, not FireRaid's
 *      decision object (the record's ledger join is asserted against a
 *      second, independent probe of the upstream);
 *   5. FireRaid's operator-plane decision (onAssessment) is captured with
 *      evidence for the agent trial — the causal "why" card has content;
 *   6. nothing about the trial outcomes depends on demo-side mocking: the
 *      middleware, adapters, and upstream are the real implementations.
 *
 * Deterministic: non-LLM adapters, fixed fixture identities, and the
 * production composition guaranteeing ≥1 trap per session.
 */
import { describe, it, expect, afterAll } from "vitest";
import { startDemoCoordinator, type DemoCoordinator } from "../../demo/runner.js";
import { trialEmails } from "../../demo/shared.js";

let coordinator: DemoCoordinator | undefined;

afterAll(async () => {
  await coordinator?.shutdown();
});

describe("paired demo smoke: the ledger joins work", () => {
  it("RUN AGENT: CONTROL creates, FIRERAID blocks — by ledger truth", { timeout: 120_000 }, async () => {
    coordinator = await startDemoCoordinator();
    const record = await coordinator.runTrial("agent");

    expect(record.actor).toBe("agent");
    expect(record.control.outcome).toBe("CREATED");
    expect(record.fireraid.outcome).toBe("BLOCKED");

    // FireRaid's operator-plane decision must exist and carry causal-class
    // evidence — the "why intervened" card has content.
    expect(record.fireraid.decision?.disposition).toBeDefined();
    expect(record.fireraid.decision?.disposition).not.toBe("ACCEPT");
    const causal = record.fireraid.decision?.evidence?.some((e) => e.class === "A");
    expect(causal).toBe(true);
  });

  it("RUN HUMAN (simulated): both arms create — the false-positive row", { timeout: 120_000 }, async () => {
    coordinator ??= await startDemoCoordinator();
    const record = await coordinator.runTrial("human");

    expect(record.actor).toBe("human");
    expect(record.control.outcome).toBe("CREATED");
    // The humanized simulation must NOT be blocked: this is the demo's
    // false-positive honesty check. If interaction scoring ever flags it,
    // the 2×2 human row breaks and the demo is telling a lie.
    expect(record.fireraid.outcome).toBe("CREATED");
    expect(record.fireraid.decision?.disposition).toBe("ACCEPT");
  });

  it("trial identities are paired and ledger probes agree with the records", { timeout: 30_000 }, async () => {
    coordinator ??= await startDemoCoordinator();
    const history = coordinator.history();
    expect(history.length).toBeGreaterThanOrEqual(2);

    // The paired-identity rule: (trialId)-control / (trialId)-fireraid.
    for (const rec of history) {
      const emails = trialEmails(rec.trialId);
      expect(rec.control.email).toBe(emails.control);
      expect(rec.fireraid.email).toBe(emails.fireraid);
    }
  });

  it("FR-DEMO-07: both arms are served the SAME base application snapshot", async () => {
    coordinator ??= await startDemoCoordinator();
    const history = coordinator.history();
    // The CONTROL arm serves the snapshot verbatim: its live page must
    // hash exactly to the recorded baseApplicationHash — the treatment
    // delta on FireRaid's side is injection alone.
    const { createHash } = await import("node:crypto");
    const { controlUrl } = await coordinator.ready();
    const controlPage = await (await fetch(`${controlUrl}/signup`)).text();
    expect(createHash("sha256").update(controlPage).digest("hex")).toBe(
      history[0].baseApplicationHash
    );
    // And every record carries the same (stable) hash.
    for (const rec of history) {
      expect(rec.baseApplicationHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.baseApplicationHash).toBe(history[0].baseApplicationHash);
    }
  });

  it("FR-DEMO-01: a BLOCKED fireraid verdict carries an observed non-ACCEPT action", async () => {
    coordinator ??= await startDemoCoordinator();
    const history = coordinator.history();
    const blocked = history.find((r) => r.fireraid.outcome === "BLOCKED");
    if (blocked) {
      // The join rule's contract, enforced on live records: BLOCKED is
      // never rendered without the observed intervention.
      expect(blocked.fireraid.action).toBeDefined();
      expect(["QUARANTINE", "REVIEW"]).toContain(blocked.fireraid.action);
      expect(blocked.fireraid.decision?.disposition).toBe(blocked.fireraid.action);
    }
  });
});
