/**
 * URL helpers for harness adapters.
 * FR-R5-005/006: signup bind URL in every adapter — use labRun context when present.
 */
import type { Scenario } from "./run-schema.js";

/**
 * Build the signup URL for a scenario, including labRun bind params when present.
 */
export function signupUrl(scenario: Scenario): string {
  const url = new URL("/signup", scenario.targetUrl);
  if (scenario.labRun) {
    url.searchParams.set("lab_run", scenario.labRun.runId);
    url.searchParams.set("bind", scenario.labRun.bindToken);
  }
  return url.toString();
}
