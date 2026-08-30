/**
 * RunRecordV1 — canonical experiment result schema.
 * FR-R3-029: Zod-defined, runner-owned, adapter-agnostic.
 *
 * Every adapter produces an AgentRunResult.
 * The runner reconciles it with FireRaid server truth to produce a RunRecordV1.
 * The runner (not adapters) owns serialization.
 */
import { z } from "zod";
// FR-R6-009: the manifest uses the CANONICAL recipe identifiers — the same
// RecipeId enum the lab API and the profile engine resolve server-side.
import { RecipeIdSchema } from "../../src/core/recipe-schema.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const AgentType = z.enum([
  "human",
  "raw-dom",
  "browser-use",
  "ax-snapshot",
  "raw-http",
]);
export type AgentType = z.infer<typeof AgentType>;

export const ExtractorType = z.enum(["raw-html", "simplified-dom", "accessibility"]);
export type ExtractorType = z.infer<typeof ExtractorType>;

export const Outcome = z.enum(["submitted", "stopped", "handoff", "timeout", "error"]);
export type Outcome = z.infer<typeof Outcome>;

export const Disposition = z.enum(["ACCEPT", "REVIEW", "QUARANTINE"]);
export type Disposition = z.infer<typeof Disposition>;

export const RunStatus = z.enum(["PENDING", "RUNNING", "COMPLETE", "ERROR", "TIMEOUT"]);
export type RunStatus = z.infer<typeof RunStatus>;

// ---------------------------------------------------------------------------
// Scenario — what an agent runs against
// ---------------------------------------------------------------------------

export interface LabRunContext {
  runId: string;
  bindToken: string;
}

export const ScenarioSchema = z.object({
  targetUrl: z.string().url(),
  fixture: z.record(z.string()),
  promptVariant: z.string(),
  model: z.string(),
  maxSteps: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  modelConfig: z.object({ temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().positive().optional() }).optional(),
  labRun: z.object({ runId: z.string(), bindToken: z.string() }).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------
// AgentRunResult — what adapters produce (before server reconciliation)
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  /** Agent-side outcome — what the agent *thought* it did */
  outcome: Outcome;
  /** Number of agent steps/actions taken */
  actionCount: number;
  /** Wall-clock elapsed time in ms */
  elapsedMs: number;
  /** Session cookie captured during the run (for server reconciliation) */
  sessionCookie?: string;
  /** Raw transcript / log */
  transcript: string;
  /** Error info if outcome === "error" */
  errorCode?: string;
  errorMessage?: string;
  /** Agent-side canary observations (not authoritative) */
  canaryTriggered?: boolean;
  canaryReferenced?: boolean;
  /**
   * FR-R6-055: the agent's output contained a generic "/c/" shape WITHOUT
   * exact session material. Kept separate from canaryReferenced — a generic
   * mention must never feed the exact-reference metric.
   */
  canaryGenericReferenced?: boolean;
  /** Perception artifacts (for exposure analysis) */
  perceptionArtifacts?: Array<{
    step: number;
    type: "raw-html" | "simplified-dom" | "accessibility";
    content: string;
    hash: string;
  }>;
}

// ---------------------------------------------------------------------------
// AgentAdapter — interface all adapters must implement
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  readonly type: AgentType;
  readonly extractor?: ExtractorType;

  run(scenario: Scenario): Promise<AgentRunResult>;
}

// ---------------------------------------------------------------------------
// RunRecordV1 — canonical persisted result (after server reconciliation)
// ---------------------------------------------------------------------------

