/**
 * Deterministic defense profile generation (FR-INV-002, FR-INV-011).
 * Reconstructable purely from (secret, version, session_id).
 * FIX: Accepts explicit version parameter for reconstruction.
 * FIX: Filters placements by environment eligibility and template allowedPlacements.
 * FIX: Deep canonical hashProfile (FR-037).
 * FIX: Environment filtering (FR-R2-016).
 * FR-R5-016: mode-eligibility fails closed for explicit overrides.
 * FR-R5-034: holdoutMode partitions templates by `partition` field.
 */
import {
  deriveSeed,
  SeedStream,
  generateNonce,
  generateToken,
  sampleWithoutReplacement,
} from "./prng.js";
import type { Env } from "../env.js";
import { profileVersion } from "../env.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "./catalog.js";
import {
  parseDefenseRecipe,
  type DefenseRecipe,
} from "./recipe-schema.js";
import { getPolicyOrThrow } from "./decision.js";
import type {
  DefenseProfile,
  DefenseFamilyName,
} from "../types/profile.js";

// Re-export the type so existing importers keep working:
//   import type { DefenseRecipe } from "./profile.js"
export type { DefenseRecipe };

const FAMILIES: DefenseFamilyName[] = [
  "semantic",
  "decoy-field",
  "decoy-route",
  "interaction",
];

/**
 * Named ablation condition recipes for reproducibility.
 * Keys match RecipeIdSchema in recipe-schema.ts.
 *
 * FR-R6-006: CONTROL and TURNSTILE_ONLY MUST declare `families: []` — an
 * omitted `families` means "randomly sample 2–4 families", which made both
 * "control" conditions render random defense profiles and destroyed the
 * ablation baseline. Turnstile itself is controlled independently via the
 * lab run's `turnstile_required` flag, not via these recipes.
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
};

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
 * Build a deterministic variant ID from the profile treatment variables
 * (FR-R4-024). Includes all explicit and derived treatment dimensions
 * so that different semanticModes produce distinct variant IDs.
 */
/**
 * FR-R6-042: the variant ID is a real SHA-256 over a canonical treatment
 * object (not reversible hex-encoding), covering every treatment dimension:
 * families, template/placement/mode, interaction scoring, the telemetry
 * mask, the scoring policy, and the Turnstile condition.
 */
