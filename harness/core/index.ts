export { validateManifest, expandManifest } from "./run-schema.js";
export type {
  ExperimentManifest,
  RunRecordV1,
  RunRecordV2,
  AgentAdapter,
  AgentRunResult,
  Scenario,
  AgentType,
  ExtractorType,
  Outcome,
  Disposition,
  RunStatus,
  TrialDescriptor,
  AdapterCapabilities,
  LabRunContext,
} from "./run-schema.js";
export { Recorder, generateRunId } from "./recorder.js";
export { runExperiment } from "./runner.js";
export { ADAPTER_CAPABILITIES } from "./run-schema.js";
// publish-runs.ts is a CLI script — no library exports