export const RunRecordV1Schema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  experiment_id: z.string().min(1),

  // --- Trial identity ---
  trial_index: z.number().int().nonnegative(),
  repetition: z.number().int().nonnegative(),

  // --- Agent config ---
  agent: AgentType,
  model: z.string(),
  prompt_variant: z.string(),
  extractor: ExtractorType.optional(),

  // --- Defense config ---
  profile_version: z.number().int().positive(),
  profile_id: z.string(),
  recipe_id: z.string().optional(),
  defense_families: z.array(z.string()),
  semantic_template: z.string().optional(),
  placement: z.string().optional(),

  // --- Server truth (authoritative) ---
  session_id: z.string().optional(),
  submitted: z.boolean(),
  disposition: Disposition.optional(),
  score: z.number().optional(),

  // --- Canary exposure ---
  canary_exposed: z.boolean(),
  canary_referenced: z.boolean(),
  /** FR-R6-055: generic "/c/" shape without exact session material. */
  canary_generic_referenced: z.boolean().default(false),
  canary_requested_client: z.boolean(),
  canary_verified_server: z.boolean(),

  // --- Server reconciliation (FR-R4-033) ---
  server_reconciled: z.boolean().default(false),

  // --- Canary issuance (FR-R4-031) ---
  canary_issued: z.boolean().optional(),

  // --- Profile variant tracking (FR-R4-032) ---
  profile_variant_id: z.string().optional(),

  // --- Lab mode flag (FR-R4-033) ---
  lab_mode: z.boolean().optional(),

  // --- Agent-side observations ---
  outcome: Outcome,
  action_count: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
  error_code: z.string().nullish(),

  // --- Provenance (FR-R3-096 / FR-R4-081) ---
  fireraid_git_sha: z.string().optional(),
  fireraid_dirty: z.boolean().optional(),
  manifest_hash: z.string().optional(),
  node_version: z.string(),
  adapter_version: z.string(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  browser_name: z.string().optional(),
  browser_version: z.string().optional(),

  // --- Artifacts ---
  transcript_path: z.string().optional(),
  perception_artifact_dir: z.string().optional(),

  // --- Timestamps ---
  started_at: z.number().int(),
  completed_at: z.number().int(),
});
export type RunRecordV1 = z.infer<typeof RunRecordV1Schema>;

// ---------------------------------------------------------------------------
// ExperimentManifest — validated with Zod (FR-R3-093)
// ---------------------------------------------------------------------------

export const ExperimentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  seed: z.string().min(1),
  target: z.object({ url: z.string().url() }),
  repetitions: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  fixture: z.string().default("default"),
  profile_version: z.number().int().positive().default(1),

  // Matrix
  agents: z.array(AgentType),
  models: z.array(z.string().min(1)),
  prompts: z.array(z.string().min(1)),
  extractors: z.array(ExtractorType).optional(),

  // --- Control parameters (FR-R4-039) ---
  max_steps: z.number().int().positive().default(20),

  // --- Model configuration (FR-R4-041) ---
  model_config: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().optional(),
    })
    .default({}),

  // --- Retry policy (FR-R4-085) ---
  retry_failed: z.boolean().default(false),

  // FR-R6-009: manifest conditions use the CANONICAL treatment abstractions,
  // not a second hand-written partial recipe schema:
  //   recipe_id — named condition (CONTROL, FULL, SEMANTIC_ONLY, ...),
  //               resolved server-side against ABLATION_RECIPES.
  //   turnstile_required — per-run Turnstile experimental condition.
  //   holdout_mode — restrict semantic templates to the holdout partition.
  // recipe_id XOR recipe: one treatment identity per run (FR-R6-010).
  recipe_id: RecipeIdSchema.optional(),
  turnstile_required: z.boolean().optional(),
  holdout_mode: z.boolean().default(false),
});
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;

/**
 * Expand a manifest into individual trial descriptors.
 */
export interface TrialDescriptor {
  index: number;
  repetition: number;
  agent: AgentType;
  model: string;
  prompt: string;
  extractor?: ExtractorType;
  /** FR-R6-008: named condition for server-side provenance (recipe_id). */
  recipeId?: string;
}

// ---------------------------------------------------------------------------
// Adapter capability registry (FR-R4-034 / FR-R4-083)
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  implemented: boolean;
  usesModel: boolean;
  usesPrompt: boolean;
  supportedExtractors: ExtractorType[]; // empty = extractor-agnostic
  version: string;
}

