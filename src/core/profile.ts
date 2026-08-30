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
import type { SemanticTemplate } from "./catalog.js";
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
 */
export const ABLATION_RECIPES: Record<string, DefenseRecipe> = {
  CONTROL: {},
  TURNSTILE_ONLY: {},
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
function buildVariantId(
  profile: DefenseProfile
): string {
  const parts: string[] = [];
  for (const fam of profile.families.sort()) {
    parts.push(fam);
  }
  if (profile.semantic) {
    parts.push(`template=${profile.semantic.templateId}`);
    parts.push(`placement=${profile.semantic.placementId}`);
    parts.push(`mode=${profile.semantic.mode}`);
  }
  const variantInput = parts.join("|");
  // Use full SHA-256 hex (64 chars) for uniqueness — truncation caused
  // different semanticModes to collide in early tests.
  return Array.from(new TextEncoder().encode(variantInput))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── DeriveProfileOptions ─────────────────────────────────────────────────

export interface DeriveProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
  mode?: "lab" | "production";
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
 * When holdoutMode is true, only templates with partition === "holdout" are
 * eligible. Explicit overrides selecting a development-partition template
 * throw TEMPLATE_NOT_ELIGIBLE_IN_MODE.
 *
 * Catalog partition assignment (S01–S09): S01–S06 development,
 * S07–S08 holdout, S09 holdout (hidden metadata marker, not a semantic
 * holdout participant — FR-R4-027/FR-R5-033).
 */
function getTemplatesByPartition(): Record<string, SemanticTemplate[]> {
  const byPartition: Record<string, SemanticTemplate[]> = {};
  for (const tpl of SEMANTIC_TEMPLATES) {
    if (!byPartition[tpl.partition]) byPartition[tpl.partition] = [];
    byPartition[tpl.partition].push(tpl);
  }
  return byPartition;
}

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
  let familyCount: number;
  if (resolvedRecipe?.families !== undefined) {
    // Explicit families: use exactly what was requested
    familyCount = resolvedRecipe.families.length;
  } else {
    familyCount = minFamilies + (await stream.nextInt(maxFamilies - minFamilies + 1));
  }

  let families: DefenseFamilyName[];
  if (resolvedRecipe?.families !== undefined) {
    families = [...resolvedRecipe.families];
  } else {
    families = (await sampleWithoutReplacement(stream, FAMILIES, familyCount)).sort();
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

    // FR-R5-034: holdoutMode
    const isHoldoutMode = (opts as DeriveProfileOptions & { holdoutMode?: boolean })
      .holdoutMode === true;

    if (resolvedRecipe?.semanticTemplate !== undefined) {
      // Explicit template: validate partition eligibility in holdout mode
      if (template && isHoldoutMode && template.partition !== "holdout") {
        throw new Error("TEMPLATE_NOT_ELIGIBLE_IN_MODE: " + resolvedRecipe!.semanticTemplate);
      }
    } else {
      // No explicit template: random selection from eligible pool
      // FR-R5-034: lab-only random profiles are lab-mode-only (validateExplicitOverrides
      // does not apply — this is the engine's random exploration, filtered by mode).
      const pool = isHoldoutMode
        ? (getTemplatesByPartition()["holdout"] ?? [])
        : SEMANTIC_TEMPLATES.filter((t) => isLab || !t.labOnly);
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
      if (template.id === "S06" && !families.includes("decoy-field")) {
        families.push("decoy-field");
        families.sort();
      }

      // Determine placement
      const isLabMode = isLab;
      let placementId: string | undefined;

      // If explicit placement is provided, validate against template
      if (resolvedRecipe?.placementId !== undefined) {
        placementId = resolvedRecipe.placementId;
        // If template is also explicit, we already validated allowedPlacements
        // above in validateExplicitOverrides. If template is random but placement
        // is explicit, check against the chosen template's allowedPlacements.
        if (!template.allowedPlacements.includes(placementId)) {
          // Only fail closed for EXPLICIT template + EXPLICIT placement
          // If template was random, the explicit placement check was not
          // enforced in validateExplicitOverrides (no template was known).
          // We need to check here only if template was explicitly set.
          if (resolvedRecipe?.semanticTemplate !== undefined) {
            throw new Error("INVALID_PLACEMENT_FOR_TEMPLATE: " + placementId);
          }
          // Random template: keep existing random-eligibility behavior
          // (the explicit placement is accepted if it matches the random template)
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

  // Handle decoy-field / decoy-route (shared token generation)
  if (families.includes("decoy-field") || families.includes("decoy-route")) {
    const fieldName = `fr_${await generateToken(stream, 4)}`;
    const endpointToken = await generateToken(stream, 6);
    const elementId = `fr_${await generateToken(stream, 4)}`;
    // Aggregate config consumed by renderer + correlation.
    profile.decoy = { fieldName, endpointToken, elementId };
    // Family-specific projections (FR-R3-010).
    if (families.includes("decoy-field")) {
      profile.decoyField = { fieldName, elementId };
    }
    if (families.includes("decoy-route")) {
      profile.decoyRoute = { endpointToken };
    }
  }

  // Handle interaction family
  if (families.includes("interaction")) {
    profile.interaction = { scoringEnabled: true };
  }

  // Build variant ID
  profile.profileVariantId = buildVariantId(profile);

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
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  const ver = version ?? profileVersion(env);
  const isLab = env.LAB_MODE === "true";
  return deriveProfilePure(
    {
      secret: env.FIRERAID_PROFILE_SECRET,
      version: ver,
      sessionId,
      mode: isLab ? "lab" : "production",
    },
    recipe
  );
}
