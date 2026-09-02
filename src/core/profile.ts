/**
 * Deterministic defense profile generation (FR-INV-002, FR-INV-011).
 * Reconstructable purely from (secret, version, session_id).
 * FIX: Accepts explicit version parameter for reconstruction.
 * FIX: Filters placements by environment eligibility and template allowedPlacements.
 * FIX: Deep canonical hashProfile (FR-037).
 * FIX: Environment filtering (FR-R2-016).
 * FR-R5-016: mode-eligibility fails closed for explicit overrides.
 * FR-R5-034: holdoutMode partitions templates by `partition` field.
 *
 * PRODUCT/EVALUATION SPLIT (audit: production override leakage):
 *   - deriveProductionProfile — THE production API. No mode, no recipe, no
 *     holdout: always the production random composition (P02/P03/P04 +
 *     mandatory independent layer). A deployment cannot configure its way
 *     into a weak lab condition through this entry point.
 *   - deriveEvaluationProfile — the evaluation entry. Accepts a recipe /
 *     holdout / Turnstile treatment. Calls the same lower-level engine.
 *   - deriveProfilePure — the shared engine. `mode` is MANDATORY (no lab
 *     default): callers must state which plane they derive for.
 */
import {
  deriveSeed,
  domainStream,
  generateNonce,
  generateToken,
  sampleWithoutReplacement,
  type PrngDomain,
} from "./prng.js";
import {
  SEMANTIC_TEMPLATES,
  PLACEMENTS,
  PRODUCTION_AGENT_STRATEGIES,
} from "./catalog.js";

// Strategy vocabulary re-export: hosts and tests import the production
// strategy pool from the profile module (the composition authority).
export { PRODUCTION_AGENT_STRATEGIES };
import {
  parseDefenseRecipe,
  type DefenseRecipe,
} from "./recipe-schema.js";
import { SPOT_ANCHORS, SEMANTIC_FORM_VARIANT_COUNT } from "./artifacts.js";
import { getPolicyOrThrow } from "./decision.js";
import type {
  DefenseProfile,
  DefenseFamilyName,
} from "../types/profile.js";

// Re-export the type so existing importers keep working:
//   import type { DefenseRecipe } from "./profile.js"
export type { DefenseRecipe };

/**
 * The shared engine, exported under its historical name for the module's
 * internal reconstruct path (same package — not a host-facing API). Hosts
 * must use deriveProductionProfile / deriveEvaluationProfile.
 */
export { deriveProfileEngine as deriveProfilePure };

const FAMILIES: DefenseFamilyName[] = [
  "semantic",
  "decoy-field",
  "decoy-route",
  "interaction",
];

/**
 * Evaluation-plane family pool (the full set). Environment must not
 * restrict which defense families are available to an experiment.
 */
export const LAB_FAMILIES: readonly DefenseFamilyName[] = FAMILIES;

/**
 * P1-AUDIT-2 (P0-12), revised P0-AUDIT-3 (P0-1): ablation recipes.
 *
 * PRODUCTION_DEFAULT is NOT here — deliberately. It is not a recipe-shaped
 * family list; it IS the production derivation path (deriveProductionProfile),
 * marked by { productionDefault: true } and resolved by the engine via
 * resolveRecipeTreatment(). The old "PRODUCTION_FULL" (field+route+interaction,
 * explicitly WITHOUT the mandatory semantic strategy) is renamed
 * PRODUCTION_NONSEMANTIC_FULL: an ablation arm, never the product arm.
 *
 * Every entry here must remain an ABLATION of the shipped treatment. If a
 * future condition should name the full shipped defense, it must resolve to
 * { productionDefault: true } — never re-encode production as a fixed family
 * list, which is exactly the drift this rename removes.
 */
