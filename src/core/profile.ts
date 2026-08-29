/**
 * Deterministic defense profile generation (FR-INV-002, FR-INV-011).
 * Reconstructable purely from (secret, version, session_id).
 * FIX: Accepts explicit version parameter for reconstruction.
 * FIX: Filters placements by environment eligibility and template allowedPlacements.
 * FIX: Deep canonical hashProfile (FR-037).
 * FIX: Environment filtering (FR-R2-016).
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
import type {
  DefenseProfile,
  DefenseFamilyName,
} from "../types/profile.js";

const FAMILIES: DefenseFamilyName[] = [
  "semantic",
  "decoy-field",
  "decoy-route",
  "interaction",
];

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

export interface DeriveProfileOptions {
  secret: string;
  version: number;
  sessionId: string;
  mode?: "lab" | "production";
}

export async function deriveProfile(
  env: Env,
  sessionId: string,
  version?: number
): Promise<DefenseProfile> {
  const ver = version ?? profileVersion(env);
  const seed = await deriveSeed(env.FIRERAID_PROFILE_SECRET, ver, sessionId);
  const stream = new SeedStream(seed);

  // Family count: 2..min(4, FAMILIES.length)
  const minFamilies = 2;
  const maxFamilies = Math.min(4, FAMILIES.length);
  const familyCount = minFamilies + (await stream.nextInt(maxFamilies - minFamilies + 1));
  const families = (await sampleWithoutReplacement(stream, FAMILIES, familyCount)).sort();

  const profile: DefenseProfile = {
    version: ver,
    profileId: profileId(seed),
    sessionId,
    families,
    telemetry: {
      captureFocus: true,
      captureInput: true,
      captureChange: true,
      capturePointer: await stream.nextInt(2) === 0,
      captureKey: await stream.nextInt(2) === 0,
      captureSubmit: true,
    },
    scoringPolicy: "default-v1",
  };

  if (families.includes("semantic")) {
    const template = SEMANTIC_TEMPLATES[await stream.nextInt(SEMANTIC_TEMPLATES.length)];

    // FIX: Filter placements by template.allowedPlacements AND environment eligibility (FR-R2-016)
    const isLabMode = env.LAB_MODE === "true";
    const eligiblePlacements = PLACEMENTS.filter(
      (p) => template.allowedPlacements.includes(p.id) &&
             (isLabMode || p.productionEligible)
    );
    
    if (eligiblePlacements.length === 0) {
      // Fallback: no semantic canary if no eligible placements
      families.splice(families.indexOf("semantic"), 1);
    } else {
      const placement = eligiblePlacements[await stream.nextInt(eligiblePlacements.length)];

      const nonce = await generateNonce(stream, 6);
      const modes: ("observe" | "handoff" | "decoy")[] = ["observe", "handoff", "decoy"];
      const mode = modes[await stream.nextInt(modes.length)];

      profile.semantic = { templateId: template.id, placementId: placement.id, nonce, mode };

      // FIX: Semantic canaries reference /c/:token — ensure decoy-route exists
      if (!families.includes("decoy-route")) {
        families.push("decoy-route");
        families.sort();
      }
    }
  }

  if (families.includes("decoy-field") || families.includes("decoy-route")) {
    const fieldName = `fr_${await generateToken(stream, 4)}`;
    const endpointToken = await generateToken(stream, 6);
    const elementId = `fr_${await generateToken(stream, 4)}`;
    profile.decoy = { fieldName, endpointToken, elementId };
  }

  return profile;
}
