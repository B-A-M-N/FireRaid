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
 * FR-P0-13: the evidence payload a run persists alongside its record.
 * Nothing here may carry session cookies or lab bind credentials — the
 * runner builds this from already-redacted fields.
 */
export interface RunEvidence {
  /** Full agent transcript (model inputs/outputs/actions, wire notes). */
  transcript: string;
  /** Perception artifacts (bounded content + hash over the stored bytes). */
  perceptionArtifacts?: Array<{
    step: number;
    type: string;
    content: string;
    hash: string;
  }>;
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
   * P1-AUDIT-2 (P0-6): write the experiment-level declaration sidecar the
   * analyzer reads to know which endpoint protocol a dataset belongs to
   * (origin-ledger ⇒ the primary endpoint REQUIRES origin measurement
   * coverage; worker-mode ⇒ `submitted` stays a labeled proxy). Called once
   * by the runner before the first record lands. Idempotent.
   */
  declareExperiment(declaration: {
    experiment_id: string;
    target_mode: "origin-ledger" | "fireraid-worker";
    manifest_hash: string;
    conditions?: string[];
  }): void {
    const dir = join(RESULTS_DIR, this.experimentId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, "experiment.json");
    // Never clobber a declaration whose hash differs — that is a different
    // experiment occupying the same directory and must not be papered over.
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf-8")) as { manifest_hash?: string };
      if (existing.manifest_hash !== declaration.manifest_hash) {
        throw new Error(
          `experiment.json hash mismatch for ${this.experimentId}: directory already declares ${existing.manifest_hash}`
        );
      }
      return;
    }
    writeFileSync(path, JSON.stringify(declaration, null, 2));
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
   * FR-P0-13: persist a run's actual evidence — the full transcript and the
   * perception artifacts — to an `evidence/<run_id>/` directory next to the
   * record, and return the record-relative paths for transcript_path /
   * perception_artifact_dir. Artifact files carry the SAME bytes that were
   * hashed, so `sha256(artifact file) == artifact.hash` verifies. The JSON
   * record itself stays bounded (it references the evidence, not the bulk).
   */
  writeEvidence(runId: string, evidence: RunEvidence): {
    transcriptPath: string;
    artifactDir: string;
  } {
    const dir = join(RESULTS_DIR, this.experimentId, "evidence", runId);
    mkdirSync(dir, { recursive: true });

    const transcriptPath = join(dir, "transcript.txt");
    writeFileSync(transcriptPath, evidence.transcript, "utf-8");

    const artifactDir = join(dir, "artifacts");
    if (evidence.perceptionArtifacts && evidence.perceptionArtifacts.length > 0) {
      mkdirSync(artifactDir, { recursive: true });
      for (const a of evidence.perceptionArtifacts) {
        // One file per step; content is exactly what a.hash covers.
        const file = join(artifactDir, `step-${String(a.step).padStart(3, "0")}.txt`);
        writeFileSync(file, a.content, "utf-8");
      }
    }

    // Record-relative paths (portable across machines).
    const rel = (p: string) => p.replace(RESULTS_DIR + "/", "");
    return { transcriptPath: rel(transcriptPath), artifactDir: rel(artifactDir) };
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