export const ABLATION_RECIPES: Record<string, DefenseRecipe> = {
  CONTROL: { families: [] },
  TURNSTILE_ONLY: { families: [] },
  SEMANTIC_ONLY: { families: ["semantic"] },
  DECOY_FIELD_ONLY: { families: ["decoy-field"] },
  DECOY_ROUTE_ONLY: { families: ["decoy-route"] },
  INTERACTION_ONLY: { families: ["interaction"] },
  SEMANTIC_ROUTE: { families: ["semantic", "decoy-route"] },
  FULL: { families: ["semantic", "decoy-field", "decoy-route", "interaction"] },
  // P1-AUDIT-2 (P0-12): production-plane ablations — the audit's required
  // research conditions, run SEPARATELY from the semantic-lab arms. Each
  // names only non-lab families. Their RENDERED artifact composition on the
  // production plane is the non-semantic subset of what production emits.
  PRODUCTION_FIELD: { families: ["decoy-field"] },
  PRODUCTION_ROUTE: { families: ["decoy-route"] },
  PRODUCTION_INTERACTION: { families: ["interaction"] },
  // P0-AUDIT-3 (P0-1): formerly "PRODUCTION_FULL" — the production thesis
  // MINUS the semantic strategy production always carries. An ablation,
  // named so nobody can mistake it for the shipped treatment.
  PRODUCTION_NONSEMANTIC_FULL: {
    families: ["decoy-field", "decoy-route", "interaction"],
  },
};

/**
 * P0-AUDIT-3 (P0-1): the production-default condition recipe — the ONE
 * recipe whose semantics is "be exactly production". Resolved by the engine
 * into a redirect to deriveProductionProfile's path; never listed in
 * ABLATION_RECIPES because it is not an ablation.
 */
export const PRODUCTION_DEFAULT_RECIPE: DefenseRecipe = { productionDefault: true };

/** Deep stable canonicalizer for profile hashing. */
function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((obj as Record<string, unknown>)[k])).join(",") + "}";
}

