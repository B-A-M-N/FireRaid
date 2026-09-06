/**
 * FireRaid paired demo — the trial coordinator.
 *
 * One runTrial() = one PAIRED experiment: the same actor configuration
 * (same adapter, same fixture identity) drives the CONTROL origin and the
 * FireRaid origin. Events stream to the dashboard over SSE. The final
 * CREATED/BLOCKED verdict for each arm is a LEDGER fact — probed
 * read-only after the run — never FireRaid's own decision object.
 *
 * Actors:
 *   agent — harness/adapters FillEverythingAdapter (the deterministic
 *           omnivorous direct-fill attacker; non-LLM, free, reproducible)
 *   human — harness/adapters HumanizedPwAdapter (a HUMAN SIMULATION:
 *           humanized timing/pointer behavior; the dashboard labels it as
 *           such — it is not a human trial)
 *
 * INCONCLUSIVE discipline: a ledger probe failure (null) or an adapter
 * error yields ERROR/INCONCLUSIVE for that arm — never BLOCKED. BLOCKED
 * means "the run completed and the upstream ledger has no account for
 * this arm's identity."
 */
import { FillEverythingAdapter } from "../harness/adapters/fill-everything.js";
import { HumanizedPwAdapter } from "../harness/adapters/humanized-pw.js";
import type { Scenario } from "../harness/core/run-schema.js";
import { startDemoOrigins, type DemoOrigins } from "./origins.js";
import {
  trialEmails,
  type DemoEvent,
  type TrialOutcome,
  type TrialRecord,
} from "./shared.js";

const FIXTURE = {
  name: "Casey Example",
  organization: "Example Research",
  intended_use: "Evaluating research access for my team.",
  password: "synthetic-password-123",
};

export interface DemoCoordinator {
  runTrial(actor: "agent" | "human"): Promise<TrialRecord>;
  history(): TrialRecord[];
  subscribe(fn: (e: DemoEvent) => void): () => void;
  ready(): Promise<{ controlUrl: string; fireraidUrl: string }>;
  shutdown(): Promise<void>;
}

