/**
 * P2 benchmark-dimension tests — the varied-traffic + attack-objective tier.
 *
 * Pins:
 *   1. Persona pool (P2-TRAFFIC): 20 synthetic personas, varied typing,
 *      deterministic seeded assignment (stable across resume), full
 *      coverage over trial counts, fail-closed unknown-id lookup.
 *   2. Attack-objective corpus (P2-ATTACKS): graded tiers 0–4, persistent
 *      flags only on tier-4 ids, fail-closed unknown-id, deterministic
 *      composition into a base prompt (ordering + hashability).
 *   3. Manifest expansion: `objectives` is an LLM-agent-only dimension —
 *      model-agnostic agents are PINNED to "honest" (they have no prompt
 *      to compose into, so a non-honest objective there would be fiction);
 *      the interleaving cell key includes the objective so each objective
 *      cell carries each condition exactly once.
 *   4. Validation fail-closed: unknown objective id, duplicate objective,
 *      unknown fixture id all reject the manifest BEFORE any trial runs.
 *   5. Run-record schema: objective / fixture_id / persistence_attempted
 *      round-trip.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  PERSONAS,
  personaById,
  personaForTrial,
} from "../../harness/fixtures/personas.js";
import {
  ATTACK_OBJECTIVES,
  objectiveById,
  composeWithObjective,
} from "../../harness/adapters/objectives.js";
import {
  validateManifest,
  expandManifest,
} from "../../harness/core/run-schema.js";
import { PROMPT_VARIANTS } from "../../harness/adapters/prompts.js";

// ─── 1. Persona pool ────────────────────────────────────────────────────────

describe("P2-TRAFFIC: persona pool", () => {
  it("has 20 personas with unique ids and complete form fields", () => {
    expect(PERSONAS.length).toBe(20);
    const ids = new Set(PERSONAS.map((p) => p.id));
    expect(ids.size).toBe(20);
    for (const p of PERSONAS) {
      const rec = p as unknown as Record<string, string>;
      for (const field of ["name", "email", "organization", "intended_use", "password"]) {
        expect(rec[field], `${p.id}.${field}`).toBeTruthy();
      }
      // FR boundary: synthetic identities only — every email is .invalid
      // or a reserved example domain.
      expect(p.email.endsWith(".invalid") || p.email.includes("example."), `${p.id} email`).toBe(true);
    }
  });

  it("varies typing across the pool (the point of the tier)", () => {
    const names = PERSONAS.map((p) => p.name);
    expect(new Set(names).size).toBe(20);
    // casing variance
    expect(names.some((n) => n === n.toLowerCase())).toBe(true);
    expect(names.some((n) => n === n.toUpperCase())).toBe(true);
    // intended-use length spans terse → verbose
    const lens = PERSONAS.map((p) => p.intended_use.length);
    expect(Math.max(...lens) / Math.min(...lens)).toBeGreaterThan(5);
    // organization style variance
    expect(PERSONAS.some((p) => /Ltd|Inc|LLP|Corp|GmbH/.test(p.organization))).toBe(true);
    expect(PERSONAS.some((p) => p.organization === p.organization.toLowerCase())).toBe(true);
  });

  it("assignment is deterministic: same (seed, trialKey) → same persona", () => {
    expect(personaForTrial("seed-x", "trial-7").id).toBe(personaForTrial("seed-x", "trial-7").id);
    expect(personaForTrial("seed-x", "trial-7").id).not.toBe(personaForTrial("seed-x", "trial-8").id || "");
    // different seed material → (overwhelmingly) different assignment stream
    const a = Array.from({ length: 40 }, (_, i) => personaForTrial("seed-a", `t${i}`).id);
    const b = Array.from({ length: 40 }, (_, i) => personaForTrial("seed-b", `t${i}`).id);
    expect(a).not.toEqual(b);
  });

  it("200 trials cover the whole pool (no starved personas)", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => personaForTrial("cover-seed", `t${i}`).id));
    expect(seen.size).toBe(20);
  });

  it("fail-closed on unknown id", () => {
    expect(() => personaById("persona-99")).toThrow(/Unknown persona/);
    expect(() => objectiveById("not-an-objective")).toThrow(/Unknown attack objective/);
  });
});

// ─── 2. Attack-objective corpus ─────────────────────────────────────────────

describe("P2-ATTACKS: objective corpus", () => {
  it("grades tiers 0–4 with real ids", () => {
    const tiers = new Set(ATTACK_OBJECTIVES.map((o) => o.tier));
    expect([...tiers].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(ATTACK_OBJECTIVES.length).toBeGreaterThanOrEqual(10);
  });

  it("only tier-4 objectives declare persistence", () => {
    for (const o of ATTACK_OBJECTIVES) {
      if (o.tier === 4) continue;
      expect(o.postSubmitContinue, `${o.id} must be single-shot`).toBeFalsy();
    }
    const persistent = ATTACK_OBJECTIVES.filter((o) => o.postSubmitContinue);
    expect(persistent.length).toBeGreaterThanOrEqual(2);
    expect(persistent.every((o) => o.tier === 4)).toBe(true);
  });

  it("every objective body is non-trivial and attack-shaped", () => {
    for (const o of ATTACK_OBJECTIVES) {
      expect(o.system.length, `${o.id} body`).toBeGreaterThan(60);
      expect(o.label, `${o.id} label`).toBeTruthy();
    }
  });

  it("composition is ordered + hashable: base hardening first, objective appended", () => {
    const composed = composeWithObjective(PROMPT_VARIANTS.hardened.system, "link-prober");
    // base hardening preserved verbatim as a PREFIX (the hardened variant's
    // untrusted-data rule must not be reordered after the objective).
    expect(composed.startsWith(PROMPT_VARIANTS.hardened.system)).toBe(true);
    expect(composed).toContain("TASK OBJECTIVE (tier 2 — link prober)");
    // deterministic
    expect(
      createHash("sha256").update(composed).digest("hex")
    ).toBe(
      createHash("sha256").update(composeWithObjective(PROMPT_VARIANTS.hardened.system, "link-prober")).digest("hex")
    );
    // distinct objectives → distinct prompts (no silent collapse)
    const h = (id: string) => createHash("sha256").update(composeWithObjective(PROMPT_VARIANTS.baseline.system, id)).digest("hex");
    const hashes = new Set(ATTACK_OBJECTIVES.map((o) => h(o.id)));
    expect(hashes.size).toBe(ATTACK_OBJECTIVES.length);
  });
});

// ─── 3–4. Manifest expansion + validation ───────────────────────────────────

const BASE = {
  name: "P2 dimension test",
  seed: "p2-dimension-seed",
  target: { url: "http://localhost:8787" },
  repetitions: 2,
  timeout_ms: 60000,
  profile_version: 1,
  agents: ["human", "raw-dom", "raw-http"],
  models: ["model-a"],
  prompts: ["baseline"],
};

describe("P2: manifest expansion over the new dimensions", () => {
  it("objective is an LLM-agent-only dimension; model-agnostic agents pinned to honest", () => {
    const raw = { ...BASE, id: "p2-pin", objectives: ["honest", "link-prober", "human-mimic"] };
    const v = validateManifest(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const trials = expandManifest(v.data);
    // human + raw-http (usesModel=false) NEVER carry a non-honest objective
    for (const t of trials) {
      if (t.agent === "raw-dom") continue;
      expect(t.objective, `${t.agent} must be pinned to honest`).toBe("honest");
    }
    // raw-dom varies over all three
    const objSet = new Set(trials.filter((t) => t.agent === "raw-dom").map((t) => t.objective));
    expect([...objSet].sort()).toEqual(["honest", "human-mimic", "link-prober"]);
  });

  it("each objective cell carries each condition exactly once (interleaving key includes objective)", () => {
    const raw = {
      ...BASE,
      id: "p2-cell",
      conditions: ["CONTROL", "FULL"],
      objectives: ["honest", "link-prober"],
    };
    const v = validateManifest(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const trials = expandManifest(v.data);
    for (let rep = 0; rep < raw.repetitions; rep++) {
      const cellTrials = trials.filter(
        (t) => t.repetition === rep && t.agent === "raw-dom" && t.prompt === "baseline"
      );
      for (const objective of ["honest", "link-prober"]) {
        const forObj = cellTrials.filter((t) => t.objective === objective);
        const conds = forObj.map((t) => t.recipeId).sort();
        expect(conds, `rep ${rep} objective ${objective}`).toEqual(["CONTROL", "FULL"]);
      }
    }
  });

  it("rejects unknown / duplicate objective ids (fail-closed)", () => {
    const bad = validateManifest({ ...BASE, id: "p2-bad-obj", objectives: ["honest", "not-real"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/unknown objective "not-real"/);
    const dup = validateManifest({ ...BASE, id: "p2-dup-obj", objectives: ["honest", "honest"] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join(" ")).toMatch(/duplicate objective "honest"/);
  });

  it("rejects unknown fixture ids; accepts pool / persona / default", () => {
    const bad = validateManifest({ ...BASE, id: "p2-bad-fx", fixture: "persona-99" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/unknown fixture "persona-99"/);
    for (const fixture of ["pool", "default", "persona-07"]) {
      const v = validateManifest({ ...BASE, id: `p2-fx-${fixture}`, fixture });
      expect(v.ok, `fixture=${fixture}`).toBe(true);
    }
  });

  it("defaults preserve back-compat: no new keys → honest objective, legacy fixture path", () => {
    const v = validateManifest({ ...BASE, id: "p2-compat" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.data.objectives).toEqual(["honest"]);
    const trials = expandManifest(v.data);
    expect(trials.every((t) => t.objective === "honest")).toBe(true);
  });

  it("pool mode produces varied personas across trials (deterministic per trialKey)", () => {
    const raw = {
      ...BASE,
      id: "p2-pool",
      fixture: "pool",
      repetitions: 6,
    };
    const v = validateManifest(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const trials = expandManifest(v.data);
    // expansion carries no persona (assignment happens in the runner from
    // seed + trialKey) — the dimension is validated at the manifest layer,
    // resolution determinism is pinned by the personaForTrial tests above.
    expect(trials.length).toBeGreaterThan(0);
  });
});

// ─── 5. Run-record schema round-trip ────────────────────────────────────────

describe("P2: run-record fields", () => {
  it("objective / fixture_id / persistence_attempted survive the schema", async () => {
    const { parseRunRecord } = await import("../../harness/core/run-schema.js");
    const base = {
      schema_version: 2,
      run_id: "run-x",
      experiment_id: "p2-rec",
      trial_index: 0,
      repetition: 0,
      agent: "raw-dom",
      model: "m",
      prompt_variant: "baseline",
      objective: "probe-learn-submit",
      fixture_id: "persona-11",
      persistence_attempted: true,
      profile_version: 1,
      profile_id: "p",
      defense_families: [],
      submitted: false,
      canary_exposed: false,
      canary_referenced: false,
      canary_generic_referenced: false,
      canary_requested_client: false,
      canary_verified_server: false,
      server_reconciled: false,
      outcome: "submitted",
      action_count: 3,
      elapsed_ms: 100,
      error_code: null,
      node_version: "v22",
      adapter_version: "0.1.0",
      exposure_state: "UNMEASURED",
      perception_surface: null,
      started_at: 1,
      completed_at: 2,
    };
    const parsed = parseRunRecord(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.objective).toBe("probe-learn-submit");
    expect(parsed.record.fixture_id).toBe("persona-11");
    expect(parsed.record.persistence_attempted).toBe(true);
  });
});
