/**
 * Validation tests for experiment manifests and fixtures.
 * FR-R5-010: every manifest.json must validate against ExperimentManifestSchema.
 * FR-R5-011: every fixture referenced by a manifest must exist as a per-file JSON.
 * FR-R5-010: agent × extractor combos must respect ADAPTER_CAPABILITIES.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateManifest, ADAPTER_CAPABILITIES } from "../../harness/core/run-schema.js";

// ---------- helpers ----------

/** Returns absolute paths of all *.json files in harness/experiments/. */
function getManifestPaths(): string[] {
  const dir = join(process.cwd(), "harness", "experiments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

/** Load and parse a JSON file; throws on parse error. */
function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Resolve fixture path from manifest and check it exists + is an object with name+email. */
function checkFixture(fixtureName: string): string[] {
  const errors: string[] = [];
  const fixturePath = join(process.cwd(), "harness", "fixtures", `${fixtureName}.json`);
  if (!existsSync(fixturePath)) {
    errors.push(`fixture file not found: ${fixturePath}`);
    return errors;
  }
  const parsed = loadJson(fixturePath);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    errors.push(`fixture ${fixtureName} is not a plain object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`);
    return errors;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    errors.push(`fixture ${fixtureName} missing string "name"`);
  }
  if (typeof obj.email !== "string" || obj.email.length === 0) {
    errors.push(`fixture ${fixtureName} missing string "email"`);
  }
  return errors;
}

/** Check agent × extractor combos. Returns errors. */
function checkExtractorCompatibility(
  agents: string[],
  extractors: string[] | undefined
): string[] {
  const errors: string[] = [];
  if (!extractors || extractors.length === 0) return errors;
  for (const agent of agents) {
    const caps = ADAPTER_CAPABILITIES[agent as keyof typeof ADAPTER_CAPABILITIES];
    if (!caps) {
      errors.push(`unknown agent "${agent}" in ADAPTER_CAPABILITIES`);
      continue;
    }
    // Empty supportedExtractors = extractor-agnostic; skip
    if (caps.supportedExtractors.length === 0) continue;
    for (const extractor of extractors) {
      if (!caps.supportedExtractors.includes(extractor as never)) {
        errors.push(`agent "${agent}" does not support extractor "${extractor}"`);
      }
    }
  }
  return errors;
}

// ---------- tests ----------

describe("manifests", () => {
  const paths = getManifestPaths();

  it("has at least one manifest file", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  for (const path of paths) {
    const name = path.replace(/^.*\/experiments\//, "");

    describe(name, () => {
      const raw = loadJson(path);

      it("parses as valid JSON", () => {
        expect(typeof raw).toBe("object");
      });

      it("validates against ExperimentManifestSchema", () => {
        const validation = validateManifest(raw);
        if (!validation.ok) {
          // Print errors for debugging when it fails
          console.error("Validation errors:", validation.errors);
        }
        expect(validation.ok).toBe(true);
      });

      // recipe_id is NOT part of the current schema (parallel edit pending).
      // safeParse strips unknown keys by default, so manifests that include
      // recipe_id would pass. If the schema rejects it, we skip this check —
      // the manifest team owns that field.

      const data = validateManifest(raw);
      if (data.ok) {
        it(`fixture "${data.data.fixture}" exists as a per-file object with name+email`, () => {
          const fixtureErrors = checkFixture(data.data.fixture);
          expect(fixtureErrors, `fixture errors: ${fixtureErrors.join("; ")}`).toEqual([]);
        });

        it(`agent × extractor combos are valid`, () => {
          const extractorErrors = checkExtractorCompatibility(
            data.data.agents,
            data.data.extractors
          );
          expect(extractorErrors, `extractor errors: ${extractorErrors.join("; ")}`).toEqual([]);
        });
      }
    });
  }
});

describe("manifests summary", () => {
  const paths = getManifestPaths();

  it("all manifests parsed and validated", () => {
    const failures: string[] = [];
    for (const path of paths) {
      const name = path.replace(/^.*\/experiments\//, "");
      try {
        const raw = loadJson(path);
        const result = validateManifest(raw);
        if (!result.ok) {
          failures.push(`${name}: ${(result as { ok: false; errors: string[] }).errors.join("; ")}`);
        }
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : "parse error"}`);
      }
    }
    if (failures.length > 0) {
      console.error("Manifest validation failures:");
      for (const f of failures) console.error(`  - ${f}`);
    }
    expect(failures.length, `${failures.length} manifest(s) failed validation`).toBe(0);
  });
});
