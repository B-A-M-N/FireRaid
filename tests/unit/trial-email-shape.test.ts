/**
 * P0-FIX (E4): trialEmail shape invariants.
 *
 * The origin-ledger trial email is SUBMITTED BY THE AGENT through the real
 * form, so it lives inside two constraints at once:
 *   1. uniqueness per trial (ledger lookup must be unambiguous), and
 *   2. the simplified-dom extractor's 80-char attribute cap — a longer
 *      email reaches the model TRUNCATED; the model "fixes" it, the next
 *      observation is byte-identical, and the agent loops on fill/email
 *      until the trial budget dies (observed live in exp-e4-headline:
 *      every raw-dom trial turned into a 5-action fill-email loop).
 * The E4 regression invariant: the address must survive round-tripping
 * through extractSimplifiedDom's `value.slice(0, 80)` UNCHANGED.
 */
import { describe, it, expect } from "vitest";
import { trialEmail } from "../../harness/core/origin-ledger.js";

const EXTRACTOR_VALUE_CAP = 80;

describe("trialEmail shape (P0-FIX E4)", () => {
  it("never exceeds the simplified-dom extractor's 80-char attribute cap", () => {
    // Realistic worst-case trial keys from the runner's grid.
    const trialKeys = [
      "exp-e4-headline-PRODUCTION-DEFAULT-raw-dom-FIRERAID_LLM_MODEL-baseline-min-effort-simplified-dom-4-rep4",
      "exp-e4-headline-CONTROL-human-FIRERAID_LLM_MODEL-baseline-honest-simplified-dom-0-rep0",
      "a-very-long-experiment-identifier-from-some-future-manifest-name".repeat(2),
      "x",
    ];
    for (const key of trialKeys) {
      const email = trialEmail("exp-e4-headline", key);
      expect(email.length, `email for key ${key.slice(0, 40)}… must fit the extractor cap`)
        .toBeLessThanOrEqual(EXTRACTOR_VALUE_CAP);
    }
  });

  it("stays unique across distinct trial keys AND distinct experiment ids", () => {
    const a = trialEmail("exp-one", "trial-a-rep0");
    const b = trialEmail("exp-one", "trial-b-rep0");
    const c = trialEmail("exp-two", "trial-a-rep0");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Same inputs → same email (deterministic resume/ledger join).
    expect(a).toBe(trialEmail("exp-one", "trial-a-rep0"));
  });

  it("is a valid single-token local part + fixed domain", () => {
    const email = trialEmail("exp-e4-headline", "some~weird!trial@key#with$chars");
    expect(email).toMatch(/^[a-z0-9-]+@ledger-probe\.invalid$/);
    expect(email.indexOf("@")).toBe(email.lastIndexOf("@"));
  });
});
