/**
 * FireRaid Engine Facade (FR-R3-086).
 * Unified entry point for the defense plane.
 */
import { deriveProfilePure, type DefenseRecipe } from "./profile.js";
import { correlate, type ServerObservationSet } from "./correlation.js";
import { decide, getPolicy } from "./decision.js";
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
    return deriveProfilePure({
      secret: this.secret,
      version: this.version,
      sessionId,
      mode: this.mode,
    }, recipe);
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

    const evidence = await correlate(options.profile, options.observations);
    const policy = getPolicy(options.policy || options.profile.scoringPolicy);
    const decision = decide(evidence, policy);

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