export const ADAPTER_CAPABILITIES: Record<AgentType, AdapterCapabilities> = {
  "human":          { implemented: true,  usesModel: false, usesPrompt: false, supportedExtractors: [], version: "0.1.0" },
  "raw-dom":        { implemented: true,  usesModel: true,  usesPrompt: true,  supportedExtractors: ["raw-html", "simplified-dom"], version: "0.1.0" },
  // FR-R6-066: renamed from "playwright-mcp" — this adapter is ariaSnapshot+LLM,
  // not the official Playwright MCP server.
  "ax-snapshot": { implemented: true,  usesModel: true,  usesPrompt: true,  supportedExtractors: ["accessibility"], version: "0.1.0" },
  // FR-R4-034: declared but not yet integrated as AgentAdapters — manifests
  // referencing them fail validation until wired.
  "browser-use":    { implemented: false, usesModel: true,  usesPrompt: true,  supportedExtractors: [], version: "0.0.0" },
  "raw-http":       { implemented: false, usesModel: false, usesPrompt: false, supportedExtractors: [], version: "0.0.0" },
};

/**
 * Validate an experiment manifest, returning typed errors.
 * FR-R4-034: checks adapter implementation status and extractor compatibility.
 */
export function validateManifest(raw: unknown): {
  ok: true;
  data: ExperimentManifest;
} | {
  ok: false;
  errors: string[];
} {
  const result = ExperimentManifestSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    );
    return { ok: false, errors };
  }

  const manifest = result.data;
  const errors: string[] = [];

  // FR-R4-034: check that every declared agent is implemented
  for (const agent of manifest.agents) {
    const caps = ADAPTER_CAPABILITIES[agent];
    if (!caps.implemented) {
      errors.push(`agent not yet integrated: ${agent}`);
    }
  }

  // FR-R4-034: validate extractor compatibility per agent
  if (manifest.extractors) {
    for (const agent of manifest.agents) {
      const caps = ADAPTER_CAPABILITIES[agent];
      // Empty supportedExtractors means extractor-agnostic — skip check
      if (caps.supportedExtractors.length > 0) {
        for (const extractor of manifest.extractors) {
          if (!caps.supportedExtractors.includes(extractor)) {
            errors.push(
              `agent "${agent}" does not support extractor "${extractor}"`
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, data: manifest };
}

/**
 * Expand a manifest into individual trial descriptors.
 * FR-R4-039: only vary dimensions an adapter consumes.
 */
export function expandManifest(manifest: ExperimentManifest): TrialDescriptor[] {
  const trials: TrialDescriptor[] = [];
  let index = 0;

  for (let rep = 0; rep < manifest.repetitions; rep++) {
    for (const agent of manifest.agents) {
      const caps = ADAPTER_CAPABILITIES[agent];

      // FR-R4-039: only vary models/prompts if the adapter uses them
      const models = caps.usesModel ? manifest.models : [manifest.models[0]];
      const prompts = caps.usesPrompt ? manifest.prompts : [manifest.prompts[0]];

      // FR-R4-039: extractors = intersection with agent-supported, or first default if manifest didn't list them
      const effectiveExtractors = getEffectiveExtractors(manifest, caps);

      for (const model of models) {
        for (const prompt of prompts) {
          for (const extractor of effectiveExtractors) {
            trials.push({
              index,
              repetition: rep,
              agent,
              model,
              prompt,
              extractor,
              // FR-R6-008: named treatment identity for provenance.
              recipeId: manifest.recipe_id,
            });
            index++;
          }
        }
      }
    }
  }

  return trials;
}

/**
 * Compute the effective extractor list for a (manifest, agent) pair.
 * FR-R4-039: intersection of manifest-specified extractors with agent-supported.
 */
function getEffectiveExtractors(
  manifest: ExperimentManifest,
  caps: AdapterCapabilities
): (ExtractorType | undefined)[] {
  // If agent doesn't consume extractors, single undefined
  if (!caps.supportedExtractors.length) return [undefined];

  if (manifest.extractors) {
    // Intersection of manifest extractors with agent-supported extractors
    const intersection = manifest.extractors.filter((e) =>
      caps.supportedExtractors.includes(e)
    );
    if (intersection.length > 0) return intersection;
  }

  // Manifest didn't list extractors — use agent's first supported extractor as default
  return [caps.supportedExtractors[0]];
}
