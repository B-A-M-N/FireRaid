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
  // P1-21: realistic attacker architectures (added to the taxonomy; see
  // ADAPTER_CAPABILITIES for implemented status).
  "dom-automation",   // visible-inputs, non-LLM DOM filler
  "fill-everything",  // brute-forces every field including decoys
  "humanized-pw",     // humanized Playwright (human-like timing)
  "vision-only",      // screenshot + vision-LLM
  "fireraid-aware",   // knows the defense exists, filters it
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
  /** FR-R7-006: false-positive trial variant (human agent only). */
  controlVariant: z.enum(["normal", "keyboard", "autofill"]).optional(),
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
    type: "raw-html" | "simplified-dom" | "accessibility" | "browser-use-observation" | "screenshot";
    content: string;
    hash: string;
  }>;
  /** FR-R7-028/029 provenance — adapters fill what they know, never the API key. */
  llmProvenance?: {
    providerOrigin?: string;
    modelRequested?: string;
    modelServed?: string;
    temperature?: number;
    maxTokens?: number;
  };
  pythonVersion?: string;
  browserUseVersion?: string;
  browserEngine?: string;
  browserEngineVersion?: string;
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
  /** P1-AUDIT-2 (P0-4): the issued profile's scoring policy (origin mode). */
  scoring_policy: z.string().optional(),
  semantic_template: z.string().optional(),
  placement: z.string().optional(),
  // P1-AUDIT-2 (audit item 16): the EXACT issued per-family material from
  // server truth — the semantic nonce, decoy field name, and route token.
  // Present only on reconciled lab records from a worker that serves it.
  treatment_material: z
    .object({
      semantic_nonce: z.string().nullish(),
      decoy_field_name: z.string().nullish(),
      route_token: z.string().nullish(),
    })
    .optional(),

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

  // --- Origin ledger truth (P1-AUDIT-2 Phase C / audit item 2) ---
  // The PRIMARY experimental endpoint: did the ORDINARY upstream application
  // (which knows nothing about FireRaid) actually create an account? Read
  // from the origin's own ledger, read-only, after the trial. `submitted`
  // (above) stays the SECONDARY measurement — "the agent reached FireRaid's
  // submission endpoint" — and must never be labeled "account creation".
  // present only in origin-ledger (middleware) mode; absent = not measured.
  origin_account_created: z.boolean().optional(),
  // P1-AUDIT-2 (P0-1): whether the origin ledger was actually RECONCILED.
  // false on a probe failure — in which case origin_account_created is
  // absent (UNKNOWN), never false: recording "not created" when the probe
  // could not read the ledger would credit the defense with a block that
  // might be an infrastructure failure. The analyzer's ITT denominator
  // keys on this flag (origin_infra plane), not on absence alone.
  origin_reconciled: z.boolean().optional(),
  /** How origin truth was read (provenance for the endpoint). */
  origin_ledger_mode: z.enum(["read-only-probe"]).optional(),

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
// RunRecordV2 — tri-state exposure + perception surface + provenance
// ---------------------------------------------------------------------------
/**
 * Schema v2 replaces the binary canary_exposed with a three-state enum.
 *
 * exposure_state:
 *   EXPOSED   — a perception artifact existed AND contained the exact session
 *               treatment material.
 *   NOT_EXPOSED — a perception artifact existed and demonstrably lacked it.
 *   UNMEASURED — no perception artifact was captured (e.g. human trials).
 *                This is NOT the same as measured-not-exposed.
 *
 * perception_surface: where exposure was measured.  null exactly when
 *   exposure_state is UNMEASURED (no artifact to measure against).
 *
 * control_variant: human-agent false-positive trial configuration (FR-R7-006).
 *   "normal" = bare browser, "keyboard" = manual typing, "autofill" =
 *   form-autofilled fields.  Only applies to the "human" agent.
 *
 * Provenance fields (all optional): adapters fill in whatever they know;
 *   none of these include the API key itself.
 *
 * Note: `canary_exposed` is retained from v1 as a derived boolean projection
 * (true iff exposure_state === "EXPOSED").
 */
