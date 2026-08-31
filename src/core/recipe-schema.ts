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
  })
  .strict();
export type DefenseRecipe = z.infer<typeof DefenseRecipeSchema>;

/** Named ablation condition IDs (mirror ABLATION_RECIPES keys in profile.ts).
 * The PRODUCTION_* set (P0-12) is the production-faithful arm list: each
 * names ONLY families that render on the production plane, so a positive
 * result is attributable to what production actually emits — never to a
 * lab-only semantic carrier. */
export const RecipeIdSchema = z.enum([
  "CONTROL",
  "TURNSTILE_ONLY",
  "SEMANTIC_ONLY",
  "DECOY_FIELD_ONLY",
  "DECOY_ROUTE_ONLY",
  "INTERACTION_ONLY",
  "SEMANTIC_ROUTE",
  "FULL",
  "PRODUCTION_FIELD",
  "PRODUCTION_ROUTE",
  "PRODUCTION_INTERACTION",
  "PRODUCTION_FULL",
]);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

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