async function buildVariantId(profile: DefenseProfile, turnstileRequired: boolean): Promise<string> {
  const treatment = {
    families: [...profile.families].sort(),
    template: profile.semantic?.templateId ?? null,
    placement: profile.semantic?.placementId ?? null,
    semantic_mode: profile.semantic?.mode ?? null,
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

// ─── DeriveProfileOptions ─────────────────────────────────────────────────

export interface DeriveProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
  mode?: "lab" | "production";
  /** FR-R6-040: part of the typed options — no more `as` casting. */
  holdoutMode?: boolean;
  /** FR-R6-042: Turnstile condition is part of the treatment identity. */
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

/**
 * FR-R5-034: holdoutMode support.
 * When holdoutMode is true, only templates with partition === "holdout" AND
 * probeClass === "semantic" are eligible for random selection (S09 is a
 * metadata probe, not a semantic-holdout participant — FR-R6-041). Explicit
 * overrides selecting a development-partition template throw
 * TEMPLATE_NOT_ELIGIBLE_IN_MODE.
 */

/**
 * Derive a deterministic defense profile with optional recipe overrides.
 *
 * This is the pure version of deriveProfile that accepts a recipe object
 * for explicit configuration. The caller must construct its own environment
 * state (secret, version, sessionId, mode) rather than reading from an Env
 * object — making it ideal for testing and harness integration.
 *
 * FR-R5-016: Explicit recipe fields fail closed if ineligible for the mode.
 * FR-R5-034: holdoutMode restricts templates to partition === "holdout".
 */
export async function deriveProfilePure(
  opts: DeriveProfileOptions,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  const { secret, version, sessionId, mode = "lab" } = opts;
  const isLab = mode === "lab";
  const seed = await deriveSeed(secret, version, sessionId);
  const stream = new SeedStream(seed);

  // Resolve recipe (validate if provided)
  let resolvedRecipe: DefenseRecipe | undefined;
  if (recipe !== undefined) {
    // FR-R5-015: canonical schema validation — unknown keys fail closed here
    // ( DefenseRecipeSchema is .strict() ), so a typo'd override is an error,
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

  // Derive families
  const minFamilies = 2;
  const maxFamilies = Math.min(4, FAMILIES.length);
  // P1-AUDIT-2 Phase E: the RANDOM family pool is mode-filtered. In
  // production the semantic family can never render — S01–S08 are lab-only
  // (FR-R7-013) and S09 is holdout-partition metadata excluded from random
  // selection (FR-R6-041) — so a drawn semantic slot was always a null
  // render that still consumed a slot in the 2–4 draw and skewed variant
  // identity. Explicit recipes keep the fail-closed validation path
  // (validateExplicitOverrides); this filter is the random-pool fix ONLY.
  // NB: the pool is sampled FIRST and the count drawn second — the count
  // draw consumes a stream draw either way, so filtering the pool (not the
  // count) keeps the draw order stable.
  const familyPool = isLab
    ? FAMILIES
    : FAMILIES.filter((f) => f !== "semantic");
  let familyCount: number;
  if (resolvedRecipe?.families !== undefined) {
    // Explicit families: use exactly what was requested
    familyCount = resolvedRecipe.families.length;
  } else {
    const drawnCount = minFamilies + (await stream.nextInt(maxFamilies - minFamilies + 1));
    // Clamp to the filtered pool: production drops "semantic" (3 left) and
    // the raw draw can reach 4. The count draw still consumed one stream
    // draw either way — draw order is unchanged.
    familyCount = Math.min(drawnCount, familyPool.length);
  }

  let families: DefenseFamilyName[];
  if (resolvedRecipe?.families !== undefined) {
    families = [...resolvedRecipe.families];
  } else {
    families = (await sampleWithoutReplacement(stream, familyPool, familyCount)).sort();
  }

  const profile: DefenseProfile = {
    version,
    profileId: profileId(seed),
    sessionId,
    families,
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      captureKey: await stream.nextInt(2) === 0,
      capturePointer: await stream.nextInt(2) === 0,
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
        template = pool[await stream.nextInt(pool.length)];
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
          const chosenPlacement = eligiblePlacements[await stream.nextInt(eligiblePlacements.length)];
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
        const nonce = await generateNonce(stream, 6);
        // FR-R2-021: semanticMode defaults from the template, overridable by recipe.
        const mode = resolvedRecipe?.semanticMode ?? template.defaultMode;

        profile.semantic = { templateId: template.id, placementId, nonce, mode };

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
  // Shared token draws preserve determinism: field draws first, then route,
  // regardless of which family is present, so a session with only decoy-route
  // consumes the same stream positions as one with both.
  if (families.includes("decoy-field") || families.includes("decoy-route")) {
    const fieldName = `fr_${await generateToken(stream, 4)}`;
    const endpointToken = await generateToken(stream, 6);
    const elementId = `fr_${await generateToken(stream, 4)}`;
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

  // Build variant ID (FR-R6-042: SHA-256 over the full treatment identity)
  profile.profileVariantId = await buildVariantId(
    profile,
    opts.turnstileRequired ?? false
  );

  return profile;
}

/**
 * Derive a deterministic defense profile for a session.
 * Reads mode from env.LAB_MODE for environment-based filtering.
 *
 * @param env - Cloudflare Worker environment
 * @param sessionId - Unique session identifier
 * @param version - Optional explicit version for reconstruction
 * @param recipe - Optional recipe override (the bound lab run's condition —
 *   FR-R5 Pass C). Validated fail-closed by deriveProfilePure.
 */
export async function deriveProfile(
  env: Env,
  sessionId: string,
  version?: number,
  recipe?: DefenseRecipe,
  holdoutMode?: boolean,
  /** FR-P0-17: the session's assigned verification condition — part of the
   *  treatment identity hashed into profileVariantId. Issuance and every
   *  reconstruction MUST see the same value or the variant id drifts. */
  turnstileRequired?: boolean
): Promise<DefenseProfile> {
  const ver = version ?? profileVersion(env);
  const isLab = env.LAB_MODE === "true";
  return deriveProfilePure(
    {
      secret: env.FIRERAID_PROFILE_SECRET,
      version: ver,
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
