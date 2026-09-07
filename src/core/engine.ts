/**
 * FireRaid Engine Facade (FR-R3-086).
 * Unified entry point for the defense plane.
 */
import { deriveProductionProfileByVersion, deriveEvaluationProfileByVersion } from "./profile-versions.js";
import type { DefenseRecipe } from "./recipe-schema.js";
import { type ServerObservationSet } from "./correlation.js";
import { correlateByVersion, getScoringPolicyByVersion, decideByVersion } from "./scoring-versions.js";
import type { DefenseProfile } from "../types/profile.js";

export interface FireRaidOptions {
  secret: string;
  version: number;
  /**
   * FR-R5-032: Operation mode.
   * - "production" (default): safe, deterministic mode.
   * - "lab": experimental mode with relaxed constraints.
   */
  mode?: "production" | "lab";
}

export interface SubmitOptions {
  sessionId: string;
  profile: DefenseProfile;
  observations: ServerObservationSet;
  policy?: string;
}

export interface SubmitResult {
  disposition: string;
  score: number;
  evidence: Array<{
    id: string;
    class: "A" | "B" | "C";
    weight: number;
    source: string;
    verified: boolean;
  }>;
  reasons: string[];
}

export class FireRaidEngine {
  private secret: string;
  private version: number;
  private mode: "production" | "lab";

  constructor(options: FireRaidOptions) {
    this.secret = options.secret;
    this.version = options.version;
    // FR-R5-032: default to "production" (safe default)
    this.mode = options.mode ?? "production";
  }

  /**
   * Derive a deterministic defense profile for a session.
   */
  async deriveProfile(
    sessionId: string,
    recipe?: DefenseRecipe
  ): Promise<DefenseProfile> {
    // FR-R5-032: "production" mode goes through the production API (no
    // recipe override); "lab" is the evaluation plane. FR-P0-04: both go
    // through the version dispatch (frozen implementations, fail-closed on
    // unknown versions).
    if (this.mode === "lab") {
      return deriveEvaluationProfileByVersion(
        { secret: this.secret, version: this.version, sessionId, mode: "lab" },
        recipe
      );
    }
    return deriveProductionProfileByVersion({ secret: this.secret, version: this.version, sessionId });
  }

  /**
   * Process a submission and return a decision.
   * FR-R5-032: Validates sessionId consistency when both session-level and
   * profile-level ids are present.
   */
  async submit(options: SubmitOptions): Promise<SubmitResult> {
    // FR-R5-032: Verify sessionId consistency when both are present
    if (options.sessionId && options.profile.sessionId) {
      if (options.sessionId !== options.profile.sessionId) {
        throw new Error("sessionId mismatch");
      }
    }

    // FR-RR-15: version-routed frozen scoring — an unknown policy or an
    // unsupported profile version throws (fail closed), never a silent
    // default-v1 score under live code.
    const evidence = await correlateByVersion(options.profile, options.observations);
    const policy = getScoringPolicyByVersion(
      options.profile.version,
      options.policy || options.profile.scoringPolicy
    );
    const decision = decideByVersion(options.profile, evidence, policy);

    return {
      disposition: decision.disposition,
      score: decision.score,
      evidence: decision.signals.map((s) => ({
        id: s.id,
        class: s.class,
        weight: s.weight,
        source: s.source,
        verified: s.verified,
      })),
      reasons: decision.reasons,
    };
  }
}

/**
 * Factory function for creating a FireRaid engine.
 */
export function createFireRaid(options: FireRaidOptions): FireRaidEngine {
  return new FireRaidEngine(options);
}
