/**
 * Recorder — persists canonical RunRecordV2 results.
 * FR-R3-029: The runner owns serialization. Adapters do not write final records.
 * FR-R4-084: validates every record through the schema; loadExperiment collects
 *             invalid records with warnings instead of crashing.
 * FR-P0-7: v2 is the NATIVE write format. Archived v1 evidence loads through
 *             parseRunRecord's v1→v2 normalizer, so all in-memory records are
 *             v2 regardless of on-disk schema version.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecordV2 } from "./run-schema.js";
import { parseRunRecord, RunRecordV2Schema } from "./run-schema.js";

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
  private records: RunRecordV2[] = [];

  /** Static holder for the most recent load warnings. */
  static lastLoadWarnings: RecordLoadWarning[] = [];

  constructor(experimentId: string) {
    this.experimentId = experimentId;
  }

  /**
   * Persist a single run record.
   * FR-R4-084: validates via Zod before writing.
   * FR-P0-7: v2 schema — a v1 record handed here is a caller bug (the runner
   * builds v2); fail loudly instead of silently migrating.
   */
  record(run: RunRecordV2): void {
    RunRecordV2Schema.parse(run);

    const dir = join(RESULTS_DIR, this.experimentId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const path = join(dir, `${run.run_id}.json`);
    writeFileSync(path, JSON.stringify(run, null, 2));
    this.records.push(run);
  }

  /**
   * Load all records for an experiment. Both schema versions parse (v1 via
   * the normalizer); the returned records are ALWAYS v2 so analysis code
   * sees one shape.
   * FR-R4-084: collects invalid records with Zod errors into warnings.
   */
  static loadExperiment(experimentId: string): RunRecordV2[] {
    Recorder.lastLoadWarnings = [];

    const dir = join(RESULTS_DIR, experimentId);
    if (!existsSync(dir)) return [];
    // Run records only — skip resume.json (runner state, not a RunRecord).
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "resume.json");

    const valid: RunRecordV2[] = [];
    for (const f of files) {
      try {
        const content = readFileSync(join(dir, f), "utf-8");
        const parsed = JSON.parse(content) as unknown;
        const result = parseRunRecord(parsed);
        if (result.ok) {
          valid.push(result.record);
        } else {
          const runId =
            typeof parsed === "object" && parsed !== null && "run_id" in parsed
              ? (parsed as Record<string, unknown>).run_id as string
              : undefined;
          Recorder.lastLoadWarnings.push({
            fileName: f,
            runId,
            errors: result.errors,
          });
          console.warn(
            `[Recorder] invalid record in ${f} (run ${runId ?? "unknown"}):`,
            result.errors.join("; ")
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
  static computeMetrics(runs: RunRecordV2[]): {
    attempts: number;
    valid: number;
    submitted: number;
    stopped: number;
    handoff: number;
    canary_exposed: number;
    canary_verified: number;
    /** FR-P0-7: measured-exposure denominator — artifacts actually captured. */
    exposure_measured: number;
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
    const exposed = valid.filter((r) => r.exposure_state === "EXPOSED");
    const exposureMeasured = valid.filter(
      (r) => r.exposure_state === "EXPOSED" || r.exposure_state === "NOT_EXPOSED"
    );
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
      exposure_measured: exposureMeasured.length,
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