export const RunRecordV2Schema = RunRecordV1Schema.extend({
  schema_version: z.literal(2),
  exposure_state: z.enum(["EXPOSED", "NOT_EXPOSED", "UNMEASURED"]),
  perception_surface: z.enum([
    "human-visual",
    "transport-html",
    "raw-html-model-input",
    "simplified-dom-model-input",
    "accessibility-model-input",
    "browser-use-observation",
    "screenshot-model-input",
  ]).nullable(),
  control_variant: z.enum(["normal", "keyboard", "autofill"]).nullish(),
  llm_provider_origin: z.string().optional(),
  llm_model_requested: z.string().optional(),
  llm_model_served: z.string().optional(),
  python_version: z.string().optional(),
  browser_use_version: z.string().optional(),
  browser_engine: z.string().optional(),
  browser_engine_version: z.string().optional(),
});
export type RunRecordV2 = z.infer<typeof RunRecordV2Schema>;

// ---------------------------------------------------------------------------
// v1 → v2 migration normalizer (heuristic — not a re-measurement)
// ---------------------------------------------------------------------------
/**
 * Migrate a v1 RunRecord to v2.
 *
 * Mapping rules:
 *   agent "human"
 *     → exposure_state "UNMEASURED", perception_surface null
 *       (the old canary_exposed boolean was never a measurement).
 *   agent "raw-http"
 *     → perception_surface "transport-html" (transport artifact always exists,
 *       so the old boolean was a real transport measurement):
 *       canary_exposed true → "EXPOSED", false → "NOT_EXPOSED".
 *   other agents (raw-dom, ax-snapshot, browser-use)
 *     → canary_exposed true → "EXPOSED" with surface from the record's
 *       extractor:
 *         "raw-html"       → "raw-html-model-input"
 *         "simplified-dom" → "simplified-dom-model-input"
 *         "accessibility"  → "accessibility-model-input"
 *         missing/unknown  → "raw-html-model-input"
 *       canary_exposed false → "UNMEASURED" + null
 *       (v1 cannot distinguish artifact-present-negative from artifact-absent).
 *
 * All other v1 fields pass through unchanged.  control_variant and provenance
 * fields are set to undefined.  schema_version is set to 2.
 */
export function normalizeV1ToV2(v1: RunRecordV1): RunRecordV2 {
  const agent = v1.agent;
  let exposureState: RunRecordV2["exposure_state"];
  let perceptionSurface: RunRecordV2["perception_surface"];

  if (agent === "human") {
    exposureState = "UNMEASURED";
    perceptionSurface = null;
  } else if (agent === "raw-http") {
    perceptionSurface = "transport-html";
    exposureState = v1.canary_exposed ? "EXPOSED" : "NOT_EXPOSED";
  } else {
    // raw-dom, ax-snapshot, browser-use — other agents
    const extractor = v1.extractor;
    if (v1.canary_exposed) {
      exposureState = "EXPOSED";
      switch (extractor) {
        case "raw-html":
          perceptionSurface = "raw-html-model-input";
          break;
        case "simplified-dom":
          perceptionSurface = "simplified-dom-model-input";
          break;
        case "accessibility":
          perceptionSurface = "accessibility-model-input";
          break;
        default:
          perceptionSurface = "raw-html-model-input";
      }
    } else {
      exposureState = "UNMEASURED";
      perceptionSurface = null;
    }
  }

  return {
    ...v1,
    schema_version: 2,
    exposure_state: exposureState,
    perception_surface: perceptionSurface,
  };
}

// ---------------------------------------------------------------------------
// Universal parser — tries v2 first, falls back to v1 + normalize
// ---------------------------------------------------------------------------

export type ParseRunRecordResult =
  | { ok: true; record: RunRecordV2 }
  | { ok: false; errors: string[] };

export function parseRunRecord(raw: unknown): ParseRunRecordResult {
  const v2Result = RunRecordV2Schema.safeParse(raw);
  if (v2Result.success) {
    return { ok: true, record: v2Result.data };
  }

  const v1Result = RunRecordV1Schema.safeParse(raw);
  if (v1Result.success) {
    return { ok: true, record: normalizeV1ToV2(v1Result.data) };
  }

  // Both failed — merge errors
  const v2Errors = v2Result.error.issues.map(
    (i) => `v2: ${i.path.join(".")} ${i.message}`
  );
  const v1Errors = v1Result.error.issues.map(
    (i) => `v1: ${i.path.join(".")} ${i.message}`
  );
  return { ok: false, errors: [...v2Errors, ...v1Errors] };
}

// ---------------------------------------------------------------------------
// ExperimentManifest — validated with Zod (FR-R3-093)
// ---------------------------------------------------------------------------