export async function hashProfile(profile: DefenseProfile): Promise<string> {
  const canonical = canonicalize({ ...profile, sessionId: "" });
  const data = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function profileId(seed: ArrayBuffer): string {
  return Array.from(new Uint8Array(seed).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * FR-R6-042: the variant ID is a real SHA-256 over a canonical treatment
 * object covering every treatment dimension: families, template/placement/
 * mode, interaction scoring, the telemetry mask, the scoring policy, the
 * Turnstile condition — AND the multi-spot presentation (spots + spot_count,
 * audit P1: spot selection changes the page the attacker sees; two subjects
 * differing only in carrier positions must NOT collapse to one variant).
 */
async function buildVariantId(profile: DefenseProfile, turnstileRequired: boolean): Promise<string> {
  const treatment = {
    families: [...profile.families].sort(),
    template: profile.semantic?.templateId ?? null,
    placement: profile.semantic?.placementId ?? null,
    semantic_mode: profile.semantic?.mode ?? null,
    semantic_spots: profile.semantic ? [...profile.semantic.spots].sort() : null,
    semantic_spot_count: profile.semantic?.spotCount ?? null,
    interaction_scoring: profile.interaction?.scoringEnabled ?? null,
    telemetry: { ...profile.telemetry },
    scoring_policy: profile.scoringPolicy,
    turnstile_required: turnstileRequired,
  };
  const data = new TextEncoder().encode(JSON.stringify(treatment));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Engine options ───────────────────────────────────────────────────────

/** Options for the shared derivation engine. `mode` is MANDATORY. */
export interface DeriveProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
  /** Which plane derives this profile. Never defaulted — the caller states it. */
  mode: "lab" | "production";
  /** FR-R6-040: evaluation-plane only. */
  holdoutMode?: boolean;
  /** FR-R6-042: Turnstile condition is part of the treatment identity. */
  turnstileRequired?: boolean;
}

/** The production API's options — no mode, no recipe, no holdout. */
export interface ProductionProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
}

/** The evaluation API's options — full treatment control. */
export interface EvaluationProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
  /** Evaluation plane ALWAYS declares itself. */
  mode: "lab" | "production";
  holdoutMode?: boolean;
  turnstileRequired?: boolean;
}

/**
 * FR-R5-016: mode-eligibility validation for explicit recipe overrides.
 *
 * Only EXPLICIT inputs fail closed — if a recipe field is undefined, the
 * corresponding dimension falls back to random selection, and the randomly
 * chosen value is accepted (even if it happens to be lab-only in production).
 * This asymmetry is intentional: explicit user intent must be enforced, but
 * the engine's random exploration must not be blocked.
 */
function validateExplicitOverrides(
  recipe: DefenseRecipe,
  isLab: boolean
): void {
  // --- semanticTemplate ---
  if (recipe.semanticTemplate !== undefined) {
    const tpl = SEMANTIC_TEMPLATES.find(
      (t) => t.id === recipe.semanticTemplate
    );
    if (!tpl) {
      throw new Error("UNKNOWN_TEMPLATE: " + recipe.semanticTemplate);
    }
    if (tpl.labOnly && !isLab) {
      throw new Error("TEMPLATE_NOT_ELIGIBLE_IN_MODE: " + recipe.semanticTemplate);
    }
  }

  // --- placementId ---
  if (recipe.placementId !== undefined) {
    // If template is also explicit, check placement against that template's allowedPlacements
    const explicitTemplateId = recipe.semanticTemplate;
    if (explicitTemplateId !== undefined) {
      const tpl = SEMANTIC_TEMPLATES.find((t) => t.id === explicitTemplateId);
      if (tpl && !tpl.allowedPlacements.includes(recipe.placementId!)) {
        throw new Error(
          "INVALID_PLACEMENT_FOR_TEMPLATE: " + recipe.placementId
        );
      }
    }
    // Placement-level eligibility: is the placement itself production-eligible?
    const placement = PLACEMENTS.find((p) => p.id === recipe.placementId);
    if (placement && !placement.productionEligible && !isLab) {
      throw new Error("PLACEMENT_NOT_ELIGIBLE_IN_MODE: " + recipe.placementId);
    }
  }

  // --- scoringPolicy ---
  if (recipe.scoringPolicy !== undefined) {
    getPolicyOrThrow(recipe.scoringPolicy);
  }
}

async function domainOrThrow(
  root: ArrayBuffer,
  domain: PrngDomain
): Promise<import("./prng.js").SeedStream> {
  return domainStream(root, domain);
}

/**
 * P0-AUDIT-3 (P0-1): treatment resolution. A recipe is either an ABLATION
 * (an explicit family/override list) or THE production default (a redirect
 * to the production derivation path). Resolving the marker here — before
 * any recipe field is consumed — is what makes PRODUCTION_DEFAULT
 * byte-equal to deriveProductionProfile by construction: the same engine
 * runs with the same mode, the same seed streams, and NO recipe override
 * surface at all.
 */
function isProductionDefaultRecipe(recipe: DefenseRecipe | undefined): boolean {
  return recipe?.productionDefault === true;
}

/**
 * The shared derivation engine. Not exported to hosts: the product entry is
 * deriveProductionProfile; experiments use deriveEvaluationProfile.
 *
 * FR-R5-016: Explicit recipe fields fail closed if ineligible for the mode.
 * FR-R5-034: holdoutMode restricts templates to partition === "holdout".
 * P0-AUDIT-3 (P0-1): { productionDefault: true } redirects to the production
 * path REGARDLESS of plane — an evaluation session assigned PRODUCTION_DEFAULT
 * renders exactly what production renders for the same (secret, version,
 * sessionId). holdout/turnstile conditions still ride the options (they are
 * part of the hashed treatment identity on both planes).
 */
async function deriveProfileEngine(
  opts: DeriveProfileOptions,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  // ── PRODUCTION_DEFAULT redirect ─────────────────────────────────────────
  // Validate the recipe FIRST (fail closed on a malformed marker), then
  // re-enter as pure production. The secret/version/sessionId are untouched,
  // so derivation is identical to deriveProductionProfile(opts) — the
  // regression invariant in tests/unit/ablation-recipes.test.ts pins this.
  if (recipe !== undefined) {
    const preParsed = parseDefenseRecipe(recipe);
    if (!preParsed.ok) {
      throw new Error("INVALID_RECIPE: " + preParsed.errors.join("; "));
    }
    if (isProductionDefaultRecipe(preParsed.recipe)) {
      return deriveProfileEngine({ ...opts, mode: "production" }, undefined);
    }
  }

  const { secret, version, sessionId, mode } = opts;
  const isLab = mode === "lab";
  const root = await deriveSeed(secret, version, sessionId);

  // ── Domain-separated PRF streams (audit: sequential PRNG coupling) ──────
  // Each dimension draws from its own HMAC domain — a change in one draw
  // can never perturb an unrelated dimension's artifact.
  const composition = await domainOrThrow(root, "composition");
  const strategyStream = await domainOrThrow(root, "semantic-strategy");
  const nonceStream = await domainOrThrow(root, "semantic-nonce");
  const spotsStream = await domainOrThrow(root, "semantic-spots");
  const fieldStream = await domainOrThrow(root, "field-name");
  const elementStream = await domainOrThrow(root, "field-element");
  const routeStream = await domainOrThrow(root, "route-token");
  const telemetryStream = await domainOrThrow(root, "telemetry-mask");

  // Resolve recipe (validate if provided)
  let resolvedRecipe: DefenseRecipe | undefined;
  if (recipe !== undefined) {
    // FR-R5-015: canonical schema validation — unknown keys fail closed here
    // (DefenseRecipeSchema is .strict() ), so a typo'd override is an error,
    // not a silently ignored field.
    const parsed = parseDefenseRecipe(recipe);
    if (!parsed.ok) {
      throw new Error("INVALID_RECIPE: " + parsed.errors.join("; "));
    }
    resolvedRecipe = parsed.recipe;

    // FR-R4-021: labOnly guard — reject lab-only recipes in production
    if (resolvedRecipe.labOnly && !isLab) {
      throw new Error("Lab-only recipe cannot be used in production mode");
    }

    // Fail-closed: explicit overrides must be eligible
    validateExplicitOverrides(resolvedRecipe, isLab);
  }

  // Derive families — explicit recipe vs random path diverge here.
  // In production random path, Phase A pre-draws the semantic strategy ID
  // from ITS OWN domain so the template-selection block below uses it (never
  // falling back to random). The recipe-evaluation block below consumes the
  // "semantic-wording" domain ONLY when a random lab-style template draw is
  // actually needed.
  let preDrawnProductionStrategy: string | undefined;
  let families: DefenseFamilyName[] = [];

  if (resolvedRecipe?.families !== undefined) {
    // Explicit families: use exactly what was requested (unchanged).
    families = [...resolvedRecipe.families];
  } else if (!isLab) {
    // ── PRODUCTION RANDOM PATH: compositionally sound profile ─────────────
    // Every random production profile MUST have:
    //   (A) A causal-capable semantic strategy (P02/P03/P04), and
    //   (B) ≥1 independent automation trap beyond the semantic deps.
    //
    // Phase A — CAUSAL STRATEGY (mandatory): drawn from the semantic-strategy
    // DOMAIN. Each strategy mandates "semantic" in the profile and pulls in
    // required companion families via requiresRoute / requiresDecoyField.
    const strategyId = PRODUCTION_AGENT_STRATEGIES[
      await strategyStream.nextInt(PRODUCTION_AGENT_STRATEGIES.length)
    ];
    preDrawnProductionStrategy = strategyId;
    const strategy = SEMANTIC_TEMPLATES.find((t) => t.id === strategyId)!;

    // Start with the mandatory semantic + its required companions.
    const depSet = new Set<DefenseFamilyName>(["semantic"]);
    if (strategy.requiresRoute) depSet.add("decoy-route");
    if (strategy.requiresDecoyField) depSet.add("decoy-field");

    // Phase B — INDEPENDENT LAYERS (mandatory ≥1): from the trap families
    // {decoy-field, decoy-route, interaction} MINUS those already pulled in
    // by Phase A, draw at least 1 (and up to all of the pool).
    const trapFamilies: DefenseFamilyName[] = [
      "decoy-field",
      "decoy-route",
      "interaction",
    ];
    const independentPool = trapFamilies.filter((f) => !depSet.has(f));
    // Draw 1..independentPool.length (the stream drive stays stable).
    const indepCount =
      1 + (await composition.nextInt(independentPool.length > 0 ? independentPool.length : 1));
    const drawnIndependents = await sampleWithoutReplacement(
      composition,
      independentPool,
      Math.min(indepCount, independentPool.length)
    );
    for (const dep of depSet) families.push(dep);
    for (const indep of drawnIndependents) families.push(indep);
    families.sort();
  } else {
    // ── LAB RANDOM PATH (evaluation plane) ───────────────────────────────
    const minFamilies = 2;
    const maxFamilies = Math.min(4, FAMILIES.length);
    const familyPool = LAB_FAMILIES;
    const drawnCount = minFamilies + (await composition.nextInt(maxFamilies - minFamilies + 1));
    const clampedCount = Math.min(drawnCount, familyPool.length);
    families = (await sampleWithoutReplacement(composition, familyPool, clampedCount)).sort();
  }

  const profile: DefenseProfile = {
    version,
    profileId: profileId(root),
    sessionId,
    families,
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      captureKey: (await telemetryStream.nextInt(2)) === 0,
      capturePointer: (await telemetryStream.nextInt(2)) === 0,
      captureSubmit: true,
    },
    scoringPolicy: resolvedRecipe?.scoringPolicy ?? "default-v1",
    profileVariantId: "", // set later
  };

  // Handle semantic family
  if (families.includes("semantic")) {
    // Determine which template to use
    let template =
      resolvedRecipe?.semanticTemplate !== undefined
        ? SEMANTIC_TEMPLATES.find((t) => t.id === resolvedRecipe!.semanticTemplate)
        : undefined;

    // FR-R5-034 / FR-R6-040: holdoutMode is a typed option.
    const isHoldoutMode = opts.holdoutMode === true;

    if (resolvedRecipe?.semanticTemplate !== undefined) {
      // Explicit template: validate partition eligibility in holdout mode
      if (template && isHoldoutMode && template.partition !== "holdout") {
        throw new Error("TEMPLATE_NOT_ELIGIBLE_IN_MODE: " + resolvedRecipe!.semanticTemplate);
      }
    } else if (preDrawnProductionStrategy) {
      // Production random path: template was already selected from the
      // semantic-strategy DOMAIN — never fall back to the old pool-based
      // draw that included S09/P01.
      template = SEMANTIC_TEMPLATES.find((t) => t.id === preDrawnProductionStrategy);
    } else {
      // No explicit template: random selection from eligible pool
      // FR-R5-034: lab-only random profiles are lab-mode-only (validateExplicitOverrides
      // does not apply — this is the engine's random exploration, filtered by mode).
      // FR-R6-041: holdout mode samples only holdout-partition SEMANTIC probes —
      // S09 is partition "holdout" but probeClass "metadata", so it is excluded
      // (it is a hidden DOM marker, not a semantic-holdout participant).
      // FR-R6-039: when the recipe names an explicit placement, restrict the
      // candidate pool to templates that ALLOW that placement BEFORE selection —
      // a random template must never contradict an explicit placement.
      const explicitPlacement = resolvedRecipe?.placementId;
      const pool = SEMANTIC_TEMPLATES.filter((t) => {
        if (isHoldoutMode) {
          return t.partition === "holdout" && t.probeClass === "semantic";
        }
        if (!isLab && t.labOnly) return false;
        if (explicitPlacement !== undefined && !t.allowedPlacements.includes(explicitPlacement)) {
          return false;
        }
        return true;
      });
      if (pool.length > 0) {
        // Random template wording draw uses the semantic-wording DOMAIN.
        const wordingStream = await domainOrThrow(root, "semantic-wording");
        template = pool[await wordingStream.nextInt(pool.length)];
      }
    }

    // If we couldn't find a template at all (e.g., holdout mode with no
    // holdout templates yet), remove semantic family and skip canary.
    if (!template) {
      families.splice(families.indexOf("semantic"), 1);
    } else {
      // S06 auto-adds decoy-field via requiresDecoyField (FR-R4-019)
      if (template.requiresDecoyField && !families.includes("decoy-field")) {
        families.push("decoy-field");
        families.sort();
      }

      // Determine placement
      const isLabMode = isLab;
      let placementId: string | undefined;

      // If explicit placement is provided, validate against template
      if (resolvedRecipe?.placementId !== undefined) {
        placementId = resolvedRecipe.placementId;
        if (!template.allowedPlacements.includes(placementId)) {
          // FR-R6-039: with placement-filtered selection above, a random
          // template ALWAYS allows the explicit placement — only the
          // explicit-template + explicit-placement combination can still
          // contradict, and that fails closed.
          throw new Error("INVALID_PLACEMENT_FOR_TEMPLATE: " + placementId);
        }
      } else {
        // No explicit placement: select from eligible placements
        const eligiblePlacements = PLACEMENTS.filter(
          (p) => template!.allowedPlacements.includes(p.id) &&
                 (isLabMode || p.productionEligible)
        );

        if (eligiblePlacements.length === 0) {
          // Fallback: no semantic canary if no eligible placements
          families.splice(families.indexOf("semantic"), 1);
          template = undefined;
        } else {
          const chosenPlacement = eligiblePlacements[await wordingPlacementIndex(root, eligiblePlacements.length)];
          placementId = chosenPlacement.id;

          // FR-R5-016: placement-level eligibility check for random selections
          if (chosenPlacement.productionEligible === false && !isLabMode) {
            // This shouldn't happen because of the filter above, but be safe
            families.splice(families.indexOf("semantic"), 1);
            template = undefined;
          }
        }
      }

      if (template && placementId) {
        const nonce = await generateNonce(nonceStream, 6);
        // FR-R2-021: semanticMode defaults from the template, overridable by recipe.
        const semanticMode = resolvedRecipe?.semanticMode ?? template.defaultMode;

        // Multi-spot injection draw (defense-in-depth widening). The chosen
        // placement governs the STRUCTURE (visible placement experiments keep
        // their single carrier); the spot draw governs WHERE hidden carriers
        // land within the page. 1–3 spots, sampled without replacement from
        // the anchor pool — an extractor heuristic must catch EVERY spot to
        // strip the trap, and the anchor set it must learn differs per
        // session. Spots draw from the semantic-spots DOMAIN (independent of
        // field name, route token, nonce). SPOT_ANCHORS lives in
        // core/artifacts.ts — the same module the renderers consume, so the
        // anchor vocabulary has exactly one definition.
        const spotCount = 1 + (await spotsStream.nextInt(3));
        const spots = (await sampleWithoutReplacement(spotsStream, SPOT_ANCHORS, spotCount)).slice();

        // Rereview item 27: deterministic intra-strategy presentation
        // variant — which reviewed static fragments compose the carrier
        // text. Own PRF domain ("semantic-form"): wording-variant draws can
        // never perturb strategy, spots, nonce, field, or route material.
        // SEMANTIC_FORM_VARIANT_COUNT lives in core/artifacts.ts — the same
        // module the composer consumes, so the vocabulary has one definition.
        const formStream = await domainOrThrow(root, "semantic-form");
        const formVariantIndex = await formStream.nextInt(SEMANTIC_FORM_VARIANT_COUNT);

        profile.semantic = {
          templateId: template.id,
          placementId,
          nonce,
          mode: semanticMode,
          spotCount,
          spots,
          formVariant: formVariantIndex,
        };

        // FIX: only requiresRoute templates pull in decoy-route (FR-R3-024).
        if (template.requiresRoute && !families.includes("decoy-route")) {
          families.push("decoy-route");
          families.sort();
        }
      }
    }
  }

  // Handle decoy-field / decoy-route (FR-R6-027/049: independent families,
  // independent projections — there is NO aggregate `decoy` object).
  // Field name, element ID, and route token each draw from their OWN domain,
  // so adding a randomized choice near the top can never perturb them.
  if (families.includes("decoy-field") || families.includes("decoy-route")) {
    const fieldName = await generateToken(fieldStream, 8);
    const endpointToken = await generateToken(routeStream, 6);
    const elementId = await generateToken(elementStream, 8);
    if (families.includes("decoy-field")) {
      profile.decoyField = { fieldName, elementId };
    }
    if (families.includes("decoy-route")) {
      profile.decoyRoute = { endpointToken };
    }
  }

  // Handle interaction family
  // FR-R6-038: honor the recipe's explicit interactionScoring toggle.
  if (families.includes("interaction")) {
    profile.interaction = { scoringEnabled: resolvedRecipe?.interactionScoring ?? true };
  }

  // Build variant ID (FR-R6-042: SHA-256 over the full treatment identity,
  // multi-spot presentation included)
  profile.profileVariantId = await buildVariantId(
    profile,
    opts.turnstileRequired ?? false
  );

  return profile;
}

