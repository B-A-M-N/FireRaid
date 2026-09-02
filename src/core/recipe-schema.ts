/**
 * Canonical DefenseRecipe schema (FR-R5-015).
 * ONE Zod definition shared by: experiment manifests (harness), the lab API
 * (createLabRun validation), and the profile engine. LLM-free, runtime-safe,
 * importable from both src/ and harness/.
 *
 * .strict() so typos like `semanticTemplatee` are rejected, not ignored.
 */
import { z } from "zod";

export const DefenseFamilySchema = z.enum([
  "semantic",
  "decoy-field",
  "decoy-route",
  "interaction",
]);
export type DefenseFamilyName = z.infer<typeof DefenseFamilySchema>;

export const SemanticModeSchema = z.enum(["observe", "handoff", "decoy"]);
export type SemanticMode = z.infer<typeof SemanticModeSchema>;

export const DefenseRecipeSchema = z
  .object({
    /** Explicit families to enable (bypasses random sampling). */
    families: z.array(DefenseFamilySchema).optional(),
    /** Explicit semantic template ID (e.g. "S04"). */
    semanticTemplate: z.string().min(1).max(16).optional(),
    /** Explicit placement ID (e.g. "P02"). */
    placementId: z.string().min(1).max(16).optional(),
    /** Override semantic mode (defaults to template.defaultMode). */
    semanticMode: SemanticModeSchema.optional(),
    /** Override scoring policy name. */
    scoringPolicy: z.string().min(1).max(64).optional(),
    /** Explicit interaction-scoring toggle (rarely overridden). */
    interactionScoring: z.boolean().optional(),
    /** Lab-only recipes are rejected in production mode. */
    labOnly: z.boolean().optional(),
    /**
     * P0-AUDIT-3 (P0-1): the PRODUCTION_DEFAULT condition marker. The engine
     * redirects to the exact production derivation path (deriveProductionProfile)
     * so the treatment is byte-equal to what a production deployment derives —
     * by construction, not by parallel implementation. Literal `true` only:
     * `false` is a typo class, not a value (fail closed).
     */
    productionDefault: z.literal(true).optional(),
  })
  .strict()
  // P0-AUDIT-3: productionDefault IS a whole treatment — it must never
  // combine with an explicit dimension, or that dimension would be silently
  // dropped by the redirect (silent override = the exact drift class P0-1
  // exists to prevent).
  .superRefine((recipe, ctx) => {
    if (recipe.productionDefault !== true) return;
    const conflicts = [
      ["families", recipe.families],
      ["semanticTemplate", recipe.semanticTemplate],
      ["placementId", recipe.placementId],
      ["semanticMode", recipe.semanticMode],
      ["scoringPolicy", recipe.scoringPolicy],
      ["interactionScoring", recipe.interactionScoring],
      ["labOnly", recipe.labOnly],
    ].filter(([, v]) => v !== undefined);
    if (conflicts.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `productionDefault is a complete treatment — remove conflicting fields: ${conflicts
          .map(([k]) => k)
          .join(", ")}`,
      });
    }
  });
export type DefenseRecipe = z.infer<typeof DefenseRecipeSchema>;

/** Named ablation condition IDs (mirror ABLATION_RECIPES keys in profile.ts).
 * The PRODUCTION_* set (P0-12, revised P0-AUDIT-3/P0-1) is the
 * production-faithful arm list:
 *   - PRODUCTION_DEFAULT — THE shipped treatment. Resolves to the production
 *     derivation path itself (deriveProductionProfile), so the benchmark arm
 *     is byte-equal to what a production deployment derives. This is the
 *     headline condition; every other arm is an ablation of it.
 *   - PRODUCTION_FIELD/ROUTE/INTERACTION — single-family ablations.
 *   - PRODUCTION_NONSEMANTIC_FULL — the field+route+interaction ablation
 *     (formerly mis-named "PRODUCTION_FULL": it explicitly REMOVES the
 *     semantic dimension production always carries, so it is an ablation,
 *     never the product arm).
 * so a positive result is attributable to what production actually emits —
 * never to a lab-only semantic carrier. */
export const RecipeIdSchema = z.enum([
  "CONTROL",
  "TURNSTILE_ONLY",
  "SEMANTIC_ONLY",
  "DECOY_FIELD_ONLY",
  "DECOY_ROUTE_ONLY",
  "INTERACTION_ONLY",
  "SEMANTIC_ROUTE",
  "FULL",
  "PRODUCTION_DEFAULT",
  "PRODUCTION_FIELD",
  "PRODUCTION_ROUTE",
  "PRODUCTION_INTERACTION",
  "PRODUCTION_NONSEMANTIC_FULL",
]);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

/**
 * P0-AUDIT-3 (P0-1): release invariant helper. The headline experiment
 * condition resolves to the shipped treatment — the production derivation
 * path itself, not a recipe-shaped approximation of it.
 */
export const PRODUCTION_DEFAULT_ID = "PRODUCTION_DEFAULT" as const;

/**
 * Parse + validate an untrusted recipe value.
 * Returns the typed recipe or null (with issues readable via safeParse).
 */
export function parseDefenseRecipe(raw: unknown):
  | { ok: true; recipe: DefenseRecipe }
  | { ok: false; errors: string[] } {
  const result = DefenseRecipeSchema.safeParse(raw);
  if (result.success) return { ok: true, recipe: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
