/**
 * BrowserUse adapter — NOT REGISTERED with the runner.
 * FR-R5-027: Stub implementing AgentAdapter, spawning browser-use.py.
 *
 * capabilities still say implemented:false — do NOT wire into runner
 * until the next decision pass.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAdapter, AgentRunResult, Scenario } from "../core/run-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// FR-R5-027: Mark clearly NOT-REGISTERED
export class BrowserUseAdapter implements AgentAdapter {
  // not-registered: capabilities still say implemented:false
  readonly type = "browser-use" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const start = Date.now();
    const fullStdout: string[] = [];

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(
        "python3",
        [join(__dirname, "browser-use.py")],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FIRERAID_BASE_URL: scenario.targetUrl + "/signup",
            FIRERAID_LLM_MODEL: scenario.model,
            FIRERAID_MAX_STEPS: String(scenario.maxSteps),
            FIRERAID_TIMEOUT_MS: String(scenario.timeoutMs),
          },
        },
      );

      child.stdout.on("data", (chunk: Buffer) => {
        fullStdout.push(chunk.toString());
      });

      child.stderr.on("data", (chunk: Buffer) => {
        fullStdout.push(chunk.toString());
      });

      child.on("close", () => {
        const stdout = fullStdout.join("");

        // Find the LAST __FIRERAID_RESULT__-prefixed JSON line
        const lines = stdout.split("\n");
        let lastResultLine: string | null = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].startsWith("__FIRERAID_RESULT__")) {
            lastResultLine = lines[i].slice("__FIRERAID_RESULT__".length).trim();
            break;
          }
        }

        if (lastResultLine == null || lastResultLine === "") {
          reject(new Error("BROWSER_USE_FAILED"));
          return;
        }

        try {
          const parsed: unknown = JSON.parse(lastResultLine);

          // Map browser-use.py fields to AgentRunResult (nested or flat shapes)
          const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
            outcome?: string;
            actions?: number;
            elapsedMs?: number;
            classification?: { outcome?: string };
            performance?: { actions?: number; elapsed_ms?: number };
            observations?: { canary_triggered?: boolean };
          };

          const outcome = obj.classification?.outcome ?? obj.outcome ?? "error";
          const actionCount = Number(obj.performance?.actions ?? obj.actions ?? 0);
          const elapsedMs = Number(obj.performance?.elapsed_ms ?? obj.elapsedMs ?? Date.now() - start);

          resolve({
            outcome: outcome as AgentRunResult["outcome"],
            actionCount,
            elapsedMs,
            transcript: stdout,
            canaryTriggered: Boolean(obj.observations?.canary_triggered),
          });
        } catch {
          reject(new Error("BROWSER_USE_FAILED"));
        }
      });

      child.on("error", () => {
        reject(new Error("BROWSER_USE_FAILED"));
      });
    });
  }
}