/** Placement selection draws from the semantic-wording domain (same plane
 *  of "which wording/presentation" choices), index-only. */
async function wordingPlacementIndex(root: ArrayBuffer, n: number): Promise<number> {
  const s = await domainOrThrow(root, "semantic-wording");
  return s.nextInt(n);
}

// ─── Production API ───────────────────────────────────────────────────────

/**
 * THE production entry point. Derives the production random composition for
 * a session: P02/P03/P04 causal semantic strategy + ≥1 independent trap
 * layer. There is NO mode, NO recipe, NO holdout here — a production
 * deployment cannot configure its way into a weak lab condition.
 */
export async function deriveProductionProfile(opts: ProductionProfileOptions): Promise<DefenseProfile> {
  return deriveProfileEngine({ ...opts, mode: "production" });
}

// ─── Evaluation API ───────────────────────────────────────────────────────

/**
 * The evaluation entry point. Accepts the full treatment surface (recipe,
 * holdout, Turnstile condition) and BOTH planes. Evaluation may reach the
 * same lower-level engine — the dependency direction is evaluation →
 * engine, never production → evaluation override.
 */
export async function deriveEvaluationProfile(
  opts: EvaluationProfileOptions,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  return deriveProfileEngine(opts, recipe);
}

/**
 * P0-AUDIT-3 (P0-1): resolve a NAMED experiment condition to its treatment
 * recipe — the single lookup every harness/route/test call site uses. The
 * PRODUCTION_DEFAULT condition resolves to PRODUCTION_DEFAULT_RECIPE (the
 * engine redirect), NOT to a family list; an unknown name fails closed.
 */
