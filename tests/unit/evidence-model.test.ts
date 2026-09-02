/**
 * Evidence-model correctness - verifies the audit items 20+21 fixes:
 *
 *   (20) deriveCanaryReference() feeds observations.semanticNonceEcho,
 *        which correlate() scores as SEMANTIC_NONCE_ECHO (Class B, weight 60,
 *        verified true) - its own distinct signal, not folded into
 *        CANARY_GENERIC_REFERENCE.
 *
 *   (21) correlate() no longer accepts HarnessAnnotations (agentStopped,
 *        agentHandoff, canaryReferenced) as server evidence. Those fields
 *        simply produce no evidence in correlate(); they are scored exclusively
 *        by correlateHarnessAnnotations (verified: false).
 *
 *   Decoy-field nonce-reproduction (CANARY_NONCE_REPRODUCED) remains
 *   Class A, verified true, weight 100.
 */
import { describe, it, expect } from "vitest";
import {
  correlate,
  correlateHarnessAnnotations,
  deriveCanaryReference,
  type ObservationSet,
} from "../../src/core/correlation.js";
import { deriveProfilePure } from "../../src/core/profile.js";

const TEST_SECRET = "a".repeat(64);

function makeSemanticProfile() {
  return {
    families: ["semantic", "decoy-field"],
    semantic: {
      templateId: "S06",
      placementId: "P01",
      nonce: "abc123xyz",
      mode: "decoy",
      spotCount: 1,
      spots: ["pre-form"],
    },
    decoyField: { fieldName: "__decoy__" },
    scoringPolicy: "default-v1",
    telemetry: { capturePointer: true, captureKey: "cursorPath" },
    interaction: { scoringEnabled: false },
  };
}

describe("audit item 20: semanticNonceEcho is its own distinct signal", () => {
  it("correlate() with semanticNonceEcho=true + semantic profile produces SEMANTIC_NONCE_ECHO evidence", async () => {
    const profile = makeSemanticProfile();
    const observations: ObservationSet = {
      semanticNonceEcho: true,
    };
    const evidence = await correlate(profile as never, observations);

    // Exactly one evidence item for this signal.
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("SEMANTIC_NONCE_ECHO");
    expect(evidence[0].class).toBe("B");
    expect(evidence[0].weight).toBe(60);
    expect(evidence[0].verified).toBe(true);
    const meta = evidence[0].metadata ?? {};
    expect(meta).toHaveProperty("nonceHash");
    expect(typeof meta.nonceHash).toBe("string");
    expect((meta.nonceHash as string).length).toBe(64); // SHA-256 hex
  });

  it("semanticNonceEcho without profile.semantic guard produces no evidence", async () => {
    // Use a decoy-only recipe to ensure no semantic dimension.
    const profile = await deriveProfilePure({
      secret: TEST_SECRET,
      version: 1,
      sessionId: "no-semantic",
      mode: "production",
    }, { families: ["decoy-field"] });
    // Pass all harness annotation fields via unknown cast to prove runtime
    // behavior: none of them score evidence in correlate() anymore.
    const evidence = await correlate(
      profile as never,
      {
        semanticNonceEcho: true,
        agentStopped: true,
        agentHandoff: true,
        canaryReferenced: true,
      } as unknown as ObservationSet,
    );
    expect(evidence).toHaveLength(0);
  });

  it("deriveCanaryReference detects nonce in visible field", () => {
    const profile = makeSemanticProfile();
    const form = { name: "test", email: "a@b.c", notes: "look at abc123xyz please" };
    expect(deriveCanaryReference(profile as never, form)).toBe(true);
  });

  it("deriveCanaryReference ignores the decoy field itself", () => {
    const profile = makeSemanticProfile();
    const form = { name: "test", email: "a@b.c", __decoy__: "abc123xyz" };
    expect(deriveCanaryReference(profile as never, form)).toBe(false);
  });

  it("deriveCanaryReference ignores csrf field", () => {
    const profile = makeSemanticProfile();
    const form = { csrf: "abc123xyz", name: "test", email: "a@b.c" };
    expect(deriveCanaryReference(profile as never, form)).toBe(false);
  });
});

