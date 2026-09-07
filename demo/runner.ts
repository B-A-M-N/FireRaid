/**
 * FireRaid paired demo — the trial coordinator.
 *
 * One runTrial() = one PAIRED experiment: the same actor configuration
 * (same adapter, same fixture identity, SAME behavior seed) drives the
 * CONTROL origin and the FireRaid origin. Events stream to the dashboard
 * over SSE. The final CREATED/BLOCKED verdict for each arm is a LEDGER
 * fact — probed read-only after the run — never FireRaid's own decision
 * object.
 *
 * Actors:
 *   agent — harness/adapters FillEverythingAdapter (the deterministic
 *           omnivorous direct-fill attacker; non-LLM, free, reproducible)
 *   human — harness/adapters HumanizedPwAdapter (a HUMAN SIMULATION:
 *           humanized timing/pointer behavior; the dashboard labels it as
 *           such — it is not a human trial)
 *
 * FR-DEMO-01 discipline: ground truth (the ledger) and the observed
 * FireRaid action are separate facts, joined by joinOutcome(). BLOCKED is
 * rendered ONLY when the ledger probe succeeded, the account is absent,
 * AND the FireRaid assessment was observed with a non-ACCEPT terminal
 * decision. A missing assessment or a failed probe is INCONCLUSIVE —
 * never BLOCKED. Adapter errors are ERROR; a dropped submit (no response
 * observed) with an absent account is INCONCLUSIVE.
 *
 * FR-DEMO-02: the timeline streams LIVE observations — the adapters emit
 * at the actual event point through the AgentRunObserver, not post-run
 * reconstructions.
 *
 * FR-DEMO-03: both arms share ONE behavior seed (trialBehaviorSeed) —
 * independently-owned per-run RNGs, identically parameterized.
 *
 * INCONCLUSIVE discipline: a ledger probe failure (null) yields
 * INCONCLUSIVE for that arm — never BLOCKED.
 */
import { FillEverythingAdapter } from "../harness/adapters/fill-everything.js";
import { HumanizedPwAdapter } from "../harness/adapters/humanized-pw.js";
import type { Scenario } from "../harness/core/run-schema.js";
import { startDemoOrigins, type DemoOrigins } from "./origins.js";
import {
  joinOutcome,
  trialBehaviorSeed,
  trialEmails,
  type DemoEvent,
  type FireRaidAction,
  type GroundTruth,
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
  /**
   * FR-DEMO-05: ATOMIC trial admission. Either the slot is taken
   * ({accepted: true, done}) or refused ({accepted: false}) — a caller can
   * never acknowledge a run the coordinator then rejects.
   */
  tryRunTrial(
    actor: "agent" | "human"
  ): { accepted: true; done: Promise<TrialRecord> } | { accepted: false };
  history(): TrialRecord[];
  subscribe(fn: (e: DemoEvent) => void): () => void;
  ready(): Promise<{ controlUrl: string; fireraidUrl: string }>;
  shutdown(): Promise<void>;
}

