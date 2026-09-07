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
 *
 * FR-DEMO-01: BLOCKED requires OBSERVED intervention — the submit reached
 * FireRaid, FireRaid evaluated it, and the terminal decision was
 * non-ACCEPT. Ground truth (the ledger) and the defense action are modeled
 * separately and JOINED for display: a session whose submit never arrived
 * (browser break, dropped POST) with an absent account is INCONCLUSIVE —
 * "we cannot tell whether FireRaid blocked it" — never BLOCKED.
 */

/** Semantic events the coordinator streams to the dashboard (SSE). */
export type DemoEventName =
  | "trial.started"
  | "actor.started"
  | "browser.started"
  | "page.loaded"
  | "form.fill.started"
  | "form.fill.progress"
  | "form.submitted"
  | "form.response"
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
 * FR-DEMO-01 — the ground-truth ledger fact, kept SEPARATE from the
 * defense action. NOT_CREATED is a verified probe answer (the probe
 * succeeded and the account is absent); INCONCLUSIVE means the probe
 * could not answer. Only the join (below) may render BLOCKED.
 */
export type GroundTruth = "CREATED" | "NOT_CREATED" | "INCONCLUSIVE";

/**
 * FR-DEMO-01 — the observed FireRaid action for an arm's submission.
 * UNOBSERVED = the assessment never reached the operator plane (submit
 * dropped, browser broke, or the arm is CONTROL, which has no middleware).
 */
export type FireRaidAction =
  | "ACCEPT"
  | "REVIEW"
  | "QUARANTINE"
  | "ERROR"
  | "UNOBSERVED";

/**
 * The displayed verdict. BLOCKED (BY FIRERAID) is legal ONLY when the
 * ground truth is NOT_CREATED AND the observed FireRaid action is a
 * non-ACCEPT terminal decision — see joinOutcome().
 */
export type TrialOutcome = "CREATED" | "BLOCKED" | "ERROR" | "INCONCLUSIVE";

/**
 * FR-DEMO-01 — the join rule. Ground truth and defense action combine:
 *   - probe says CREATED                     → CREATED (nothing blocked it)
 *   - probe says NOT_CREATED + ACCEPT/none   → INCONCLUSIVE (where did it go?)
 *   - probe says NOT_CREATED + non-ACCEPT    → BLOCKED (observed intervention)
 *   - probe INCONCLUSIVE / action ERROR      → INCONCLUSIVE / ERROR
 */
export function joinOutcome(
  truth: GroundTruth,
  action: FireRaidAction
): TrialOutcome {
  if (truth === "CREATED") return "CREATED";
  if (truth === "INCONCLUSIVE") return "INCONCLUSIVE";
  // truth === "NOT_CREATED"
  if (action === "ERROR") return "ERROR";
  if (action === "QUARANTINE" || action === "REVIEW") return "BLOCKED";
  // ACCEPT or UNOBSERVED with a verified-absent account: we cannot
  // attribute the absence to FireRaid — the submit may never have arrived.
  return "INCONCLUSIVE";
}

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
    /** FR-DEMO-01: the observed defense action backing the verdict. */
    action?: FireRaidAction;
  };
  /**
   * FR-DEMO-07: sha256 of the base application page BOTH arms were
   * served (pre-injection). The arms are provably paired — the treatment
   * delta is FireRaid's injection alone.
   */
  baseApplicationHash?: string;
}

/** Emails are the ledger join key: one identity per (trial, arm). */
export function trialEmails(trialId: string): { control: string; fireraid: string } {
  return {
    control: `${trialId}-control@example.invalid`,
    fireraid: `${trialId}-fireraid@example.invalid`,
  };
}

/**
 * FR-DEMO-03: the behavior seed BOTH arms of a trial share — the same
 * humanized timing sequence parameterizes both sides of the pair.
 */
export function trialBehaviorSeed(trialId: string): string {
  return `${trialId}:${trialEmails(trialId).control}:${trialEmails(trialId).fireraid}`;
}
