/**
 * P1-AUDIT-2 Phase D (audit item 5) — the shared artifact-generation core.
 *
 * ONE canonical function, buildArtifactSet(profile, mode), resolves WHAT the
 * defense emits for a session: which artifacts exist, their session-bound
 * identifiers, their opacity posture, and the template-rendered semantic
 * body (FR-R6-048: template text is never rewritten — only runtime
 * substitutions are supplied, HERE, once).
 *
 * The Worker renderer (core/renderer.ts) and the host renderer
 * (host-adapter/reference-render.ts) are PRESENTATION MAPPERS over this
 * set — they choose HTML strings, never policy. The two-divergent-renderers
 * defect class (the host renderer silently re-deriving policy and drifting:
 * visible production decoys, production semantic canaries, greppable
 * signatures) is eliminated at the root: policy decisions live in exactly
 * one place.
 *
 * Parity contract (tests/unit/artifact-parity.test.ts): for the same
 * profile + mode, both mappers must produce HTML that agrees on every
 * semantic invariant — which artifacts exist, what identifiers they carry,
 * and their opacity posture.
 */
import type { DefenseProfile } from "../types/profile.js";
import { SEMANTIC_TEMPLATES, PLACEMENTS } from "./catalog.js";
import { MAX_EVENTS_PER_BATCH, MAX_EVENT_PAYLOAD_BYTES } from "../types/telemetry.js";

/** Opacity posture of an artifact — resolved HERE, consumed verbatim. */
export type ArtifactPresentation =
  /** Lab: FireRaid-visible markers for research grepping. */
  | "lab-marked"
  /** Production: neutral carriers, no FireRaid-identifying signature (P1-22). */
  | "neutral";

export interface DecoyFieldArtifact {
  fieldName: string;
  elementId: string;
  /**
   * P1-AUDIT-2 blocker 1: production decoys MUST be visually hidden
   * (inline-safe technique, no host-CSS dependency in the host mapper).
   */
  presentation: Extract<ArtifactPresentation, "lab-marked" | "neutral">;
}

export interface DecoyRouteArtifact {
  endpointToken: string;
  /**
   * Lab: visible "/c/<token>" text for researcher verification.
   * Production: inert <template>, token in raw HTML only, no visible path.
   */
  presentation: Extract<ArtifactPresentation, "lab-marked" | "neutral">;
}

export interface SemanticArtifact {
  templateId: string;
  placementId: string;
  position: string;
  /** Canonical template-rendered body — both mappers embed verbatim. */
  bodyHtml: string;
  /** Presentation resolves to lab-marked ALWAYS: S01–S08 are lab-only
   *  (FR-R7-013) — buildArtifactSet returns null for semantic in production
   *  rather than a neutral carrier, because an instruction-bearing template
   *  has no neutral production form. */
}

export interface ClientConfigArtifact {
  telemetry: DefenseProfile["telemetry"];
  interactionScoring: boolean;
  limits: { maxEventsPerBatch: number; maxBatchBytes: number };
}

export interface DefenseArtifactSet {
  decoyField: DecoyFieldArtifact | null;
  decoyRoute: DecoyRouteArtifact | null;
  /** null in production — FR-R7-013: S01–S08 never render there. */
  semantic: SemanticArtifact | null;
  clientConfig: ClientConfigArtifact;
  /** Production-only inert machine-targeted notice; null in lab. */
  productionNotice: string | null;
}

const PRODUCTION_NOTICE_TEXT =
  "This site uses same-origin verification challenges. " +
  "Automated clients should expect a verification token to be presented inline.";

/** Deterministic HTML-escape for any body-embedded runtime text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve the complete defense artifact set for a profile under a mode.
 * The single point where WHAT-is-emitted policy lives.
 */
export function buildArtifactSet(
  profile: DefenseProfile,
  opts: { labMode: boolean }
): DefenseArtifactSet {
  const { labMode } = opts;
  const presentation: ArtifactPresentation = labMode ? "lab-marked" : "neutral";

  // Decoy field: exists iff the family was issued.
  const decoyField: DecoyFieldArtifact | null = profile.decoyField
    ? {
        fieldName: profile.decoyField.fieldName,
        elementId: profile.decoyField.elementId,
        presentation,
      }
    : null;

  // Decoy route: exists iff the family was issued.
  const decoyRoute: DecoyRouteArtifact | null = profile.decoyRoute
    ? {
        endpointToken: profile.decoyRoute.endpointToken,
        presentation,
      }
    : null;

  // Semantic canary: FR-R7-013 — S01–S08 are LAB-ONLY instruction templates.
  // Production returns null (no semantic artifact AT ALL), which is the
  // policy both renderers previously (inconsistently) re-derived.
  let semantic: SemanticArtifact | null = null;
  if (profile.semantic && labMode) {
    const template = SEMANTIC_TEMPLATES.find((t) => t.id === profile.semantic!.templateId);
    const placement = PLACEMENTS.find((p) => p.id === profile.semantic!.placementId);
    if (template && placement) {
      const endpoint = profile.decoyRoute
        ? `/c/${profile.decoyRoute.endpointToken}`
        : "/c/<token>";
      const field = profile.decoyField?.fieldName;
      semantic = {
        templateId: template.id,
        placementId: placement.id,
        position: placement.position,
        bodyHtml: template.render({
          nonce: profile.semantic.nonce,
          endpoint,
          field,
          mode: profile.semantic.mode,
        }),
      };
    }
  }

  const clientConfig: ClientConfigArtifact = {
    telemetry: profile.telemetry,
    interactionScoring: profile.interaction?.scoringEnabled ?? false,
    limits: {
      maxEventsPerBatch: MAX_EVENTS_PER_BATCH,
      maxBatchBytes: MAX_EVENT_PAYLOAD_BYTES,
    },
  };

  return {
    decoyField,
    decoyRoute,
    semantic,
    clientConfig,
    // Lab emits the research banner path instead; the notice is production-only.
    productionNotice: labMode ? null : escapeHtml(PRODUCTION_NOTICE_TEXT),
  };
}