/** FR-DEMO-08: bound the trial history. */
const MAX_HISTORY = 100;

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
   * adapter launches its own browser; the observer emits events AT THE
   * EVENT POINT (FR-DEMO-02), so the timeline is causally ordered.
   */
  async function driveArm(
    arm: "control" | "fireraid",
    actor: "agent" | "human",
    trialId: string,
    onEvent: (name: DemoEvent["name"], detail?: string) => void
  ): Promise<
    | { ok: true; submitPosted: boolean; submitResponded: boolean }
    | { ok: false; error: string }
  > {
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
      fixtureId: trialBehaviorSeed(trialId), // FR-DEMO-03: shared seed
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
      const result = await adapter.run(scenario, {
        // FR-DEMO-10: browser.started is now a REAL event — emitted at the
        // actual chromium launch inside the humanized adapter, not a
        // declared-but-never-emitted enum member.
        onBrowserStarted: () => onEvent("browser.started", "browser launched (humanized filler)"),
        onPageLoaded: (url) => onEvent("page.loaded", url),
        onFillStarted: () => onEvent("form.fill.started", undefined),
        onCanaryRequested: (url) =>
          arm === "fireraid"
            ? onEvent("canary.requested", `agent fetched the session's decoy route (${url})`)
            : undefined,
        // FR-DEMO-09: ONE form.submitted event per trial. The old wiring
        // emitted it twice for the same POST — once from the
        // onSubmitDispatched callback ("dispatched") and once after the
        // run returned (with the elapsed time) — double-counting the
        // submit in the timeline.
        onSubmitResponse: (status) =>
          onEvent(
            "form.response",
            status === "received" ? "submit response received" : "no submit response observed"
          ),
      });
      if (result.outcome === "error") {
        return { ok: false, error: result.errorMessage ?? "adapter error" };
      }
      onEvent("form.fill.progress", `${result.actionCount} actions`);
      const submitPosted = result.submitPosted === true;
      const submitResponded = result.submitResponded === true;
      if (submitPosted) {
        onEvent("form.submitted", `POST /api/submit (${result.elapsedMs}ms)`);
      }
      return { ok: true, submitPosted, submitResponded };
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
      baseApplicationHash: origins.baseApplicationHash, // FR-DEMO-07
      control: { email: emails.control, outcome: "ERROR" },
      fireraid: { email: emails.fireraid, outcome: "ERROR", decision: { evidence: [] } },
    };
    const t0 = Date.now();
    const stamp = (e: DemoEvent): DemoEvent => ({ ...e, t: (Date.now() - t0) / 1000 });

    emit(stamp({ trialId, arm: "control", name: "trial.started", detail: `actor=${actor}` }));
    emit(stamp({ trialId, arm: "fireraid", name: "trial.started" }));

    // ── Drive BOTH arms in parallel (matched configuration, shared seed).
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
    let fireraidAction: FireRaidAction = "UNOBSERVED";
    if (decision) {
      record.fireraid.sessionId = decision.sessionId;
      record.fireraid.decision = {
        disposition: decision.disposition,
        score: decision.score,
        evidence: decision.evidence,
      };
      fireraidAction = (decision.disposition as FireRaidAction | undefined) ?? "UNOBSERVED";
      emit(
        stamp({
          trialId,
          arm: "fireraid",
          name: "fireraid.decision",
          detail: `${decision.disposition ?? "UNKNOWN"} (score ${decision.score ?? "?"})`,
        })
      );
    }

    // ── THE LEDGER IS THE TRUTH (read-only probes, one per arm), joined
    // with the observed defense action per FR-DEMO-01.
    for (const [arm, res, email] of [
      ["control", controlRes, emails.control],
      ["fireraid", fireraidRes, emails.fireraid],
    ] as const) {
      const setArm = (outcome: TrialOutcome, detail?: string): void => {
        if (arm === "control") {
          record.control = { email, outcome, ...(detail !== undefined ? { detail } : {}) };
        } else {
          record.fireraid = {
            ...record.fireraid,
            email,
            outcome,
            ...(detail !== undefined ? { detail } : {}),
            ...(arm === "fireraid" ? { action: fireraidAction } : {}),
          };
        }
      };

      if (!res.ok) {
        // The actor never completed — ERROR, never BLOCKED.
        setArm("ERROR", res.error);
        emit(stamp({ trialId, arm, name: "trial.error", detail: res.error }));
        continue;
      }

      // FR-DEMO-01: a submit that never left the browser cannot have been
      // evaluated — with an absent account that is INCONCLUSIVE, and we
      // skip the probe only for attribution (the probe would tell us
      // nothing about FireRaid's action).
      if (!res.submitPosted) {
        setArm(
          "INCONCLUSIVE",
          "submit POST never observed — cannot attribute the ledger absence to FireRaid"
        );
        emit(stamp({ trialId, arm, name: "trial.error", detail: "submit never dispatched — INCONCLUSIVE" }));
        continue;
      }

      emit(stamp({ trialId, arm, name: "ledger.checked", detail: `probing ${email}` }));
      const exists = await origins.ledgerHasAccount(email);
      const truth: GroundTruth =
        exists === null ? "INCONCLUSIVE" : exists ? "CREATED" : "NOT_CREATED";
      // The CONTROL arm has no middleware — there is no FireRaid action to
      // join; pass UNOBSERVED (joinOutcome treats ACCEPT and UNOBSERVED
      // alike: an absent account without intervention is INCONCLUSIVE).
      const action: FireRaidAction = arm === "fireraid" ? fireraidAction : "UNOBSERVED";
      const outcome = joinOutcome(truth, action);
      const detail =
        truth === "INCONCLUSIVE"
          ? "ledger probe unreachable — INCONCLUSIVE"
          : `account ${exists ? "EXISTS" : "ABSENT"} — ${outcome}`;
      setArm(outcome, detail);
      emit(stamp({ trialId, arm, name: "ledger.checked", detail }));
    }

    record.finishedAt = Date.now();
    // FR-DEMO-08: bound the history.
    history.push(record);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    emit(stamp({ trialId, arm: "control", name: "trial.completed", detail: record.control.outcome }));
    emit(stamp({ trialId, arm: "fireraid", name: "trial.completed", detail: record.fireraid.outcome }));
    return record;
  }

  // FR-DEMO-05: one paired run at a time; the admission slot is atomic.
  let busy = false;
  const tryRunTrial = (
    actor: "agent" | "human"
  ): { accepted: true; done: Promise<TrialRecord> } | { accepted: false } => {
    if (busy) return { accepted: false };
    busy = true;
    const done = runTrial(actor).finally(() => {
      busy = false;
    });
    return { accepted: true, done };
  };

  return {
    runTrial,
    tryRunTrial,
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
