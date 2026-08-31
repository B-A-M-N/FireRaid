/**
 * Experiment runner — executes declarative experiment manifests.
 * FR-INV-009: experiments must be reproducible.
 * FR-INV-010: measured results must not be confused with sample numbers.
 * FIX: Full orchestration with manifest validation, matrix expansion, adapter loading (FR-R3-027).
 * FIX: Server reconciliation via lab correlation API.
 * FR-R4-028/032/033: real server correlation (lab runs).
 * FR-R4-041/042: scenario.maxSteps = manifest.max_steps; modelConfig mapping.
 * FR-R4-081: git provenance in every record.
 * FR-R4-082: dirty-repo gate.
 * FR-R4-083: per-adapter version from ADAPTER_CAPABILITIES.
 * FR-R4-085: real resume with per-key status tracking.
 * FR-R4-086: fail closed on missing non-default fixture.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadHarnessEnv } from "./model.js";
// P1-AUDIT-2 Phase C: origin-ledger runtime + named ablation conditions.
import { startOriginLedgerRuntime, trialEmail, type OriginLedgerRuntime } from "./origin-ledger.js";
import { ABLATION_RECIPES } from "../../src/core/profile.js";
// Imported lazily-resolved at top level so browserProvenance can use it
// without a forbidden require(): the import itself must not launch anything.
import * as playwrightCore from "playwright-core";
import { createHash } from "node:crypto";
import {
  validateManifest,
  expandManifest,
  Recorder,
  generateRunId,
  ADAPTER_CAPABILITIES,
  type ExperimentManifest,
  type RunRecordV2,
  type AgentType,
  type AgentAdapter,
  type LabRunContext,
} from "./index.js";
import { RawDomAdapter } from "../adapters/raw-dom.js";
import { RawHttpAdapter } from "../adapters/raw-http.js";
import { BrowserUseAdapter } from "../adapters/browser-use-adapter.js";
import { HumanControlAdapter } from "../adapters/human-control.js";
import { AxSnapshotAdapter } from "../adapters/ax-snapshot/ax-snapshot.js";
import { DomAutomationAdapter } from "../adapters/dom-automation.js";

const RESULTS_DIR = join(process.cwd(), "harness", "results");

/**
 * Resume state for a single experiment — per-key status tracking (FR-R4-085).
 */
interface ResumeState {
  experiment_id: string;
  manifest_hash: string;
  trials_total: number;
  trials_completed: number;
  trials: Array<{
    key: string; // "${agent}:${model}:${prompt}:${extractor ?? "-"}:${repetition}"
    status: "COMPLETE" | "ERROR" | "TIMEOUT";
  }>;
  completed_at?: string;
}

/**
 * Adapter registry — maps agent type to factory.
 * FR-R4-085: stable trial key = "${manifest.id}:${agent}:${model}:${prompt}:${extractor ?? "-"}:${repetition}".
 */
function createAdapter(agent: AgentType, extractor?: string): AgentAdapter {
  switch (agent) {
    case "human":
      return new HumanControlAdapter();
    case "raw-dom":
      return new RawDomAdapter((extractor as "raw-html" | "simplified-dom") || "raw-html");
    case "ax-snapshot":
      return new AxSnapshotAdapter();
    // FR-POST-R6-P1: scripted non-LLM baseline — ignores page semantics.
    case "raw-http":
      return new RawHttpAdapter();
    // P1-21: DOM-automation — visible-inputs, non-LLM DOM filler.
    case "dom-automation":
      return new DomAutomationAdapter();
    // FR-POST-R6-P2: browser abstraction agent via python execution worker.
    case "browser-use":
      return new BrowserUseAdapter();
    default:
      throw new Error(`No adapter registered for agent: ${agent}`);
  }
}

/**
 * FR-POST-R6-P5: resolve a manifest model entry to the concrete model id a
 * trial runs with. The sentinel "FIRERAID_LLM_MODEL" means "whatever
 * FIRERAID_LLM_MODEL is configured at pilot time" — resolved ONCE per
 * process so a pilot uses one model consistently, and the resolved id is
 * what every RunRecord records (exact provenance, never the placeholder).
 *
 * FR-R4-039 boundary: a model-AGNOSTIC agent (usesModel=false — human,
 * raw-http) never consumes the model dimension, so its model column is
 * bookkeeping, not provenance — the sentinel resolves to "none" there
 * rather than failing the trial. A model-CONSUMING agent (usesModel=true)
 * with an unresolvable sentinel is a hard error: an LLM trial must never
 * record a fabricated model id.
 */
function resolveModelId(model: string, usesModel: boolean): string {
  if (model === "FIRERAID_LLM_MODEL") {
    const resolved = process.env.FIRERAID_LLM_MODEL;
    if (!resolved) {
      if (usesModel) {
        throw new Error(
          "manifest model FIRERAID_LLM_MODEL but FIRERAID_LLM_MODEL env is unset — refusing to record a fabricated model id"
        );
      }
      return "none"; // model-agnostic agent: dimension not consumed
    }
    return resolved;
  }
  return model;
}

