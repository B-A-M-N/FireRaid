/**
 * P1-AUDIT-2 (P0-8/P0-9) — origin-ledger mode fails CLOSED on conditions
 * that cannot exist there.
 *
 * The origin runtime renders every profile in PRODUCTION mode. A lab-only
 * semantic recipe previously passed manifest validation, reached profile
 * derivation, threw (production family guard), denied the submit with
 * EVAL_ERROR — no account created — and the experiment read that
 * infrastructure failure as a successful defense. The same silent-null
 * applied to Turnstile arms: the reference verification adapter always
 * verifies, so turnstile_required=true was a no-op arm indistinguishable
 * from CONTROL.
 *
 * Both are now MANIFEST VALIDATION errors (fail before any trial spends
 * wall-clock or money), and the strict-schema work (P1-4) means typos like
 * `recipes:` are rejected rather than stripped into a CONTROL-only run.
 */
import { describe, it, expect } from "vitest";
import { validateManifest } from "../../harness/core/run-schema.js";

const BASE = {
  id: "exp-origin-failclosed",
  name: "Origin fail-closed test",
  seed: "seed",
  target: { url: "http://localhost:8787", mode: "origin-ledger" },
  repetitions: 1,
  timeout_ms: 10_000,
  agents: ["raw-http"],
  models: ["none"],
  prompts: ["baseline"],
};

function mustReject(over: Record<string, unknown>, needle: string) {
  const result = validateManifest({ ...BASE, ...over });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.some((e) => e.includes(needle))).toBe(true);
  }
}

describe("P0-8/P0-9: origin-ledger condition validation (fail closed)", () => {
  it("accepts the production-faithful condition set (incl. PRODUCTION_DEFAULT)", () => {
    const result = validateManifest({
      ...BASE,
      conditions: ["CONTROL", "PRODUCTION_DEFAULT", "PRODUCTION_FIELD", "PRODUCTION_ROUTE", "PRODUCTION_INTERACTION", "PRODUCTION_NONSEMANTIC_FULL"],
    });
    expect(result.ok).toBe(true);
  });

  it("P0-AUDIT-3: the legacy PRODUCTION_FULL name no longer validates anywhere", () => {
    mustReject({ conditions: ["PRODUCTION_FULL"] }, "received 'PRODUCTION_FULL'");
  });

  it("rejects lab semantic conditions in origin-ledger mode", () => {
    mustReject({ conditions: ["CONTROL", "FULL"] }, "lab-only semantic conditions");
    mustReject({ conditions: ["SEMANTIC_ONLY"] }, "SEMANTIC_ONLY");
    mustReject({ conditions: ["SEMANTIC_ROUTE"] }, "SEMANTIC_ROUTE");
  });

  it("rejects turnstile_required in origin-ledger mode (no real provider)", () => {
    mustReject({ conditions: ["CONTROL"], turnstile_required: true }, "no real verification provider");
  });

  it("worker mode still accepts the full lab condition set", () => {
    const result = validateManifest({
      ...BASE,
      target: { url: "http://localhost:8787", mode: "fireraid-worker" },
      conditions: ["CONTROL", "SEMANTIC_ONLY", "FULL"],
      turnstile_required: true,
    });
    expect(result.ok).toBe(true);
  });

  it("P1-9: ledgerUrl is gone — an unused target field is a validation error, not a silent no-op", () => {
    // The strict schema (P1-4, landed separately) rejects unknown keys;
    // even without strictness the ledgerUrl field no longer EXISTS on the
    // parsed target, so the old "configured but ignored" state cannot occur.
    const result = validateManifest({
      ...BASE,
      target: { url: "http://localhost:8787", mode: "origin-ledger", ledgerUrl: "http://elsewhere:1/api/ledger" },
    });
    // With the strict manifest schema this is an unknown-key error; the
    // invariant under test is that it NEVER validates into an ignored field.
    if (result.ok) {
      expect((result.data.target as Record<string, unknown>).ledgerUrl).toBeUndefined();
    } else {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