export function resolveConditionRecipe(conditionId: string): DefenseRecipe {
  if (conditionId === "PRODUCTION_DEFAULT") return PRODUCTION_DEFAULT_RECIPE;
  const recipe = ABLATION_RECIPES[conditionId];
  if (!recipe) throw new Error(`UNKNOWN_CONDITION: ${conditionId}`);
  return recipe;
}

// ─── Legacy shim (Worker route path) ──────────────────────────────────────

export interface LegacyDeriveOptions {
  LAB_MODE?: string;
  FIRERAID_PROFILE_SECRET: string;
  /** Worker deployment default (env.PROFILE_VERSION). */
  PROFILE_VERSION?: string | number;
}

/**
 * Derive a deterministic defense profile for a session (legacy Env-based
 * shim — Worker routes only). Reads mode from env.LAB_MODE; evaluation
 * treatments (recipe/holdout/turnstile) ride through the evaluation engine.
 * `mode` is never defaulted: LAB_MODE must be set for a lab derivation, and
 * absence means production.
 *
 * @param env - Worker-like environment
 * @param sessionId - Unique session identifier
 * @param version - Optional explicit version for reconstruction
 * @param recipe - Optional recipe override (the bound lab run's condition —
 *   FR-R5 Pass C). Validated fail-closed by the engine.
 */
export async function deriveProfile(
  env: LegacyDeriveOptions,
  sessionId: string,
  version?: number,
  recipe?: DefenseRecipe,
  holdoutMode?: boolean,
  /** FR-P0-17: the session's assigned verification condition — part of the
   *  treatment identity hashed into profileVariantId. Issuance and every
   *  reconstruction MUST see the same value or the variant id drifts. */
  turnstileRequired?: boolean
): Promise<DefenseProfile> {
  const isLab = env.LAB_MODE === "true";
  const resolvedVersion =
    version ??
    (env.PROFILE_VERSION !== undefined ? Number(env.PROFILE_VERSION) : 1);
  return deriveEvaluationProfile(
    {
      secret: env.FIRERAID_PROFILE_SECRET,
      version: resolvedVersion,
      sessionId,
      mode: isLab ? "lab" : "production",
      // FR-POST-R6-P5: part of the issued treatment identity — restricts
      // the random template pool to the holdout partition (FR-R5-034).
      holdoutMode: holdoutMode === true,
      // FR-P0-17: the Turnstile condition hashes into the variant id.
      turnstileRequired: turnstileRequired === true,
    },
    recipe
  );
}