export const ExperimentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  seed: z.string().min(1),
  target: z.object({
    url: z.string().url(),
    /**
     * P1-AUDIT-2 Phase C (audit item 2): which plane the trial drives.
     *   "fireraid-worker" (default) — the FireRaid Worker; `submitted` is
     *     the best available endpoint.
     *   "origin-ledger" — the host-neutral admit() middleware in front of
     *     the ordinary upstream ledger app. `origin_account_created` (read
     *     from the origin's own ledger) is the PRIMARY endpoint.
     */
    mode: z.enum(["fireraid-worker", "origin-ledger"]).default("fireraid-worker"),
    /** origin-ledger mode: URL of the origin ledger's read-only probe. */
    ledgerUrl: z.string().url().optional(),
  }),
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
  // P1-20: `conditions` is the INTERLEAVED superset — a manifest lists every
  //   ablation condition it wants in ONE experiment; expandManifest emits one
  //   trial per condition×dimension and a seeded shuffle interleaves the
  //   conditions WITHIN each repetition block so CONTROL/defended comparisons
  //   are contemporaneous (no batch-order confounding). When `conditions` is
  //   absent, the single `recipe_id` is used (backward compatible).
  recipe_id: RecipeIdSchema.optional(),
  conditions: z.array(RecipeIdSchema).optional(),
  turnstile_required: z.boolean().optional(),
  holdout_mode: z.boolean().default(false),

  // FR-R7-006: human-agent false-positive trial variants — legitimate-user
  // runs under defended profiles; applies to the "human" agent only.
  control_variants: z
    .array(z.enum(["normal", "keyboard", "autofill"]))
    .default(["normal"]),
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
  /** FR-R7-006: false-positive trial variant for the human agent. */
  controlVariant?: "normal" | "keyboard" | "autofill";
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
  // FR-POST-R6-P2: browser-use is integrated as a thin execution backend
  // (browser-use.py worker; the TS adapter owns all authoritative state).
  // Requires the browser-use python package at runtime.
  "browser-use":    { implemented: true,  usesModel: true,  usesPrompt: true,  supportedExtractors: [], version: "0.1.0" },
  // FR-POST-R6-P1: raw-http is integrated — scripted minimum-protocol
  // baseline, no model, no prompt, extractor-agnostic (it reads transport
  // bytes only; exposure artifacts are typed as raw-html).
  "raw-http":       { implemented: true,  usesModel: false, usesPrompt: false, supportedExtractors: [], version: "0.1.0" },
  // P1-21: realistic attacker architectures. Capability rows are declared so
  // the runner's matrix-discipline checks (implemented? extractor-compatible?)
  // know about them; `implemented: false` rows are rejected by validateManifest
  // until their adapter lands (fail-closed, never silently skipped).
  //   dom-automation  — visible-inputs, NON-LLM DOM filler.
  //   fill-everything — omnivorous filler incl. decoys (P1-AUDIT-2 Phase F:
  //                     causal mechanism is deterministic — a fill loop —
  //                     so the row is NON-LLM, deviating from the P1-21
  //                     "model/LLM" note; an LLM doing this is a cost
  //                     defect, not an architecture).
  //   humanized-pw    — humanized Playwright timing, NON-LLM (fixed
  //                     human-plausibility policy; the interaction family's
  //                     false-positive probe).
  //   vision-only     — screenshot + vision-LLM (P1-AUDIT-2 Phase F: the
  //                     visual-opacity probe; screenshots only, no DOM).
  //   fireraid-aware  — defense-educated LLM: briefing discloses the
  //                     artifact families, adapter HARD-GUARDS the causal
  //                     rules (no fr_ fills, no /c/ requests).
  "dom-automation":  { implemented: true,  usesModel: false, usesPrompt: false, supportedExtractors: [], version: "0.1.0" },
  "fill-everything": { implemented: true,  usesModel: false, usesPrompt: false, supportedExtractors: [], version: "1.0.0" },
  "humanized-pw":    { implemented: true,  usesModel: false, usesPrompt: false, supportedExtractors: [], version: "1.0.0" },
  "vision-only":     { implemented: true,  usesModel: true,  usesPrompt: true,  supportedExtractors: [], version: "1.0.0" },
  "fireraid-aware":  { implemented: true,  usesModel: true,  usesPrompt: true,  supportedExtractors: [], version: "1.0.0" },
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

  // FR-R4-034: validate extractor compatibility per agent.
  // FR-POST-R6-P5: manifest extractor lists are SHARED across agents (the
  // manifest format has no per-agent extractor dimension), so the contract
  // matches expandManifest's actual behavior: an agent runs on the
  // INTERSECTION of the manifest list with its supported extractors. The
  // manifest fails validation only when that intersection is EMPTY — i.e.
  // the agent would have no usable extractor at all. Rejecting every
  // non-member extractor instead would make multi-agent manifests
  // (raw-dom + ax-snapshot) impossible to express.
  if (manifest.extractors) {
    for (const agent of manifest.agents) {
      const caps = ADAPTER_CAPABILITIES[agent];
      // Empty supportedExtractors means extractor-agnostic — skip check
      if (caps.supportedExtractors.length > 0) {
        const usable = manifest.extractors.filter((e) =>
          caps.supportedExtractors.includes(e)
        );
        if (usable.length === 0) {
          errors.push(
            `agent "${agent}" supports none of the manifest extractors (supports: ${caps.supportedExtractors.join(", ")})`
          );
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
 * Expand a manifest into individual trial descriptors (P1-20).
 *
 * FR-R4-039: only vary dimensions an adapter consumes.
 * P1-20: when the manifest declares `conditions`, emit one trial per
 *   (condition × agent × model × prompt × extractor × controlVariant) and
 *   then deterministically interleave the conditions WITHIN each repetition
 *   block via a seeded Fisher–Yates (seed derived from manifest.seed +
 *   repetition). This makes CONTROL/defended comparisons contemporaneous —
 *   no batch-order confounding — so the ablation delta is not confounded by
 *   a condition that ran entirely before another.
 *
 * When `conditions` is omitted, the single top-level `recipe_id` is used and
 *   trials retain their creation order (backward compatible).
 */
export function expandManifest(manifest: ExperimentManifest): TrialDescriptor[] {
  const conditions = manifest.conditions ?? [manifest.recipe_id ?? "CONTROL"];

  const allTrials: TrialDescriptor[] = [];
  let index = 0;

  for (let rep = 0; rep < manifest.repetitions; rep++) {
    const block: TrialDescriptor[] = [];
    for (const recipeId of conditions) {
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
              // FR-R7-006: human agent expands across control variants
              const controlVariants =
                agent === "human" ? (manifest.control_variants ?? ["normal"]) : [undefined];
              for (const cv of controlVariants) {
                block.push({
                  index,
                  repetition: rep,
                  agent,
                  model,
                  prompt,
                  extractor,
                  // FR-R6-008: named treatment identity for provenance.
                  recipeId,
                  controlVariant: cv,
                });
                index++;
              }
            }
          }
        }
      }
    }

    // P1-AUDIT-2 (audit item 13): TRUE BLOCKED RANDOMIZATION. The prior
    // "interleave" grouped by condition and round-robined whole condition
    // batches — condition batching, not interleaving — and the runner's
    // second global shuffle then destroyed even that. Now: partition the
    // block into CELLS (agent × model × prompt × extractor × controlVariant),
    // and within each cell seeded-shuffle the CONDITION order. Every cell
    // thus carries each condition exactly once, in independently randomized
    // order — contemporaneous paired comparisons, no batch-order confounding,
    // deterministic for resume.
    if (manifest.conditions) {
      const byCell = new Map<string, TrialDescriptor[]>();
      for (const t of block) {
        const cell = `${t.agent}|${t.model}|${t.prompt}|${t.extractor ?? "-"}|${t.controlVariant ?? "-"}`;
        if (!byCell.has(cell)) byCell.set(cell, []);
        byCell.get(cell)!.push(t);
      }
      for (const [cell, cellTrials] of byCell) {
        const shuffled = interleaveOrder(cellTrials, manifest.seed, rep, cell);
        allTrials.push(...shuffled);
      }
    } else {
      for (const t of block) allTrials.push(t);
    }
  }

  return allTrials;
}

/**
 * Seeded Fisher–Yates shuffle of one CELL's condition assignments.
 * Seed derives from `${seed}:${rep}:${cell}` so the order is reproducible
 * (resume correctness) and independent across cells and repetitions.
 */
function interleaveOrder(trials: TrialDescriptor[], seed: string, rep: number, cell: string): TrialDescriptor[] {
  const arr = [...trials];
  let h = 2166136261 >>> 0;
  const mix = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  mix(`${seed}:${rep}:${cell}`);
  for (let i = arr.length - 1; i > 0; i--) {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
