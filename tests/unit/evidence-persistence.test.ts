/**
 * FR-P0-13: evidence persistence. Each run's transcript and perception
 * artifacts are written to disk next to the record; artifact hashes are
 * reproducible from the stored bytes (hash-over-stored-bytes contract);
 * transcript_path / perception_artifact_dir are populated with
 * results-relative paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Recorder } from "../../harness/core/recorder.js";

// Recorder resolves RESULTS_DIR from process.cwd() at import time —
// these tests chdir into a temp sandbox FIRST via a tiny indirection:
// we recompute the same path shape the module uses, then clean up.
const EXP = "evidence-persistence-test";
const RESULTS = join(process.cwd(), "harness", "results", EXP);
const SHA = (s: string) => createHash("sha256").update(s).digest("hex");

function makeRecord(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    experiment_id: EXP,
    trial_index: 0,
    repetition: 0,
    agent: "raw-dom" as const,
    model: "test-model",
    prompt_variant: "baseline",
    profile_version: 1,
    profile_id: "p",
    defense_families: [],
    submitted: false,
    canary_exposed: false,
    canary_referenced: false,
    canary_generic_referenced: false,
    canary_requested_client: false,
    canary_verified_server: false,
    server_reconciled: false,
    exposure_state: "UNMEASURED" as const,
    perception_surface: null,
    outcome: "submitted" as const,
    action_count: 1,
    elapsed_ms: 1,
    error_code: null,
    node_version: process.version,
    adapter_version: "0.1.0",
    started_at: 0,
    completed_at: 0,
  };
}

describe("FR-P0-13: evidence persistence", () => {
  beforeEach(() => {
    rmSync(RESULTS, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(RESULTS, { recursive: true, force: true });
  });

  it("writeEvidence persists transcript + artifacts with hash-consistent bytes", () => {
    const rec = new Recorder(EXP);
    const artifactContent = "OBSERVATION_BYTES_THAT_ARE_HASHED";
    const paths = rec.writeEvidence("run-ev-1", {
      transcript: "step 1 → action fill\nstep 2 → submit",
      perceptionArtifacts: [
        { step: 1, type: "simplified-dom", content: artifactContent, hash: SHA(artifactContent) },
      ],
    });

    // Paths are results-relative and exist.
    const transcriptAbs = join(process.cwd(), "harness", "results", paths.transcriptPath);
    const artifactDirAbs = join(process.cwd(), "harness", "results", paths.artifactDir);
    expect(existsSync(transcriptAbs)).toBe(true);
    expect(existsSync(artifactDirAbs)).toBe(true);

    // Transcript bytes round-trip.
    expect(readFileSync(transcriptAbs, "utf-8")).toContain("step 2 → submit");

    // Artifact file bytes rehash EXACTLY to the recorded hash.
    const files = readdirSync(artifactDirAbs);
    expect(files).toEqual(["step-001.txt"]);
    const stored = readFileSync(join(artifactDirAbs, files[0]), "utf-8");
    expect(SHA(stored)).toBe(SHA(artifactContent));
  });

  it("hash-over-stored-bytes: truncated content hashes the TRUNCATION, not the original", () => {
    // The adapters' contract: truncate first, then hash. A 10k observation
    // stored with a 4000-char bound verifies against the BOUNDED bytes.
    const rec = new Recorder(EXP);
    const observation = "x".repeat(10_000);
    const bounded = observation.slice(0, 4000);
    const paths = rec.writeEvidence("run-ev-2", {
      transcript: "",
      perceptionArtifacts: [
        { step: 1, type: "raw-html", content: bounded, hash: SHA(bounded) },
      ],
    });
    const stored = readFileSync(
      join(process.cwd(), "harness", "results", paths.artifactDir, "step-001.txt"),
      "utf-8"
    );
    expect(stored.length).toBe(4000);
    expect(SHA(stored)).toBe(SHA(bounded));
    expect(SHA(stored)).not.toBe(SHA(observation)); // old (broken) semantics
  });

  it("empty artifact list creates transcript only", () => {
    const rec = new Recorder(EXP);
    const paths = rec.writeEvidence("run-ev-3", { transcript: "just the transcript" });
    const transcriptAbs = join(process.cwd(), "harness", "results", paths.transcriptPath);
    expect(existsSync(transcriptAbs)).toBe(true);
    expect(existsSync(join(process.cwd(), "harness", "results", paths.artifactDir))).toBe(false);
  });

  it("record + evidence round-trip through loadExperiment", () => {
    const rec = new Recorder(EXP);
    const run = makeRecord("run-ev-4");
    const paths = rec.writeEvidence(run.run_id, {
      transcript: "t",
      perceptionArtifacts: [{ step: 1, type: "raw-html", content: "c", hash: SHA("c") }],
    });
    rec.record({ ...run, transcript_path: paths.transcriptPath, perception_artifact_dir: paths.artifactDir });

    const loaded = Recorder.loadExperiment(EXP);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].transcript_path).toBe(paths.transcriptPath);
    expect(loaded[0].perception_artifact_dir).toBe(paths.artifactDir);
    // v2 record on disk parses cleanly (no load warnings).
    expect(Recorder.lastLoadWarnings).toHaveLength(0);
  });
});