/**
 * Stable trial key for resume (FR-R4-085).
 * FR-P0-8: controlVariant is part of trial identity — without it the
 * normal/keyboard/autofill variants of one human cell collide in resume
 * state and later variants get skipped as "already completed".
 * P1-AUDIT-2: recipeId is part of trial identity — without it CONTROL
 * and FULL expansions of the same cell share one key, so resume state
 * collapses them (a completed CONTROL marks FULL already-complete on a
 * restarted run, and the lab_runs trial_key column silently reuses the
 * same identity for different treatments).
 */
function trialKey(manifestId: string, trial: {
  recipeId?: string;
  agent: AgentType;
  model: string;
  prompt: string;
  extractor?: string;
  repetition: number;
  controlVariant?: "normal" | "keyboard" | "autofill";
}): string {
  return `${manifestId}:${trial.recipeId ?? "-"}:${trial.agent}:${trial.model}:${trial.prompt}:${trial.extractor ?? "-"}:${trial.controlVariant ?? "-"}:${trial.repetition}`;
}

/**
 * Git provenance helpers (FR-R4-081).
 */
function getGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return undefined;
  }
}

function isGitDirty(): boolean | undefined {
  try {
    const output = execSync("git status --porcelain").toString();
    return output.length > 0;
  } catch {
    return undefined;
  }
}

/**
 * FR-POST-R6-P8: real browser provenance. The schema declares
 * browser_name/browser_version but nothing captured them — records carried
 * null while every Playwright-based adapter (human, raw-dom, ax-snapshot)
 * actually launches Chromium. Resolve the versions ONCE per process from
 * the installed Playwright browser (never fabricated: absent registry →
 * undefined, and the record omits it). Scripted agents (raw-http, and
 * browser-use which runs its own python-managed browser) intentionally
 * leave these unset — their browser provenance is recorded elsewhere.
 */
