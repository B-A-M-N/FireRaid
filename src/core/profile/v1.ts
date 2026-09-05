/**
 * FROZEN profile derivation — version 1 (FR-P0-04).
 *
 * This is the derivation implementation AS FROZEN at v1, moved verbatim from
 * the (live) core/profile.ts engine. The ONLY behavioral difference from the
 * live engine's eventual evolution: this module reads the FROZEN catalog
 * snapshot (catalog-v1.ts) instead of the live catalogs, so the live catalogs
 * can evolve for v2 without redefining what v1 derives.
 *
 * THE FREEZE CONTRACT:
 *   - Any edit to this file (or catalog-v1.ts) that changes a derived
 *     observable is a v1 semantics change. It is forbidden: change treatment
 *     semantics by introducing version 2 in core/profile-versions.ts and
 *     leave v1 untouched.
 *   - tests/unit/profile-golden.test.ts pins the complete observable
 *     treatment identity (families, strategy, template, placement, spots,
 *     field name, element id, route token, nonce, telemetry mask, scoring
 *     policy, variant id, deep canonical hash) — a semantics change here
 *     fails those goldens, whichever way it was made.
 *
 * The core types (DefenseProfile, recipe schema, decision policies) are
 * shared, NOT frozen: they are the interface the rest of the system speaks.
 * Only the DERIVATION DECISIONS — pool contents, domains, thresholds, draw
 * order, defaults — are frozen, and all of those decisions live in this
 * file + catalog-v1.ts.
 */
import {
  deriveSeed,
  domainStream,
  generateNonce,
  generateToken,
  sampleWithoutReplacement,
  type PrngDomain,
} from "../prng.js";
import {
  SEMANTIC_TEMPLATES,
  PLACEMENTS,
  PRODUCTION_AGENT_STRATEGIES,
  SPOT_ANCHORS,
  SEMANTIC_FORM_VARIANT_COUNT_V1 as SEMANTIC_FORM_VARIANT_COUNT,
} from "./catalog-v1.js";
import type { DefenseFamilyName } from "../../types/profile.js";
import type { DefenseProfile } from "../../types/profile.js";
import {
  parseDefenseRecipe,
  type DefenseRecipe,
} from "../recipe-schema.js";
import { getPolicyOrThrow } from "../decision.js";

const FAMILIES: DefenseFamilyName[] = [
  "semantic",
  "decoy-field",
  "decoy-route",
  "interaction",
];

/** Evaluation-plane family pool (the full set), as frozen at v1. */
export const LAB_FAMILIES_V1: readonly DefenseFamilyName[] = FAMILIES;

/** Options for the frozen v1 engine. `mode` is MANDATORY. */
export interface DeriveProfileOptionsV1 {
  secret: string;
  version: number;
  sessionId: string;
  mode: "lab" | "production";
  holdoutMode?: boolean;
  turnstileRequired?: boolean;
}

function profileId(seed: ArrayBuffer): string {
  return Array.from(new Uint8Array(seed).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deep stable canonicalizer for profile hashing (v1 hash semantics). */
function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((obj as Record<string, unknown>)[k])).join(",") + "}";
}

