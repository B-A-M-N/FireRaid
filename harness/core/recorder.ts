/**
 * Recorder — persists canonical RunRecordV1 results.
 * FR-R3-029: The runner owns serialization. Adapters do not write final records.
 * FR-R4-084: validates every record through the schema; loadExperiment collects
 *             invalid records with warnings instead of crashing.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecordV1 } from "./run-schema.js";
import { RunRecordV1Schema } from "./run-schema.js";

const RESULTS_DIR = join(process.cwd(), "harness", "results");

export function generateRunId(): string {
  return `run-${randomUUID()}`;
}

/**
 * Warning info for an invalid record loaded from disk.
 */
export interface RecordLoadWarning {
  fileName: string;
  runId?: string;
  errors: string[];
}

export class Recorder {
  private experimentId: string;
  private records: RunRecordV1[] = [];

  /** Static holder for the most recent load warnings. */
  static lastLoadWarnings: RecordLoadWarning[] = [];

  constructor(experimentId: string) {
    this.experimentId = experimentId;
  }

  /**
   * Persist a single run record.
   * FR-R4-084: validates via Zod before writing.
   */
  record(run: RunRecordV1): void {
    RunRecordV1Schema.parse(run);

    const dir = join(RESULTS_DIR, this.experimentId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const path = join(dir, `${run.run_id}.json`);
    writeFileSync(path, JSON.stringify(run, null, 2));
    this.records.push(run);
  }

  /**
   * Load all records for an experiment.
   * FR-R4-084: parses each file, collects invalid ones with Zod errors into
   * warnings. Invalid records are excluded from the returned array.
   */
  static loadExperiment(experimentId: string): RunRecordV1[] {
    Recorder.lastLoadWarnings = [];

    const dir = join(RESULTS_DIR, experimentId);
    if (!existsSync(dir)) return [];
    // Run records only — skip resume.json (runner state, not a RunRecordV1).
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "resume.json");

    const valid: RunRecordV1[] = [];
    for (const f of files) {
      try {
        const content = readFileSync(join(dir, f), "utf-8");
        const parsed = JSON.parse(content) as unknown;
        const result = RunRecordV1Schema.safeParse(parsed);
        if (result.success) {
          valid.push(result.data);
        } else {
          const runId =
            typeof parsed === "object" && parsed !== null && "run_id" in parsed
              ? (parsed as Record<string, unknown>).run_id as string
              : undefined;
          Recorder.lastLoadWarnings.push({
            fileName: f,
            runId,
            errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
          console.warn(
            `[Recorder] invalid record in ${f} (run ${runId ?? "unknown"}):`,
            result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          );
        }
      } catch {
        Recorder.lastLoadWarnings.push({
          fileName: f,
          errors: ["failed to parse JSON"],
        });
      }
    }

    return valid;
  }

  /**
   * Get summary metrics for an experiment.
   */
  static computeMetrics(runs: RunRecordV1[]): {
    attempts: number;
    valid: number;
    submitted: number;
    stopped: number;
    handoff: number;
    canary_exposed: number;
    canary_verified: number;
    quarantined: number;
    review: number;
    median_elapsed: number;
    error_rate: number;
    unreconciled: number;
    timeouts: number;
    errors: number;
  } {
    // FR-R5-022: "valid" = server truth — reconciled with authoritative outcomes
    const valid = runs.filter(
      (r) => r.server_reconciled === true && ["submitted", "stopped", "handoff"].includes(r.outcome)
    );
    // Submitted counts server truth (r.submitted === true) within valid
    const submitted = valid.filter((r) => r.submitted === true);
    const stopped = valid.filter((r) => r.outcome === "stopped");
    const handoff = valid.filter((r) => r.outcome === "handoff");
    const exposed = valid.filter((r) => r.canary_exposed);
    const verified = valid.filter((r) => r.canary_verified_server);
    const quarantined = valid.filter((r) => r.disposition === "QUARANTINE");
    const review = valid.filter((r) => r.disposition === "REVIEW");

    const elapsed = valid.map((r) => r.elapsed_ms).sort((a, b) => a - b);
    const median =
      elapsed.length > 0
        ? elapsed.length % 2 === 0
          ? (elapsed[elapsed.length / 2 - 1] + elapsed[elapsed.length / 2]) / 2
          : elapsed[Math.floor(elapsed.length / 2)]
        : 0;

    // Timeouts and errors counted over ALL runs (attempts denominator)
    const timeouts = runs.filter((r) => r.outcome === "timeout").length;
    const errors = runs.filter((r) => r.outcome === "error").length;

    return {
      attempts: runs.length,
      valid: valid.length,
      submitted: submitted.length,
      stopped: stopped.length,
      handoff: handoff.length,
      canary_exposed: exposed.length,
      canary_verified: verified.length,
      quarantined: quarantined.length,
      review: review.length,
      median_elapsed: median,
      error_rate: runs.length > 0 ? errors / runs.length : 0,
      unreconciled: runs.filter((r) => r.server_reconciled !== true).length,
      timeouts,
      errors,
    };
  }
}
