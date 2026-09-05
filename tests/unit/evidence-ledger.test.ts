/**
 * P2 — evidence-ledger integrity. docs/evidence-ledger.json is the
 * machine-readable source of truth for claim tiers (RELEASE-STATUS,
 * THREAT-MODEL, SECURITY all reference it). These tests pin:
 *
 *   1. Schema shape + tier vocabulary (fail-closed on typos: an unknown
 *      tier or claim field must fail here, not silently desync the docs).
 *   2. MEASURED/PARTIALLY_ESTABLISHED claims point at completed experiment
 *      directories whose experiment.json is status=COMPLETE with
 *      records_expected == records_present (the analyzer's completeness
 *      gate, mirrored locally).
 *   3. LOCALLY_VERIFIED claims name release gates that actually exist in
 *      scripts/release-verify.mjs (a renamed gate breaks this test, not
 *      the ledger's meaning silently).
 *   4. Claim IDs are unique; every claim carries a doc_anchor.
 *
 * Rule (docs/RELEASE-STATUS.md): where docs and the ledger disagree, THE
 * LEDGER WINS — prose corrections land in the same change as the ledger.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "docs", "evidence-ledger.json"), "utf-8")) as EvidenceLedger;
const releaseVerifySource = readFileSync(join(ROOT, "scripts", "release-verify.mjs"), "utf-8");

const VALID_TIERS = new Set(Object.keys(ledger.tier_vocabulary));
const VALID_EVIDENCE_KINDS = new Set(["gate", "test", "experiment", "manual"]);
// Gates release-verify.mjs can actually run (fast + full).
const RUNNABLE_GATES = new Set(
  [...releaseVerifySource.matchAll(/runGate\("([^"]+)"/g)].map((m) => m[1])
);

interface EvidenceLedger {
  schema: string;
  updated: string;
  tier_vocabulary: Record<string, string>;
  claims: Array<{
    id: string;
    statement: string;
    tier: string;
    doc_anchor: string;
    evidence: Array<{ kind: string; ref?: string; id?: string; dir?: string; role?: string; detail?: string; deployed_sha?: string }>;
    scope_limits?: string[];
    notes?: string;
  }>;
}

describe("evidence ledger schema", () => {
  it("declares the canonical schema and a non-empty tier vocabulary", () => {
    expect(ledger.schema).toBe("fireraid-evidence-ledger/1");
    expect(Object.keys(ledger.tier_vocabulary).length).toBeGreaterThanOrEqual(4);
    for (const [tier, meaning] of Object.entries(ledger.tier_vocabulary)) {
      expect(typeof meaning, `tier ${tier}`).toBe("string");
      expect(meaning.length, `tier ${tier}`).toBeGreaterThan(10);
    }
  });

  it("every claim has a unique id, statement, valid tier, and doc anchor", () => {
    expect(ledger.claims.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const claim of ledger.claims) {
      expect(ids.has(claim.id), `duplicate claim id: ${claim.id}`).toBe(false);
      ids.add(claim.id);
      expect(claim.statement.length, claim.id).toBeGreaterThan(10);
      expect(VALID_TIERS.has(claim.tier), `${claim.id}: unknown tier "${claim.tier}"`).toBe(true);
      expect(claim.doc_anchor, claim.id).toMatch(/^docs\//);
    }
  });

  it("every evidence entry uses a known kind with the right payload", () => {
    for (const claim of ledger.claims) {
      for (const ev of claim.evidence) {
        expect(VALID_EVIDENCE_KINDS.has(ev.kind), `${claim.id}: kind ${ev.kind}`).toBe(true);
        if (ev.kind === "gate") {
          expect(typeof ev.ref, `${claim.id} gate ref`).toBe("string");
          // The gate must be one release-verify can run — LOCALLY_VERIFIED
          // means a deterministic local gate, not a wish.
          expect(
            RUNNABLE_GATES.has(ev.ref!),
            `${claim.id}: gate "${ev.ref}" is not a runGate() in scripts/release-verify.mjs`
          ).toBe(true);
        }
        if (ev.kind === "test") {
          expect(ev.ref, `${claim.id} test ref`).toMatch(/^(tests|harness)\//);
        }
        if (ev.kind === "experiment") {
          expect(ev.id, `${claim.id} experiment id`).toBeTruthy();
          expect(ev.dir, `${claim.id} experiment dir`).toMatch(/^harness\/results\//);
          expect(typeof ev.role, `${claim.id} experiment role`).toBe("string");
        }
        if (ev.kind === "manual") {
          expect(typeof ev.detail, `${claim.id} manual detail`).toBe("string");
        }
        // FR-P1-14: a live-deployment smoke recorded as manual evidence must
        // carry a machine-readable deployed_sha so release-verify's
        // remote-smoke-current gate can compare it to HEAD. Without it, a stale
        // smoke can be carried forward silently.
        if (claim.id === "remote-deployment-smoke") {
          expect(typeof ev.deployed_sha, `${claim.id} deployed_sha`).toBe("string");
          expect(ev.deployed_sha!.length, `${claim.id} deployed_sha nonempty`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("evidence ledger completeness gating (mirror of analyze.py)", () => {
  const comparativeClaims = ledger.claims.filter(
    (c) => c.tier === "MEASURED" || c.tier === "PARTIALLY_ESTABLISHED"
  );

  it("comparative claims exist and point at COMPLETE experiments with full record counts", () => {
    expect(comparativeClaims.length).toBeGreaterThanOrEqual(1);
    for (const claim of comparativeClaims) {
      const experiments = claim.evidence.filter((e) => e.kind === "experiment");
      expect(experiments.length, `${claim.id} must cite experiments`).toBeGreaterThanOrEqual(1);
      for (const ev of experiments) {
        const manifest = JSON.parse(
          readFileSync(join(ROOT, ev.dir!, "experiment.json"), "utf-8")
        ) as { status: string; records_expected: number; records_present: number };
        expect(manifest.status, `${claim.id}/${ev.id}: not COMPLETE`).toBe("COMPLETE");
        expect(manifest.records_present, `${claim.id}/${ev.id}: record count mismatch`).toBe(
          manifest.records_expected
        );
      }
    }
  });

  it("overreach guards: known unproven claims are NOT above their evidence", () => {
    const tierOf = (id: string) => ledger.claims.find((c) => c.id === id)?.tier;
    // No completed per-extractor / per-architecture comparison exists.
    expect(tierOf("per-architecture-ranking")).toBe("NOT_YET_ESTABLISHED");
    // Efficacy is bounded: partially established with recorded scope limits,
    // never presented as MEASURED deploy-grade.
    expect(tierOf("autonomous-agent-efficacy")).toBe("PARTIALLY_ESTABLISHED");
    const efficacy = ledger.claims.find((c) => c.id === "autonomous-agent-efficacy")!;
    expect(efficacy.scope_limits!.length).toBeGreaterThanOrEqual(2);
    // Single-model caveat must survive into the ledger (stripping it is the
    // classic overreach move).
    expect(efficacy.scope_limits!.join(" ")).toMatch(/Single model/i);
    expect(efficacy.scope_limits!.join(" ")).toMatch(/attrition/i);
  });
});
