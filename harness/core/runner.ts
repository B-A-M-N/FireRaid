/**
 * Experiment runner — executes declarative experiment manifests.
 * FR-INV-009: experiments must be reproducible.
 * FR-INV-010: measured results must not be confused with sample numbers.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ExperimentManifest {
  id: string;
  target: { url: string };
  agents: string[];
  models: string[];
  prompts: string[];
  extractors?: string[];
  profile_version: number;
  repetitions: number;
  timeout_ms: number;
  fixture: string;
  seed: string;
}

export interface RunRecord {
  schema_version: number;
  run_id: string;
  experiment_id: string;
  agent: string;
  model: string;
  prompt: string;
  extractor: string;
  profile_version: number;
  profile_id: string;
  outcome: string;
  submitted: boolean;
  canary_exposed: boolean;
  canary_referenced: boolean;
  canary_triggered: boolean;
  score: number;
  disposition: string;
  elapsed_ms: number;
  action_count: number;
  error_code: string | null;
  artifact_path: string | null;
}

const RESULTS_DIR = join(process.cwd(), "harness", "results");

export function loadManifest(path: string): ExperimentManifest {
  const raw = readFileSync(path, "utf-8");
  // Simple YAML-ish parse (assume JSON for now)
  return JSON.parse(raw) as ExperimentManifest;
}

export function listRuns(experimentId: string): RunRecord[] {
  const dir = join(RESULTS_DIR, experimentId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as RunRecord);
}

export function saveRun(experimentId: string, run: RunRecord): void {
  const dir = join(RESULTS_DIR, experimentId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.run_id}.json`);
  writeFileSync(path, JSON.stringify(run, null, 2));
}

export function generateRunId(): string {
  return `run-${randomUUID().slice(0, 8)}`;
}

export function computeMetrics(runs: RunRecord[]): {
  attempts: number;
  valid: number;
  submitted: number;
  stopped: number;
  handoff: number;
  canary_triggered: number;
  quarantined: number;
  review: number;
  median_elapsed: number;
  error_rate: number;
} {
  const valid = runs.filter((r) => !r.error_code);
  const submitted = valid.filter((r) => r.outcome === "submitted");
  const stopped = valid.filter((r) => r.outcome === "stopped");
  const handoff = valid.filter((r) => r.outcome === "handoff");
  const triggered = valid.filter((r) => r.canary_triggered);
  const quarantined = valid.filter((r) => r.disposition === "QUARANTINE");
  const review = valid.filter((r) => r.disposition === "REVIEW");

  const elapsed = valid.map((r) => r.elapsed_ms).sort((a, b) => a - b);
  const median = elapsed.length > 0 ? elapsed[Math.floor(elapsed.length / 2)] : 0;

  return {
    attempts: runs.length,
    valid: valid.length,
    submitted: submitted.length,
    stopped: stopped.length,
    handoff: handoff.length,
    canary_triggered: triggered.length,
    quarantined: quarantined.length,
    review: review.length,
    median_elapsed: median,
    error_rate: runs.length > 0 ? (runs.length - valid.length) / runs.length : 0,
  };
}
