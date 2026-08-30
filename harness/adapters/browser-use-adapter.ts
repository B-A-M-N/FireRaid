/**
 * BrowserUse adapter (FR-POST-R6-P2) — thin execution backend wrapper.
 *
 * Architecture (Python owns NOTHING authoritative):
 *   runner → Scenario JSON (stdin) → browser-use.py → result JSON line (stdout)
 *   → AgentRunResult → runner reconciliation → RunRecordV1
 *
 * Python must not own: run IDs, experiment IDs, final result files,
 * submission truth, profile truth, disposition truth. All of those stay in
 * the TS runner / FireRaid server.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { signupUrl } from "../core/urls.js";

import type { AgentAdapter, AgentRunResult, Scenario } from "../core/run-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESULT_PREFIX = "__FIRERAID_RESULT__";

interface PythonResult {
  outcome: AgentRunResult["outcome"];
  actionCount?: number;
  elapsedMs?: number;
  canaryTriggered?: boolean;
  canaryReferenced?: boolean;
  canaryGenericReferenced?: boolean;
  transcript?: string;
  errorCode?: string | null;
  perceptionArtifacts?: AgentRunResult["perceptionArtifacts"];
  sessionCookie?: string | null;
}

/** Spawn browser-use.py with the scenario on stdin; parse the result line. */
function runPythonWorker(scenario: Scenario, timeoutMs: number): Promise<PythonResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [join(__dirname, "browser-use.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error("BROWSER_USE_WORKER_TIMEOUT"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`BROWSER_USE_SPAWN_FAILED: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const out = Buffer.concat(stdout).toString("utf-8");
      // LAST __FIRERAID_RESULT__ line wins (defensive: logs may precede it)
      let line: string | null = null;
      for (const l of out.split("\n")) {
        if (l.startsWith(RESULT_PREFIX)) line = l.slice(RESULT_PREFIX.length).trim();
      }

      if (line === null) {
        const errText = Buffer.concat(stderr).toString("utf-8").slice(-2000);
        reject(new Error(
          `BROWSER_USE_NO_RESULT (exit ${code})${errText ? `: ${errText}` : ""}`
        ));
        return;
      }

      try {
        resolve(JSON.parse(line) as PythonResult);
      } catch {
        reject(new Error("BROWSER_USE_MALFORMED_RESULT"));
      }
    });

    // FR-POST-R6-P2: the COMPLETE scenario travels over stdin — target URL
    // (bind-aware), lab run id + bind token, fixture, model, prompt variant,
    // sampling config, timeout, max steps. Python reads nothing authoritative
    // from its own environment.
    child.stdin.write(JSON.stringify({
      targetUrl: scenario.targetUrl,
      entryUrl: signupUrl(scenario),
      labRun: scenario.labRun,
      fixture: scenario.fixture,
      model: scenario.model,
      promptVariant: scenario.promptVariant,
      modelConfig: scenario.modelConfig,
      timeoutMs: scenario.timeoutMs,
      maxSteps: scenario.maxSteps,
    }));
    child.stdin.end();
  });
}

/**
 * BrowserUse adapter implementing AgentAdapter.
 * Ambiguous completion NEVER defaults to "submitted" — outcome comes from
 * the worker's conservative classification, and submission truth is decided
 * by server reconciliation in the runner.
 */
export class BrowserUseAdapter implements AgentAdapter {
  readonly type = "browser-use" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const start = Date.now();
    // Worker wall-clock budget = scenario timeout + 30s slack for startup
    const workerTimeoutMs = scenario.timeoutMs + 30_000;

    let py: PythonResult;
    try {
      py = await runPythonWorker(scenario, workerTimeoutMs);
    } catch (err) {
      return {
        outcome: "error",
        actionCount: 0,
        elapsedMs: Date.now() - start,
        transcript: err instanceof Error ? err.message : String(err),
        canaryTriggered: false,
        canaryReferenced: false,
        canaryGenericReferenced: false,
        errorCode: err instanceof Error && err.message.startsWith("BROWSER_USE")
          ? err.message.split(" ")[0]
          : "BROWSER_USE_ERROR",
      };
    }

    // Defense-in-depth: the worker must never claim "submitted" without a
    // definitive successful-completion signal; coerce anything unexpected.
    const ALLOWED = ["submitted", "stopped", "handoff", "timeout", "error"] as const;
    const outcome = (ALLOWED as readonly string[]).includes(py.outcome)
      ? py.outcome
      : "error";

    return {
      outcome,
      actionCount: Number(py.actionCount ?? 0),
      elapsedMs: Number(py.elapsedMs ?? Date.now() - start),
      transcript: py.transcript ?? "",
      sessionCookie: py.sessionCookie ?? undefined,
      canaryTriggered: Boolean(py.canaryTriggered),
      canaryReferenced: Boolean(py.canaryReferenced),
      canaryGenericReferenced: Boolean(py.canaryGenericReferenced),
      perceptionArtifacts: py.perceptionArtifacts,
      errorCode: py.errorCode ?? undefined,
    };
  }
}
