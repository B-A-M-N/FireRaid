/**
 * FireRaid paired demo — shared types + the demo's one source of truth.
 *
 * WHAT IS REAL HERE (do not mock any of it):
 *   - the upstream is scripts/ledger-upstream.mjs UNCHANGED: an ordinary
 *     signup app with its own in-memory account ledger and a READ-ONLY
 *     probe (GET /api/ledger?email=). It imports nothing from src/.
 *   - the FireRaid origin runs the REAL host middleware through
 *     createEvaluationOriginServer (volatile stores — the sanctioned
 *     local wiring), the PRODUCTION random composition (no recipe), and
 *     enforcement mode (non-ACCEPT decisions do not forward).
 *   - the agent is the harness's fill-everything adapter; the "human"
 *     is the harness's humanized-pw adapter (a HUMAN SIMULATION — the
 *     dashboard says so, per the demo-honesty rule).
 *
 * THE ONE RULE: trial truth (CREATED / BLOCKED / INCONCLUSIVE) comes ONLY
 * from the upstream ledger probe. FireRaid's own disposition is displayed
 * as FireRaid's decision, never as the ground-truth answer. A ledger probe
 * failure is INCONCLUSIVE, never BLOCKED.
 */

/** Semantic events the coordinator streams to the dashboard (SSE). */
export type DemoEventName =
  | "trial.started"
  | "actor.started"
  | "page.loaded"
  | "form.fill.started"
  | "form.fill.progress"
  | "form.submitted"
  | "canary.requested"
  | "fireraid.decision"
  | "upstream.requested"
  | "upstream.account.created"
  | "ledger.checked"
  | "trial.completed"
  | "trial.error";

export interface DemoEvent {
  trialId: string;
  /** "control" | "fireraid" — which arm the event belongs to. */
  arm: "control" | "fireraid";
  name: DemoEventName;
  /** Human-readable detail (one line). */
  detail?: string;
  /** Seconds since trial start (set by the coordinator). */
  t?: number;
}

/**
 * Trial outcome. CREATED/BLOCKED are LEDGER facts; anything that cannot be
 * verified from the ledger is ERROR or INCONCLUSIVE — never BLOCKED.
 */
export type TrialOutcome = "CREATED" | "BLOCKED" | "ERROR" | "INCONCLUSIVE";

/** FireRaid's decision as observed by the demo coordinator (operator data). */
export interface FireraidDecision {
  disposition?: string;
  score?: number;
  tier?: string;
  /** Evidence rows (class/source/weight/verified/description). */
  evidence: Array<{
    class: "A" | "B" | "C";
    source: string;
    weight: number;
    verified: boolean;
    description: string;
  }>;
}

/** The completed-trial record the dashboard renders. */
export interface TrialRecord {
  trialId: string;
  actor: "agent" | "human";
  startedAt: number;
  finishedAt?: number;
  control: { email: string; outcome: TrialOutcome; detail?: string };
  fireraid: {
    email: string;
    outcome: TrialOutcome;
    detail?: string;
    sessionId?: string;
    decision?: FireraidDecision;
  };
}

/** Emails are the ledger join key: one identity per (trial, arm). */
export function trialEmails(trialId: string): { control: string; fireraid: string } {
  return {
    control: `${trialId}-control@example.invalid`,
    fireraid: `${trialId}-fireraid@example.invalid`,
  };
}