let browserProvenanceCache: { name: string; version: string } | null | undefined;
function browserProvenance(): { browser_name?: string; browser_version?: string } {
  if (browserProvenanceCache === undefined) {
    try {
      const { chromium } = playwrightCore as typeof import("playwright-core");
      const path = chromium.executablePath();
      const out = execFileSync(path, ["--version"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      // Browser builds report e.g. "Chromium 143.0.5716.0" or
      // "Google Chrome for Testing 151.0.7922.34" — split name/version.
      const m = out.trim().match(/^(.*?[A-Za-z])\s+([\d.]+.*)$/);
      browserProvenanceCache = m
        ? { name: m[1], version: m[2] }
        : { name: "unknown", version: out.trim() };
    } catch {
      browserProvenanceCache = null; // not resolvable — omit, never fabricate
    }
  }
  return browserProvenanceCache
    ? { browser_name: browserProvenanceCache.name, browser_version: browserProvenanceCache.version }
    : {};
}

/** Which adapters launch a browser through THIS harness's Playwright install. */
function usesPlaywrightBrowser(agent: AgentType): boolean {
  return agent === "human" || agent === "raw-dom" || agent === "ax-snapshot";
}

/**
 * FR-P0-7: where exposure was measured, per agent + extractor — the v2
 * perception_surface. null exactly when no perception artifact exists
 * (UNMEASURED): the human adapter captures no model input, raw-http always
 * has the transport HTML, browser-use observes pages through its own engine.
 */
function agentPerceptionSurface(
  agent: AgentType,
  extractor: string | undefined,
  artifactPresent: boolean
): RunRecordV2["perception_surface"] {
  if (!artifactPresent) return null;
  switch (agent) {
    case "human":
      // The human-control adapter captures no perception artifact; this is
      // only reachable if artifacts appear for it later (e.g. screenshots).
      return "human-visual";
    case "raw-http":
      return "transport-html";
    case "raw-dom":
      return extractor === "simplified-dom" ? "simplified-dom-model-input" : "raw-html-model-input";
    case "ax-snapshot":
      return "accessibility-model-input";
    case "browser-use":
      return "browser-use-observation";
    default:
      return null;
  }
}

/**
 * Create a lab run on the server and return { runId, bindToken }.
 * FR-R4-028/033: server-generated run_id used instead of generateRunId().
 * FR-R6-008: the runner transmits the FULL trial provenance — experiment_id,
 * trial_key, recipe_id, turnstile_required — so those fields become immutable
 * server-side records of which condition was assigned, not harness-side
 * bookkeeping that can drift from server truth.
 */
async function createLabRun(
  targetUrl: string,
  manifest: ExperimentManifest,
  trial: { recipeId?: string; trialKey: string }
): Promise<{ runId: string; bindToken: string }> {
  const secret = process.env.FIRERAID_LAB_API_SECRET;
  if (!secret) throw new Error("FIRERAID_LAB_API_SECRET not set for lab mode");

  const resp = await fetch(`${targetUrl}/api/lab/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      experiment_id: manifest.id,
      // FR-R6-008: immutable provenance fields — the server records exactly
      // which condition was assigned to this trial.
      trial_key: trial.trialKey,
      ...(trial.recipeId !== undefined ? { recipe_id: trial.recipeId } : {}),
      ...(manifest.turnstile_required !== undefined
        ? { turnstile_required: manifest.turnstile_required }
        : {}),
      // FR-POST-R6-P5: dev/holdout partition freeze is part of the assigned
      // treatment — the server restricts the random template pool to the
      // holdout partition (S07–S08) when set.
      ...(manifest.holdout_mode ? { holdout_mode: true } : {}),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Lab run creation failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as { run_id: string; bind_token: string };
  if (!data.run_id || !data.bind_token) {
    throw new Error("Lab run response missing run_id or bind_token");
  }

  return { runId: data.run_id, bindToken: data.bind_token };
}

/**
 * P1-AUDIT-2 (audit item 16): does ANY perception artifact contain the
 * EXACT issued treatment material? A hit on the semantic nonce, the decoy
 * field name, or the route token is real exposure — these strings are
 * session-bound and unpredictable, so seeing one means the artifact bytes
 * (== the model's input) carried issued material. Exported for tests.
 */
export function exactMaterialInArtifacts(
  artifacts: Array<{ content: string }>,
  material?: {
    semantic_nonce?: string | null;
    decoy_field_name?: string | null;
    route_token?: string | null;
  } | null
): boolean {
  const exactNeedles = [
    material?.semantic_nonce,
    material?.decoy_field_name,
    material?.route_token,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  if (exactNeedles.length === 0) return false;
  return artifacts.some((a) => exactNeedles.some((n) => a.content.includes(n)));
}

/**
 * Read server truth for a lab run.
 * FR-R4-033: GET with bearer auth. FR-R5-004: the run reaches status
 * "COMPLETE" only after the explicit outcome POST (below) — never via an
 * implicit auto-reconcile. A run still BOUND/PENDING yields its live truth
 * but reports outcome: null so the record stays server_reconciled: false.
 */
async function fetchServerTruth(
  targetUrl: string,
  runId: string,
  labSecret: string
): Promise<Partial<RunRecordV2> | null> {
  try {
    const resp = await fetch(`${targetUrl}/api/lab/runs/${runId}`, {
      headers: {
        authorization: `Bearer ${labSecret}`,
      },
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      status?: string;
      session_id?: string;
      submitted?: boolean;
      disposition?: string;
      score?: number;
      profile_id?: string;
      profile_version?: number;
      profile_variant_id?: string;
      recipe_id?: string | null;
      defense_families?: string[];
      semantic_template?: string | null;
      placement?: string | null;
      canary_issued?: boolean;
      canary_exposed?: boolean;
      canary_verified_server?: boolean;
      outcome?: string | null;
      // P1-AUDIT-2 (audit item 16): exact issued per-family material.
      treatment_material?: {
        semantic_nonce?: string | null;
        decoy_field_name?: string | null;
        route_token?: string | null;
      } | null;
    };

    // Server truth is only authoritative once the outcome has been recorded.
    if (data.status === "COMPLETE" && data.outcome) {
      return {
        session_id: data.session_id,
        submitted: data.submitted ?? false,
        disposition: data.disposition as "ACCEPT" | "REVIEW" | "QUARANTINE" | undefined,
        score: data.score,
        profile_id: data.profile_id ?? "unknown",
        profile_version: data.profile_version,
        profile_variant_id: data.profile_variant_id,
        // FR-POST-R6-P6: recipe_id is part of SERVER truth — the run row's
        // immutable condition label must land in the record (the pilot
        // invariant check reads it from the record, and the analyzer's
        // FR-R5-049 baseline rule groups on it).
        recipe_id: data.recipe_id ?? undefined,
        defense_families: data.defense_families ?? [],
        semantic_template: data.semantic_template ?? undefined,
        placement: data.placement ?? undefined,
        canary_issued: data.canary_issued ?? undefined,
        // canary_exposed deliberately absent — it is an AGENT-side
        // observation derived from exposure_state at the merge site.
        canary_verified_server: data.canary_verified_server ?? false,
        // P1-AUDIT-2: exact treatment material — the issued nonce/field/token
        // the exposure derivation post-hoc-matches against perception
        // artifacts. Structurally optional: an older worker response without
        // the field simply yields no exact-material signal.
        treatment_material: data.treatment_material ?? undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * FR-R5-006: report the terminal outcome to the lab API. Transitions
 * BOUND → COMPLETE server-side. Best-effort — a rejected outcome (e.g. run
 * already terminal) is logged, never thrown; reconciliation below will
 * reflect whatever state the server actually reached.
 */
async function postLabRunOutcome(
  targetUrl: string,
  runId: string,
  labSecret: string,
  outcome: RunRecordV2["outcome"],
  errorCode?: string | null
): Promise<void> {
  try {
    const resp = await fetch(`${targetUrl}/api/lab/runs/${runId}/outcome`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${labSecret}`,
      },
      body: JSON.stringify({
        outcome,
        ...(errorCode ? { error_code: errorCode } : {}),
      }),
    });
    if (!resp.ok) {
      console.warn(`Lab outcome POST failed for ${runId}: ${resp.status}`);
    }
  } catch (err) {
    console.warn(`Lab outcome POST error for ${runId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Execute a single trial.
 * FR-R4-028/032/033: lab-mode server reconciliation.
 * FR-R4-041/042: scenario maxSteps and modelConfig from manifest.
 * FR-R4-083: adapter version from capabilities.
 */
async function executeTrial(
  manifest: ExperimentManifest,
  trial: ReturnType<typeof expandManifest>[number],
  recorder: Recorder,
  manifestHash: string,
  originRuntime?: OriginLedgerRuntime,
): Promise<RunRecordV2> {
  const labSecret = process.env.FIRERAID_LAB_API_SECRET;
  // P1-AUDIT-2 Phase C: origin-ledger mode drives the middleware facade, not
  // the FireRaid Worker — the FireRaid lab-run lifecycle (create/bind/
  // outcome) does not exist there and its fail-closed creation error would
  // kill every trial. Ledger truth replaces FireRaid truth as the endpoint.
  const labTarget = labSecret && !originRuntime ? manifest.target.url : null;

  const startedAt = Date.now();
  const adapterCaps = ADAPTER_CAPABILITIES[trial.agent];

  // FR-POST-R6-P5: resolve the manifest's model entry to the concrete id
  // before ANY record can be built — the placeholder never reaches a record.
  const modelId = resolveModelId(trial.model, adapterCaps.usesModel);

  // Determine run_id: server-generated in lab mode, fallback to local
  let runId: string;
  let labRunContext: LabRunContext | undefined;
  let labMode = false;

  if (labTarget) {
    try {
      const lab = await createLabRun(labTarget, manifest, {
        recipeId: trial.recipeId,
        trialKey: trialKey(manifest.id, trial),
      });
      runId = lab.runId;
      labRunContext = { runId: lab.runId, bindToken: lab.bindToken };
      labMode = true;
    } catch {
      // FR-R5-021: lab creation failure must fail the trial — do NOT fall back.
      // Build an error record and return it immediately (fail-closed).
      const errorRecord: RunRecordV2 = {
        schema_version: 2,
        run_id: generateRunId(),
        experiment_id: manifest.id,
        trial_index: trial.index,
        repetition: trial.repetition,
        agent: trial.agent,
        model: modelId,
        prompt_variant: trial.prompt,
        extractor: trial.extractor,
        profile_version: manifest.profile_version,
        profile_id: "pending-reconciliation",
        defense_families: [],
        server_reconciled: false,
        submitted: false,
        canary_exposed: false,
        canary_referenced: false,
        canary_generic_referenced: false,
        canary_requested_client: false,
        canary_verified_server: false,
        exposure_state: "UNMEASURED",
        perception_surface: null,
        ...(trial.controlVariant !== undefined ? { control_variant: trial.controlVariant } : {}),
        outcome: "error",
        action_count: 0,
        elapsed_ms: 0,
        error_code: "LAB_RUN_CREATION_FAILED",
        node_version: process.version,
        adapter_version: adapterCaps.version,
        fireraid_git_sha: getGitSha(),
        fireraid_dirty: isGitDirty(),
        manifest_hash: manifestHash,
        started_at: startedAt,
        completed_at: Date.now(),
      };
      recorder.record(errorRecord);
      return errorRecord;
    }
  } else {
    runId = generateRunId();
  }

  const scenario = {
    // P1-AUDIT-2 Phase C: origin-ledger mode drives the middleware facade
    // (worker-shaped), so existing adapters run unmodified against the
    // REAL defense in front of the ordinary upstream.
    targetUrl: originRuntime ? originRuntime.facadeUrl : manifest.target.url,
    fixture: loadFixture(manifest.fixture),
    promptVariant: trial.prompt,
    model: modelId,
    maxSteps: manifest.max_steps,
    timeoutMs: manifest.timeout_ms,
    modelConfig: {
      temperature: manifest.model_config.temperature,
      maxTokens: manifest.model_config.max_tokens,
    },
    // FR-P0-8: control variants actually reach the adapter — a keyboard-only
    // or autofill-like "human" trial executes that interaction mode, not a
    // rerun of the normal script.
    ...(trial.controlVariant !== undefined ? { controlVariant: trial.controlVariant } : {}),
    labRun: labRunContext,
  };

  const adapter = createAdapter(trial.agent, trial.extractor);

  // P1-AUDIT-2 Phase C: assign THIS trial's condition to the middleware
  // before the adapter runs — the blocked-randomized recipe_id maps to the
  // canonical ablation recipe (CONTROL = {families:[]}, as on the Worker).
  // The middleware derives every profile for the trial under it.
  let ledgerEmail: string | undefined;
  if (originRuntime) {
    const recipe = trial.recipeId ? ABLATION_RECIPES[trial.recipeId] : undefined;
    if (trial.recipeId && !recipe) {
      throw new Error(`origin-ledger mode: unknown recipe_id ${trial.recipeId}`);
    }
    originRuntime.setTrialRecipe(recipe);
    ledgerEmail = trialEmail(manifest.id, trialKey(manifest.id, trial));
    // The synthetic fixture identity must be trial-unique so the ledger
    // lookup is unambiguous — override the email the adapter will submit.
    scenario.fixture = { ...scenario.fixture, email: ledgerEmail };
  }

  // Run the adapter
  const result = await adapter.run(scenario);

  const completedAt = Date.now();

  // Build initial record (agent-side observations).
  // FR-P0-7: v2-native. exposure_state/surface start UNMEASURED and are
  // revised from the perception artifacts below — the old binary
  // canary_exposed was never a measurement for artifact-less agents.
  let record: RunRecordV2 = {
    schema_version: 2,
    run_id: runId,
    experiment_id: manifest.id,
    trial_index: trial.index,
    repetition: trial.repetition,
    agent: trial.agent,
    model: modelId,
    prompt_variant: trial.prompt,
    extractor: trial.extractor,
    profile_version: manifest.profile_version,
    profile_id: "pending-reconciliation",
    defense_families: [],
    // FR-R6-058: session_id is the SERVER-generated session identifier —
    // never the raw cookie value. The cookie stays ephemeral (used only for
    // the bind navigation) and must not be serialized into the record. If
    // reconciliation never happens, session_id stays absent rather than
    // holding a credential.
    // submitted is agent-side until reconciliation replaces it with server
    // truth (r.submitted) — the analyzer reads server truth only.
    submitted: result.outcome === "submitted",
    // FR-R6-054 / FR-P0-7: EXPOSED is an AGENT-side observation — the
    // treatment existed in the model's actual input. Server truth CANNOT
    // measure this. Start UNMEASURED; artifacts below revise it.
    canary_exposed: false, // derived projection of exposure_state (set below)
    exposure_state: "UNMEASURED",
    perception_surface: agentPerceptionSurface(trial.agent, trial.extractor, /* artifactPresent */ false),
    canary_referenced: result.canaryReferenced ?? false,
    canary_generic_referenced: result.canaryGenericReferenced ?? false,
    canary_requested_client: result.canaryTriggered ?? false,
    canary_verified_server: false,
    server_reconciled: false,
    ...(trial.controlVariant !== undefined ? { control_variant: trial.controlVariant } : {}),
    outcome: result.outcome,
    action_count: result.actionCount,
    elapsed_ms: result.elapsedMs,
    error_code: result.errorCode ?? null,
    node_version: process.version,
    adapter_version: adapterCaps.version,
    // FR-P0-9: requested-vs-served LLM provenance from the wire (undefined
    // for model-agnostic agents — the fields stay absent, not fabricated).
    ...(result.llmProvenance
      ? {
          llm_provider_origin: result.llmProvenance.providerOrigin,
          llm_model_requested: result.llmProvenance.modelRequested,
          llm_model_served: result.llmProvenance.modelServed,
        }
      : {}),
    temperature: manifest.model_config.temperature,
    max_tokens: manifest.model_config.max_tokens,
    // FR-POST-R6-P8: real browser provenance for Playwright-based adapters;
    // scripted (raw-http) and python-worker (browser-use) agents stay unset
    // — their execution engine is not this Chromium.
    ...(usesPlaywrightBrowser(trial.agent) ? browserProvenance() : {}),
    fireraid_git_sha: getGitSha(),
    fireraid_dirty: isGitDirty(),
    manifest_hash: manifestHash, // computed once in runExperiment from raw manifest
    lab_mode: labMode,
    started_at: startedAt,
    completed_at: completedAt,
  };

  // FR-R6-054 / FR-P0-7: tri-state exposure from perception artifacts.
  //   artifacts present + canary material seen  → EXPOSED (+ surface)
  //   artifacts present + material demonstrably absent → NOT_EXPOSED
  //   no artifacts captured                     → UNMEASURED (null surface)
  // Issued material is only known after reconciliation, so exposure is
  // computed against BOTH signals:
  //   1. pre-reconciliation: the agent observed generic canary structure
  //      (data-fr-canary / data-fr-marker / data-fr-route attributes, fr_*
  //      decoy fields, /c/ links).
  //   2. post-reconciliation: server truth supplies the exact nonce
  //      (semantic_template issued) — exact-material exposure.
  // The agent-side observation is NEVER overwritten by the server: server
  // truth sets issued/verified, the artifacts set exposure.
  const artifacts = result.perceptionArtifacts ?? [];
  // FR-POST-R6-P4: structural signatures cover ALL issued families —
  // semantic canaries (data-fr-canary), hidden markers (data-fr-marker),
  // route notices (data-fr-route), and decoy fields (fr_<hex> input names).
  const CANARY_STRUCTURES = [
    "data-fr-canary",
    "data-fr-marker",
    "data-fr-route",
    /name="fr_[0-9a-f]+"/,
  ] as const;
  const sawCanaryStructure = artifacts.some((a) =>
    CANARY_STRUCTURES.some((s) =>
      typeof s === "string" ? a.content.includes(s) : s.test(a.content)
    )
  );
  const artifactPresent = artifacts.length > 0;
  let exposureState: RunRecordV2["exposure_state"] = artifactPresent
    ? sawCanaryStructure
      ? "EXPOSED"
      : "NOT_EXPOSED"
    : "UNMEASURED";
  let perceptionSurface = agentPerceptionSurface(trial.agent, trial.extractor, artifactPresent);

  // Reconcile with server truth (FR-R4-028/032/033, FR-R5-006).
  // The session↔run association happened server-side during the bind-aware
  // /signup navigation (signup.ts consumes ?lab_run=&bind=) — the runner does
  // NOT re-POST /associate here (the bind token is single-use; a second call
  // is the FR-R5-006 double-bind bug). The runner only: reports the terminal
  // outcome, then reads authoritative truth.
  if (labTarget && labRunContext && labSecret) {
    try {
      // FR-R5-006: terminal outcome POST — BOUND → COMPLETE
      await postLabRunOutcome(labTarget, runId, labSecret, record.outcome, record.error_code);

      // Fetch authoritative server truth
      const serverTruth = await fetchServerTruth(labTarget, runId, labSecret);

      if (serverTruth) {
        // P1-AUDIT-2 (audit item 16): EXACT-material exposure. Server truth
        // now carries the ISSUED material (semantic nonce / decoy field name
        // / route token); an artifact containing that exact string is real
        // exposure. The prior check compared generic shapes ("/c/",
        // "data-fr-marker") gated on semantic_template — it never saw the
        // issued material, so "exact" was a misnomer.
        const exactMaterialExposed = exactMaterialInArtifacts(
          artifacts,
          serverTruth.treatment_material
        );
        if (exactMaterialExposed && exposureState !== "EXPOSED") {
          exposureState = "EXPOSED";
          perceptionSurface = agentPerceptionSurface(trial.agent, trial.extractor, true);
        }
        record = {
          ...record,
          ...serverTruth,
          // FR-R6-054: preserve the AGENT-side exposure observation — the
          // spread must not let server-side canary_exposed (always false, the
          // server cannot observe the agent's input) clobber what the
          // perception artifacts showed.
          canary_exposed: exposureState === "EXPOSED",
          exposure_state: exposureState,
          perception_surface: perceptionSurface,
          server_reconciled: true,
        };
      } else {
        record.server_reconciled = false;
        record.error_code = record.error_code ?? "SERVER_RECONCILIATION_FAILED";
      }
    } catch {
      record.server_reconciled = false;
      record.error_code = record.error_code ?? "SERVER_RECONCILIATION_FAILED";
    }
  }

  // Non-lab (no server) runs: exposure still comes from the artifacts.
  if (!record.server_reconciled) {
    record.canary_exposed = exposureState === "EXPOSED";
    record.exposure_state = exposureState;
    record.perception_surface = perceptionSurface;
  }

  // P1-AUDIT-2 Phase C (audit item 2): reconcile against the ORIGIN ledger —
  // the PRIMARY endpoint. Did the ordinary upstream actually create the
  // account? Read-only probe; probe failure records UNKNOWN (undefined),
  // never a silent false. In this mode `record.submitted` means only "the
  // agent reached the middleware's submit endpoint" (secondary measurement).
  if (originRuntime && ledgerEmail) {
    const created = await originRuntime.ledgerHasAccount(ledgerEmail);
    record.origin_account_created = created ?? false;
    record.origin_ledger_mode = "read-only-probe";
    if (created === null) {
      // The primary outcome is UNKNOWABLE — same epistemic class as a
      // FireRaid reconciliation failure, so same failure semantics.
      record.error_code = record.error_code ?? "ORIGIN_RECONCILIATION_FAILED";
      record.server_reconciled = false;
    } else {
      record.server_reconciled = true;
    }
  }

  // FR-R6-057: in authoritative lab mode, an unreconciled run is a BROKEN
  // run — it must never be marked COMPLETE in resume state (resume would
  // skip it forever and the hole would silently disappear from reports).
  // Explicitly-exploratory mode may opt out via manifest flag.
  if (labMode && !record.server_reconciled && record.outcome !== "error") {
    record.outcome = "error";
    record.error_code = record.error_code ?? "SERVER_RECONCILIATION_FAILED";
  }

  // FR-P0-13: persist the run's actual evidence (transcript + perception
  // artifacts) before the record, then record the paths. Artifacts carry
  // hash-consistent content, so a verifier can rehash each artifact file
  // and compare with artifact hash values inside the record. transcript
  // and artifacts are already credential-free (cookies/bind tokens are
  // never placed into them by the adapters).
  try {
    const paths = recorder.writeEvidence(record.run_id, {
      transcript: result.transcript,
      perceptionArtifacts: artifacts,
    });
    record.transcript_path = paths.transcriptPath;
    record.perception_artifact_dir = paths.artifactDir;
  } catch (err) {
    // P1-AUDIT-2 (audit item 15): evidence write failure INVALIDATES the
    // evidence-dependent measurements — exposure_state is derived from the
    // perception artifacts, and without the persisted bytes the claim is
    // unverifiable (the hash can't be rechecked against any file). The run
    // still records, but its exposure measurement is demoted to UNMEASURED
    // and the record carries an explicit error code — never a silent
    // warn-and-COMPLETE with an unverifiable EXPOSED/NOT_EXPOSED verdict.
    console.warn(`evidence write failed for ${record.run_id}:`, err instanceof Error ? err.message : err);
    record.exposure_state = "UNMEASURED";
    record.perception_surface = null;
    record.error_code = record.error_code ?? "EVIDENCE_WRITE_FAILED";
  }

  recorder.record(record);
  return record;
}

/**
 * Load fixture by name.
 * FR-R4-086: fail closed if non-default fixture is missing.
 */
function loadFixture(name: string): Record<string, string> {
  const fixturePath = join(process.cwd(), "harness", "fixtures", `${name}.json`);
  if (existsSync(fixturePath)) {
    return JSON.parse(readFileSync(fixturePath, "utf-8"));
  }

  // FR-R4-086: only "default" falls back to built-in
  if (name === "default") {
    return {
      name: "Casey Example",
      email: "casey@example.invalid",
      organization: "Example Research",
      intended_use: "Research purposes",
      password: "synthetic-password-123",
    };
  }

  throw new Error(`Fixture not found: ${name} (tried harness/fixtures/${name}.json)`);
}

/**
 * Write resume state with actual trial statuses (FR-R4-085).
 * FR-POST-R6-P6: ensure the experiment directory exists — a pilot whose
 * EVERY trial failed before the first record (e.g. unresolvable models)
 * otherwise crashes on the final write instead of reporting cleanly.
 */
function writeResumeState(resumePath: string, state: ResumeState): void {
  mkdirSync(join(resumePath, ".."), { recursive: true });
  writeFileSync(resumePath, JSON.stringify(state, null, 2));
}

/**
 * Run a complete experiment from a manifest.
 * FR-R4-082: dirty-repo gate.
 * FR-R4-085: real resume with per-key status.
 */
export async function runExperiment(manifestPath: string): Promise<void> {
  // FR-P0-11: attack-plane credentials (harness/.env) load before anything
  // reads FIRERAID_* — model resolution and lab secrets included.
  loadHarnessEnv();

  // Load and validate manifest
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const result = validateManifest(raw);

  if (!result.ok) {
    console.error("Invalid manifest:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const manifest = result.data;
  console.log(`Experiment: ${manifest.name} (${manifest.id})`);
  console.log(`Agents: ${manifest.agents.join(", ")}`);
  console.log(`Models: ${manifest.models.join(", ")}`);
  console.log(`Prompts: ${manifest.prompts.join(", ")}`);
  console.log(`Repetitions: ${manifest.repetitions}`);
  console.log(`Seed: ${manifest.seed}`);

  // Compute manifest hash for provenance.
  // FR-POST-R6-P8: CANONICAL key-sorted serialization (closes FR-R5-012's
  // noted future work) — two key orderings of the same manifest now hash
  // identically, so the hash identifies manifest CONTENT, not file layout.
  const canonicalJson = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",")}}`;
    }
    return JSON.stringify(v);
  };
  const manifestHash = createHash("sha256").update(canonicalJson(raw)).digest("hex");
  console.log(`Manifest hash: ${manifestHash}`);

  // FR-R4-082: dirty-repo gate
  const dirty = isGitDirty();
  if (dirty === true && process.env.FIRERAID_ALLOW_DIRTY !== "1") {
    console.error("ERROR: Repository has uncommitted changes. Set FIRERAID_ALLOW_DIRTY=1 to override.");
    process.exit(1);
  }

  // Expand into trials. P1-AUDIT-2 (audit item 13): NO global shuffle —
  // expandManifest now emits true blocked randomization (per-cell condition
  // order is seeded-shuffled inside each repetition block). A second global
  // shuffle here would destroy that block structure and re-introduce the
  // batch-order confounding the blocks exist to prevent.
  const trials = expandManifest(manifest);
  console.log(`Total trials: ${trials.length}`);

  // FR-R4-085: Check for existing resume state with stable per-key tracking
  const resumePath = join(RESULTS_DIR, manifest.id, "resume.json");
  const completedKeys = new Map<string, "COMPLETE" | "ERROR" | "TIMEOUT">();

  if (existsSync(resumePath)) {
    try {
      const resume = JSON.parse(readFileSync(resumePath, "utf-8")) as ResumeState;
      if (resume.manifest_hash === manifestHash) {
        for (const t of resume.trials || []) {
          completedKeys.set(t.key, t.status);
        }
        const doneCount = [...completedKeys.values()].filter((s) => s === "COMPLETE").length;
        console.log(`Resuming: ${doneCount} trials already completed, ${completedKeys.size} total tracked`);
      }
    } catch {
      // Ignore corrupt resume
    }
  }

  const recorder = new Recorder(manifest.id);

  // P1-AUDIT-2 Phase C (audit item 2): origin-ledger mode — start the
  // middleware + ordinary upstream runtime so trials drive the REAL defense
  // in front of the REAL origin, and ledger truth becomes the endpoint.
  let originRuntime: OriginLedgerRuntime | undefined;
  if (manifest.target.mode === "origin-ledger") {
    originRuntime = await startOriginLedgerRuntime({
      secret: process.env.FIRERAID_PROFILE_SECRET ?? "harness-local-secret".padEnd(32, "0"),
      version: manifest.profile_version,
      labMode: false,
    });
    console.log(`Origin ledger runtime up: facade=${originRuntime.facadeUrl} ledger=${originRuntime.ledgerUrl}`);
  }

  // Execute trials sequentially
  // (per-trial status is tracked in resumeTrials; no separate counter needed)
  const resumeTrials: ResumeState["trials"] = [];

  for (let i = 0; i < trials.length; i++) {
    const trial = trials[i];
    const key = trialKey(manifest.id, trial);

    const existingStatus = completedKeys.get(key);

    // FR-R4-085: SKIP COMPLETE, retry ERROR/TIMEOUT only if retry_failed
    if (existingStatus === "COMPLETE") {
      console.log(
        `\n[${i + 1}/${trials.length}] SKIP ${trial.agent} / ${trial.model} / ${trial.prompt} (already completed)`
      );
      // Still add to resume state for final write
      resumeTrials.push({ key, status: "COMPLETE" });
      continue;
    }

    if (existingStatus) {
      if (!manifest.retry_failed) {
        console.log(
          `\n[${i + 1}/${trials.length}] SKIP ${trial.agent} / ${trial.model} / ${trial.prompt} (${existingStatus}, retry_failed=false)`
        );
        resumeTrials.push({ key, status: existingStatus });
        continue;
      }
      console.log(
        `\n[${i + 1}/${trials.length}] RETRY ${trial.agent} / ${trial.model} / ${trial.prompt} (was ${existingStatus}, retrying)`
      );
    } else {
      console.log(
        `\n[${i + 1}/${trials.length}] ${trial.agent} / ${trial.model} / ${trial.prompt} (rep ${trial.repetition})`
      );
    }

    try {
      const record = await executeTrial(manifest, trial, recorder, manifestHash, originRuntime);
      console.log(
        `  Result: ${record.outcome} in ${record.elapsed_ms}ms (${record.action_count} actions)`
      );
      if (record.submitted) {
        console.log(`  Disposition: ${record.disposition} | Score: ${record.score}`);
      }

      // Determine status from the record
      const status: "COMPLETE" | "ERROR" | "TIMEOUT" =
        record.error_code === "TIMEOUT" || record.outcome === "timeout"
          ? "TIMEOUT"
          : record.outcome === "error"
            ? "ERROR"
            : "COMPLETE";

      resumeTrials.push({ key, status });

      // Write incremental resume after each trial (FR-R4-085)
      const partialState: ResumeState = {
        experiment_id: manifest.id,
        manifest_hash: manifestHash,
        trials_total: trials.length,
        trials_completed: resumeTrials.filter((t) => t.status === "COMPLETE").length,
        trials: resumeTrials,
      };
      writeResumeState(resumePath, partialState);
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);

      // Record failure in resume even if the trial threw
      resumeTrials.push({ key, status: "ERROR" });
    }
  }

  // Save final resume state with actual statuses (FR-R4-085)
  const finalState: ResumeState = {
    experiment_id: manifest.id,
    manifest_hash: manifestHash,
    trials_total: trials.length,
    trials_completed: resumeTrials.filter((t) => t.status === "COMPLETE").length,
    trials: resumeTrials,
    completed_at: new Date().toISOString(),
  };
  writeResumeState(resumePath, finalState);

  // Print summary
  const runs = Recorder.loadExperiment(manifest.id);
  const metrics = Recorder.computeMetrics(runs);

  console.log(`\n=== Summary ===`);
  console.log(`Attempts: ${metrics.attempts}`);
  console.log(`Valid: ${metrics.valid}`);
  console.log(`Submitted: ${metrics.submitted}`);
  console.log(`Stopped: ${metrics.stopped}`);
  console.log(`Handoff: ${metrics.handoff}`);
  console.log(`Quarantined: ${metrics.quarantined}`);
  console.log(`Review: ${metrics.review}`);
  console.log(`Canary verified: ${metrics.canary_verified}`);
  console.log(`Median elapsed: ${metrics.median_elapsed}ms`);
  console.log(`Error rate: ${(metrics.error_rate * 100).toFixed(1)}%`);
  console.log(`Authoritative effectiveness metrics: npm run analyze -- ${manifest.id}`);

  // P1-AUDIT-2 Phase C: tear down the origin-ledger runtime (if any).
  await originRuntime?.shutdown();
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: tsx harness/core/runner.ts <manifest.json>");
    process.exit(1);
  }
  runExperiment(manifestPath);
}
