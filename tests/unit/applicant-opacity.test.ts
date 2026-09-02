/**
 * Applicant-facing boundary opacity (P2) — the production response the
 * applicant sees must NEVER carry the score, risk tier, evidence, or the
 * raw core disposition. Lab mode (research) sees the truth by design;
 * production sees a workflow state only. These pin the two projection
 * helpers the submit route answers with, including the advisory posture
 * where the CORE decision may be QUARANTINE while the boundary still
 * forwards.
 */
import { describe, it, expect } from "vitest";
import { projectDecisionResponse, projectFinalized } from "../../src/routes/submit.js";

const PROD_ENV = { LAB_MODE: "false" } as never;
const LAB_ENV = { LAB_MODE: "true" } as never;

function decision(score: number, disposition: string) {
  return {
    disposition,
    score,
    signals: [{ class: "A", weight: 100, source: "CANARY_NONCE_REPRODUCED", verified: true }],
    reasons: [`Score ${score} exceeds threshold`],
  };
}

const RISK = { tier: "CAUSAL", confidence: "HIGH", recommendedAction: "QUARANTINE" };

/** Read a json() Response body. */
async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("production boundary opacity (advisory surface)", () => {
  it("primary path: QUARANTINE decision + advisory forward projects to the neutral received workflow, no score/tier/evidence", async () => {
    const res = projectDecisionResponse(PROD_ENV, decision(240, "QUARANTINE"), "ACCEPT" /* advisory forwards */, RISK);
    const b = await body(res);
    expect(b.status).toBe("received");
    // Advisory never signals the risk verdict to the applicant — the manual
    // approval queue (which everyone enters anyway) is where the annotation
    // does its work.
    expect(b.message).toBe("Submission received.");
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("240");
    expect(serialized).not.toContain("QUARANTINE");
    expect(serialized).not.toContain("CAUSAL");
    expect(serialized).not.toContain("CANARY_NONCE_REPRODUCED");
    expect(serialized).not.toContain("signals");
  });

  it("primary path: honest ACCEPT gets the same neutral receipt as everything else (audit item 24 — no disposition differential)", async () => {
    const res = projectDecisionResponse(PROD_ENV, decision(5, "ACCEPT"), "ACCEPT", { tier: "LOW", confidence: "LOW", recommendedAction: "CONTINUE" });
    const b = await body(res);
    expect(b.status).toBe("received");
    expect(b.message).toBe("Submission received.");
    // The ACCEPT/REVIEW differential is itself the leak: an autonomous agent
    // can iterate on submissions and learn the defenses from the delta.
    expect(b.disposition).toBeUndefined();
  });

  it("review-mode REVIEW decision never reveals its workflow state to the applicant", async () => {
    const res = projectDecisionResponse(PROD_ENV, decision(120, "REVIEW"), "REVIEW", RISK);
    const b = await body(res);
    const serialized = JSON.stringify(b);
    expect(b.status).toBe("received");
    expect(b.disposition).toBeUndefined();
    expect(serialized).not.toContain("120");
    expect(serialized).not.toContain("REVIEW");
    expect(serialized).not.toContain("signals");
  });

  it("finalized-replay path (resubmit/raced loser) never leaks the stored score or raw disposition", async () => {
    const res = projectFinalized(PROD_ENV, "QUARANTINE", 260, true);
    const b = await body(res);
    expect(b.status).toBe("received");
    expect(b.alreadySubmitted).toBe(true);
    // No disposition at all — not even the collapsed workflow state.
    expect(b.disposition).toBeUndefined();
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("260");
    expect(serialized).not.toContain("QUARANTINE");
    expect(serialized).not.toContain("REVIEW");
    expect(serialized).not.toContain("score");
  });

  it("lab mode KEEPS the research truth (disposition + score) — by design, never in production", async () => {
    const lab = await body(projectDecisionResponse(LAB_ENV, decision(240, "QUARANTINE"), "QUARANTINE", RISK));
    expect(lab.disposition).toBe("QUARANTINE");
    expect(lab.score).toBe(240);
    const labFinal = await body(projectFinalized(LAB_ENV, "QUARANTINE", 260, true));
    expect(labFinal.disposition).toBe("QUARANTINE");
    expect(labFinal.score).toBe(260);
  });
});