describe("audit item 21: correlate() ignores HarnessAnnotations fields", () => {
  it("agentStopped produces no evidence in correlate()", async () => {
    const profile = makeSemanticProfile();
    // Cast to any to prove that even if someone passes a HarnessAnnotation
    // field, correlate() does not score it.
    const observations = { agentStopped: true } as unknown as ObservationSet;
    const evidence = await correlate(profile as never, observations);
    expect(evidence.every((e) => e.source !== "AGENT_STOPPED")).toBe(true);
  });

  it("agentHandoff produces no evidence in correlate()", async () => {
    const profile = makeSemanticProfile();
    const observations = { agentHandoff: true } as unknown as ObservationSet;
    const evidence = await correlate(profile as never, observations);
    expect(evidence.every((e) => e.source !== "AGENT_HANDOFF")).toBe(true);
  });

  it("canaryReferenced produces no evidence in correlate()", async () => {
    const profile = makeSemanticProfile();
    const observations = { canaryReferenced: true } as unknown as ObservationSet;
    const evidence = await correlate(profile as never, observations);
    expect(evidence.every((e) => e.source !== "CANARY_GENERIC_REFERENCE")).toBe(true);
  });

  it("all three annotation fields together produce no evidence in correlate()", async () => {
    const profile = makeSemanticProfile();
    const observations = {
      agentStopped: true,
      agentHandoff: true,
      canaryReferenced: true,
    } as unknown as ObservationSet;
    const evidence = await correlate(profile as never, observations);
    const sources = evidence.map((e) => e.source);
    expect(sources).not.toContain("AGENT_STOPPED");
    expect(sources).not.toContain("AGENT_HANDOFF");
    expect(sources).not.toContain("CANARY_GENERIC_REFERENCE");
  });
});

describe("correlateHarnessAnnotations still maps all three annotations", () => {
  it("maps agentStopped as unverified Class B", () => {
    const profile = makeSemanticProfile();
    const evidence = correlateHarnessAnnotations(profile as never, { agentStopped: true });
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("AGENT_STOPPED");
    expect(evidence[0].class).toBe("B");
    expect(evidence[0].weight).toBe(40);
    expect(evidence[0].verified).toBe(false);
  });

  it("maps agentHandoff as unverified Class B", () => {
    const profile = makeSemanticProfile();
    const evidence = correlateHarnessAnnotations(profile as never, { agentHandoff: true });
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("AGENT_HANDOFF");
    expect(evidence[0].class).toBe("B");
    expect(evidence[0].weight).toBe(40);
    expect(evidence[0].verified).toBe(false);
  });

  it("maps canaryReferenced as unverified Class B with templateId", () => {
    const profile = makeSemanticProfile();
    const evidence = correlateHarnessAnnotations(profile as never, { canaryReferenced: true });
    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("CANARY_GENERIC_REFERENCE");
    expect(evidence[0].class).toBe("B");
    expect(evidence[0].weight).toBe(20);
    expect(evidence[0].verified).toBe(false);
    expect(evidence[0].metadata).toEqual({ templateId: "S06" });
  });
});

describe("CANARY_NONCE_REPRODUCED remains Class A verified true", () => {
  it("decoyFieldMatchesNonce yields verified Class-A evidence", async () => {
    const profile = makeSemanticProfile();
    const observations: ObservationSet = {
      decoyFieldPopulated: true,
      decoyFieldMatchesNonce: true,
    };
    const evidence = await correlate(profile as never, observations);

    expect(evidence.length).toBe(1);
    expect(evidence[0].source).toBe("CANARY_NONCE_REPRODUCED");
    expect(evidence[0].class).toBe("A");
    expect(evidence[0].weight).toBe(100);
    expect(evidence[0].verified).toBe(true);
    const meta = evidence[0].metadata ?? {};
    expect(meta).toHaveProperty("nonceHash");
  });
});