export async function startDemoCoordinator(): Promise<DemoCoordinator> {
  const origins: DemoOrigins = await startDemoOrigins();
  const listeners = new Set<(e: DemoEvent) => void>();
  const history: TrialRecord[] = [];
  let trialCounter = 0;

  const emit = (e: DemoEvent) => {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch { /* a broken dashboard stream never fails a trial */ }
    }
  };

  /**
   * Drive one arm: build a fresh Scenario for the harness adapter against
   * the arm's origin and translate the run into timeline events. The
   * adapter launches its own browser; its wire observations (canary GETs,
   * submit POSTs) are already server-adjacent truth.
   */
  async function driveArm(
    arm: "control" | "fireraid",
    actor: "agent" | "human",
    trialId: string,
    onEvent: (name: DemoEvent["name"], detail?: string) => void
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const targetUrl = arm === "control" ? origins.controlUrl : origins.fireraidUrl;
    const email =
      arm === "control"
        ? trialEmails(trialId).control
        : trialEmails(trialId).fireraid;

    const scenario: Scenario = {
      targetUrl,
      fixture: { ...FIXTURE, email },
      promptVariant: "demo",
      objective: "honest",
      fixtureId: trialId,
      model: "none",
      maxSteps: 12,
      timeoutMs: 45_000,
    };

    const adapter =
      actor === "agent" ? new FillEverythingAdapter() : new HumanizedPwAdapter();

    onEvent(
      "actor.started",
      actor === "agent"
        ? "automated agent (fill-everything, non-LLM)"
        : "human simulation (humanized timing — not a human trial)"
    );
    try {
      const result = await adapter.run(scenario);
      if (result.outcome === "error") {
        return { ok: false, error: result.errorMessage ?? "adapter error" };
      }
      onEvent("page.loaded", `${targetUrl}/signup`);
      onEvent("form.fill.started", undefined);
      onEvent("form.fill.progress", `${result.actionCount} actions`);
      if (arm === "fireraid" && result.canaryTriggered) {
        onEvent("canary.requested", "agent fetched the session's decoy route");
      }
      onEvent("form.submitted", `POST /api/submit (${result.elapsedMs}ms)`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function runTrial(actor: "agent" | "human"): Promise<TrialRecord> {
    const trialId = `demo-${String(++trialCounter).padStart(3, "0")}`;
    const emails = trialEmails(trialId);
    const record: TrialRecord = {
      trialId,
      actor,
      startedAt: Date.now(),
      control: { email: emails.control, outcome: "ERROR" },
      fireraid: { email: emails.fireraid, outcome: "ERROR", decision: { evidence: [] } },
    };
    const t0 = Date.now();
    const stamp = (e: DemoEvent): DemoEvent => ({ ...e, t: (Date.now() - t0) / 1000 });

    emit(stamp({ trialId, arm: "control", name: "trial.started", detail: `actor=${actor}` }));
    emit(stamp({ trialId, arm: "fireraid", name: "trial.started" }));

    // ── Drive BOTH arms in parallel (matched configuration).
    const [controlRes, fireraidRes] = await Promise.all([
      driveArm("control", actor, trialId, (name, detail) =>
        emit(stamp({ trialId, arm: "control", name, detail }))
      ),
      driveArm("fireraid", actor, trialId, (name, detail) =>
        emit(stamp({ trialId, arm: "fireraid", name, detail }))
      ),
    ]);

    // ── FireRaid's own decision (OPERATOR PLANE): from the runtime's
    // onAssessment seam, joined by the submitted email. Displayed as
    // FireRaid's decision — never as the ground truth.
    const decision = origins.fireraidDecisionFor(emails.fireraid);
    if (decision) {
      record.fireraid.sessionId = decision.sessionId;
      record.fireraid.decision = {
        disposition: decision.disposition,
        score: decision.score,
        evidence: decision.evidence,
      };
      emit(
        stamp({
          trialId,
          arm: "fireraid",
          name: "fireraid.decision",
          detail: `${decision.disposition ?? "UNKNOWN"} (score ${decision.score ?? "?"})`,
        })
      );
    }

    // ── THE LEDGER IS THE TRUTH (read-only probes, one per arm).
    for (const [arm, res, email] of [
      ["control", controlRes, emails.control],
      ["fireraid", fireraidRes, emails.fireraid],
    ] as const) {
      if (!res.ok) {
        // The actor never completed — ERROR, never BLOCKED.
        if (arm === "control") {
          record.control = { email, outcome: "ERROR", detail: res.error };
        } else {
          record.fireraid = { ...record.fireraid, email, outcome: "ERROR", detail: res.error };
        }
        emit(stamp({ trialId, arm, name: "trial.error", detail: res.error }));
        continue;
      }
      emit(stamp({ trialId, arm, name: "ledger.checked", detail: `probing ${email}` }));
      const exists = await origins.ledgerHasAccount(email);
      if (exists === null) {
        if (arm === "control") {
          record.control = { email, outcome: "INCONCLUSIVE", detail: "ledger probe unreachable" };
        } else {
          record.fireraid = {
            ...record.fireraid,
            email,
            outcome: "INCONCLUSIVE",
            detail: "ledger probe unreachable",
          };
        }
        emit(stamp({ trialId, arm, name: "trial.error", detail: "ledger probe unreachable — INCONCLUSIVE" }));
        continue;
      }
      const outcome: TrialOutcome = exists ? "CREATED" : "BLOCKED";
      if (arm === "control") {
        record.control = { email, outcome };
      } else {
        record.fireraid = { ...record.fireraid, email, outcome };
      }
      emit(
        stamp({
          trialId,
          arm,
          name: "ledger.checked",
          detail: `account ${exists ? "EXISTS" : "ABSENT"} — ${outcome}`,
        })
      );
    }

    record.finishedAt = Date.now();
    history.push(record);
    emit(stamp({ trialId, arm: "control", name: "trial.completed", detail: record.control.outcome }));
    emit(stamp({ trialId, arm: "fireraid", name: "trial.completed", detail: record.fireraid.outcome }));
    return record;
  }

  return {
    runTrial,
    history: () => [...history],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async ready() {
      return { controlUrl: origins.controlUrl, fireraidUrl: origins.fireraidUrl };
    },
    async shutdown() {
      await origins.shutdown();
    },
  };
}