export async function hashProfileV1(profile: DefenseProfile): Promise<string> {
  const canonical = canonicalize({ ...profile, sessionId: "" });
  const data = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * FR-R6-042: the variant ID is a real SHA-256 over a canonical treatment
 * object covering every treatment dimension (v1 field set).
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

/** Placement selection draws from the semantic-wording domain (v1). */
async function wordingPlacementIndex(root: ArrayBuffer, n: number): Promise<number> {
  const s = await domainStream(root, "semantic-wording" as PrngDomain);
  return s.nextInt(n);
}

async function domainOrThrow(root: ArrayBuffer, domain: PrngDomain): Promise<import("../prng.js").SeedStream> {
  return domainStream(root, domain);
}

/**
 * FR-R5-016: mode-eligibility validation for explicit recipe overrides (v1).
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
    const explicitTemplateId = recipe.semanticTemplate;
    if (explicitTemplateId !== undefined) {
      const tpl = SEMANTIC_TEMPLATES.find((t) => t.id === explicitTemplateId);
      if (tpl && !tpl.allowedPlacements.includes(recipe.placementId!)) {
        throw new Error(
          "INVALID_PLACEMENT_FOR_TEMPLATE: " + recipe.placementId
        );
      }
    }
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
 * Treatment resolution: { productionDefault: true } redirects to the
 * production path REGARDLESS of plane (v1 semantics).
 */
function isProductionDefaultRecipe(recipe: DefenseRecipe | undefined): boolean {
  return recipe?.productionDefault === true;
}

/**
 * The frozen v1 derivation engine. Verbatim move of the v1-era
 * deriveProfileEngine from core/profile.ts, reading the frozen catalog.
 */
export async function deriveProfileEngineV1(
  opts: DeriveProfileOptionsV1,
  recipe?: DefenseRecipe
): Promise<DefenseProfile> {
  // ── PRODUCTION_DEFAULT redirect (validate the marker first) ─────────────
  if (recipe !== undefined) {
    const preParsed = parseDefenseRecipe(recipe);
    if (!preParsed.ok) {
      throw new Error("INVALID_RECIPE: " + preParsed.errors.join("; "));
    }
    if (isProductionDefaultRecipe(preParsed.recipe)) {
      return deriveProfileEngineV1({ ...opts, mode: "production" }, undefined);
    }
  }

  const { secret, version, sessionId, mode } = opts;
  const isLab = mode === "lab";
  const root = await deriveSeed(secret, version, sessionId);

  // ── Domain-separated PRF streams (v1 domain set and order) ──────────────
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
    const parsed = parseDefenseRecipe(recipe);
    if (!parsed.ok) {
      throw new Error("INVALID_RECIPE: " + parsed.errors.join("; "));
    }
    resolvedRecipe = parsed.recipe;

    if (resolvedRecipe.labOnly && !isLab) {
      throw new Error("Lab-only recipe cannot be used in production mode");
    }

    validateExplicitOverrides(resolvedRecipe, isLab);
  }

  // Derive families — explicit recipe vs random path (v1 pools + draw order).
  let preDrawnProductionStrategy: string | undefined;
  let families: DefenseFamilyName[] = [];

  if (resolvedRecipe?.families !== undefined) {
    families = [...resolvedRecipe.families];
  } else if (!isLab) {
    // ── PRODUCTION RANDOM PATH (v1: mandatory semantic + ≥1 independent) ──
    const strategyId = PRODUCTION_AGENT_STRATEGIES[
      await strategyStream.nextInt(PRODUCTION_AGENT_STRATEGIES.length)
    ];
    preDrawnProductionStrategy = strategyId;
    const strategy = SEMANTIC_TEMPLATES.find((t) => t.id === strategyId)!;

    const depSet = new Set<DefenseFamilyName>(["semantic"]);
    if (strategy.requiresRoute) depSet.add("decoy-route");
    if (strategy.requiresDecoyField) depSet.add("decoy-field");

    const trapFamilies: DefenseFamilyName[] = [
      "decoy-field",
      "decoy-route",
      "interaction",
    ];
    const independentPool = trapFamilies.filter((f) => !depSet.has(f));
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
    // ── LAB RANDOM PATH (v1) ─────────────────────────────────────────────
    const minFamilies = 2;
    const maxFamilies = Math.min(4, FAMILIES.length);
    const familyPool = LAB_FAMILIES_V1;
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

  // Handle semantic family (v1 selection/eligibility semantics)
  if (families.includes("semantic")) {
    let template =
      resolvedRecipe?.semanticTemplate !== undefined
        ? SEMANTIC_TEMPLATES.find((t) => t.id === resolvedRecipe!.semanticTemplate)
        : undefined;

    const isHoldoutMode = opts.holdoutMode === true;

    if (resolvedRecipe?.semanticTemplate !== undefined) {
      if (template && isHoldoutMode && template.partition !== "holdout") {
        throw new Error("TEMPLATE_NOT_ELIGIBLE_IN_MODE: " + resolvedRecipe!.semanticTemplate);
      }
    } else if (preDrawnProductionStrategy) {
      template = SEMANTIC_TEMPLATES.find((t) => t.id === preDrawnProductionStrategy);
    } else {
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
        const wordingStream = await domainOrThrow(root, "semantic-wording");
        template = pool[await wordingStream.nextInt(pool.length)];
      }
    }

    if (!template) {
      families.splice(families.indexOf("semantic"), 1);
    } else {
      if (template.requiresDecoyField && !families.includes("decoy-field")) {
        families.push("decoy-field");
        families.sort();
      }

      const isLabMode = isLab;
      let placementId: string | undefined;

      if (resolvedRecipe?.placementId !== undefined) {
        placementId = resolvedRecipe.placementId;
        if (!template.allowedPlacements.includes(placementId)) {
          throw new Error("INVALID_PLACEMENT_FOR_TEMPLATE: " + placementId);
        }
      } else {
        const eligiblePlacements = PLACEMENTS.filter(
          (p) => template!.allowedPlacements.includes(p.id) &&
                 (isLabMode || p.productionEligible)
        );

        if (eligiblePlacements.length === 0) {
          families.splice(families.indexOf("semantic"), 1);
          template = undefined;
        } else {
          const chosenPlacement = eligiblePlacements[await wordingPlacementIndex(root, eligiblePlacements.length)];
          placementId = chosenPlacement.id;

          if (chosenPlacement.productionEligible === false && !isLabMode) {
            families.splice(families.indexOf("semantic"), 1);
            template = undefined;
          }
        }
      }

      if (template && placementId) {
        const nonce = await generateNonce(nonceStream, 6);
        const semanticMode = resolvedRecipe?.semanticMode ?? template.defaultMode;

        const spotCount = 1 + (await spotsStream.nextInt(3));
        const spots = (await sampleWithoutReplacement(spotsStream, SPOT_ANCHORS, spotCount)).slice();

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

        if (template.requiresRoute && !families.includes("decoy-route")) {
          families.push("decoy-route");
          families.sort();
        }
      }
    }
  }

  // Handle decoy-field / decoy-route (v1: independent domains per material)
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

  // Handle interaction family (v1: recipe toggle honored, default true)
  if (families.includes("interaction")) {
    profile.interaction = { scoringEnabled: resolvedRecipe?.interactionScoring ?? true };
  }

  profile.profileVariantId = await buildVariantId(
    profile,
    opts.turnstileRequired ?? false
  );

  return profile;
}
