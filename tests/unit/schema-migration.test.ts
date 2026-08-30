/**
 * Schema migration test — FR-R4-056 + FR-R7-006.
 *
 * Part 1: migration chain executes against a fresh local SQLite database.
 * Part 2: RunRecord v1 → v2 normalizer and universal parser tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeV1ToV2,
  parseRunRecord,
  type RunRecordV1,
} from "../../harness/core/run-schema.js";

// ===========================================================================
// Part 1 — SQLite migration execution (unchanged from original file)
// ===========================================================================

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: DatabaseSync): void {
  for (const file of listMigrations()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.exec(sql);
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("FR-R4-056: migrations execute against a fresh SQLite database", () => {
  it("migration numbering is unique and contiguous", () => {
    const files = listMigrations();
    expect(files.length).toBeGreaterThan(0);
    const numbers = files.map((f) => Number.parseInt(f.split("_")[0], 10));
    const unique = new Set(numbers);
    expect(unique.size).toBe(numbers.length);
    for (let i = 0; i < numbers.length; i++) {
      expect(numbers[i]).toBe(i + 1);
    }
  });

  it("full chain executes without SQL errors on an empty database", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => applyMigrations(db)).not.toThrow();
  });

  it("executed schema matches what src/ queries expect", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    const sessions = tableColumns(db, "sessions");
    for (const col of ["id", "created_at", "last_seen_at", "profile_version", "profile_id", "profile_hash", "experiment_id", "submitted", "final_score", "final_disposition"]) {
      expect(sessions).toContain(col);
    }

    const submissions = tableColumns(db, "submissions");
    for (const col of ["id", "session_id", "created_at", "turnstile_ok", "causal_hits", "strong_hits", "weak_hits", "risk_score", "disposition", "policy", "reasons_json", "public_id"]) {
      expect(submissions).toContain(col);
    }

    const evidence = tableColumns(db, "submission_evidence");
    for (const col of ["submission_id", "evidence_class", "source", "weight", "verified", "metadata_json"]) {
      expect(evidence).toContain(col);
    }
    const attempts = tableColumns(db, "verification_attempts");
    for (const col of ["session_id", "provider", "result", "error_codes_json"]) {
      expect(attempts).toContain(col);
    }

    const labRuns = tableColumns(db, "lab_runs");
    for (const col of ["id", "bind_token_hash", "session_id", "recipe_json", "turnstile_required", "status", "created_at", "reconciled_at"]) {
      expect(labRuns).toContain(col);
    }

    const harnessRuns = tableColumns(db, "harness_runs");
    for (const col of ["run_id", "disposition", "recipe_id", "canary_verified", "server_reconciled", "profile_variant_id"]) {
      expect(harnessRuns).toContain(col);
    }
  });

  it("enforces exactly one final submission per session", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    db.exec(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES ('s1', 1, 1, 1, 'p', 'h', 0)`
    );
    const insert = db.prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition)
       VALUES ('s1', 1, 1, 0, 0, 0, 0, 'ACCEPT')`
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
  });

  it("enforces at most one verified canary hit per session/family/token (FR-R4-004)", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    expect(indexNames(db, "canary_hits")).toContain("idx_canary_unique_verified");

    db.exec(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES ('s2', 1, 1, 1, 'p', 'h', 0)`
    );
    const hit = db.prepare(
      `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES ('s2', 1, 'decoy-route', 'A', 'hash-x', 'hash-x', 1)`
    );
    hit.run();
    expect(() => hit.run()).toThrow(/UNIQUE/);
    const ignored = db.prepare(
      `INSERT OR IGNORE INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES ('s2', 2, 'decoy-route', 'A', 'hash-x', 'hash-x', 1)`
    ).run();
    expect(ignored.changes).toBe(0);
    const other = db.prepare(
      `INSERT INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES ('s2', 3, 'decoy-route', 'A', 'hash-y', 'hash-y', 1)`
    ).run();
    expect(other.changes).toBe(1);
  });

  it("submissions.public_id is unique when used (FR-R4-008)", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    db.exec(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES ('s3', 1, 1, 1, 'p', 'h', 0),
              ('s4', 1, 1, 1, 'p', 'h', 0)`
    );
    const insert = db.prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, public_id)
       VALUES (?, 1, 1, 0, 0, 0, 0, 'ACCEPT', ?)`
    );
    insert.run("s3", "u-1");
    expect(() => insert.run("s4", "u-1")).toThrow(/UNIQUE/);
    expect(insert.run("s4", "u-2").changes).toBe(1);
  });

  it("migration 0001 is the released v0.1 form (no profile_key_id — FR-R6-044)", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "0001_initial.sql"), "utf-8");
    expect(sql).not.toContain("profile_key_id");
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    expect(tableColumns(db, "sessions")).toContain("profile_key_id");
  });

  it("upgrade path: v0.1 schema (0001 only) → later migrations → current (FR-R6-083)", () => {
    const files = listMigrations();
    const later = files.filter((f) => !f.startsWith("0001_"));

    const upgraded = new DatabaseSync(":memory:");
    const v1 = readFileSync(join(MIGRATIONS_DIR, "0001_initial.sql"), "utf-8");
    upgraded.exec(v1);
    for (const f of later) {
      upgraded.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
    }

    const fresh = new DatabaseSync(":memory:");
    applyMigrations(fresh);

    const freshTables = fresh
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r) => String((r as { name: string }).name));
    for (const table of freshTables) {
      expect(tableColumns(upgraded, table).sort()).toEqual(tableColumns(fresh, table).sort());
    }
    expect(tableColumns(upgraded, "sessions")).toContain("profile_key_id");
    expect(tableColumns(upgraded, "sessions")).toContain("last_event_seq");
  });

  it("upgrade path: pre-lifecycle schema (0001–0004) → 0005+ → current (FR-R6-083)", () => {
    const files = listMigrations();
    const prefix = files.filter((f) => f.startsWith("000") && f < "0005_");
    const rest = files.filter((f) => !prefix.includes(f));

    const upgraded = new DatabaseSync(":memory:");
    for (const f of prefix) {
      upgraded.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
    }
    for (const f of rest) {
      upgraded.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
    }

    const fresh = new DatabaseSync(":memory:");
    applyMigrations(fresh);
    for (const col of ["experiment_id", "trial_key", "recipe_id", "outcome", "expires_at", "terminal_reason"]) {
      expect(tableColumns(upgraded, "lab_runs")).toContain(col);
    }
    expect(tableColumns(upgraded, "lab_runs").sort()).toEqual(tableColumns(fresh, "lab_runs").sort());
  });
});

// ===========================================================================
// Supplemental parser assertions (retained from the original file)
// ===========================================================================

function parseSchemaColumns(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = createTableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const columns = new Set<string>();
    for (const line of match[2].split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("CREATE") || trimmed.startsWith("PRIMARY") || trimmed.startsWith("FOREIGN") || trimmed.startsWith("UNIQUE") || trimmed.startsWith("CHECK") || trimmed === "" || trimmed.startsWith(")")) continue;
      const colMatch = trimmed.match(/^(\w+)\s+/);
      if (colMatch) columns.add(colMatch[1]);
    }
    tables.set(tableName, columns);
  }
  const alterTableRegex = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+/gi;
  while ((match = alterTableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const columnName = match[2];
    if (!tables.has(tableName)) tables.set(tableName, new Set());
    tables.get(tableName)!.add(columnName);
  }
  return tables;
}

describe("FR-R3-060: supplemental schema text assertions", () => {
  it("migration files declare the expected columns", () => {
    const allColumns = new Map<string, Set<string>>();
    for (const file of listMigrations()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      for (const [table, columns] of parseSchemaColumns(sql)) {
        if (!allColumns.has(table)) allColumns.set(table, new Set());
        for (const col of columns) allColumns.get(table)!.add(col);
      }
    }

    const submissions = allColumns.get("submissions");
    expect(submissions).toBeDefined();
    for (const col of ["session_id", "policy", "reasons_json"]) {
      expect(submissions!.has(col)).toBe(true);
    }
    const sessions = allColumns.get("sessions");
    expect(sessions).toBeDefined();
    for (const col of ["id", "submitted", "final_score", "final_disposition"]) {
      expect(sessions!.has(col)).toBe(true);
    }
  });
});

// ===========================================================================
// Part 2 — RunRecord v1 → v2 normalizer and parseRunRecord
// ===========================================================================

describe("RunRecord v1 → v2 schema migration", () => {
  // Helper to build a minimal v1 record
  function makeV1(patch: Partial<{
    agent: RunRecordV1["agent"];
    canary_exposed: boolean;
    extractor?: RunRecordV1["extractor"];
    node_version?: string;
    adapter_version?: string;
    outcome?: RunRecordV1["outcome"];
    action_count?: number;
    elapsed_ms?: number;
  }> = {}): RunRecordV1 {
    return {
      schema_version: 1,
      run_id: "test-run-001",
      experiment_id: "test-exp",
      trial_index: 0,
      repetition: 0,
      agent: patch.agent ?? "raw-dom",
      model: "gpt-4",
      prompt_variant: "v1",
      extractor: patch.extractor,
      profile_version: 1,
      profile_id: "p1",
      defense_families: ["modesty"],
      submitted: true,
      canary_exposed: patch.canary_exposed ?? false,
      canary_referenced: false,
      canary_generic_referenced: false,
      canary_requested_client: false,
      canary_verified_server: false,
      server_reconciled: false,
      node_version: patch.node_version ?? "20.0.0",
      adapter_version: patch.adapter_version ?? "0.1.0",
      outcome: patch.outcome ?? "submitted",
      action_count: patch.action_count ?? 0,
      elapsed_ms: patch.elapsed_ms ?? 100,
      started_at: 1700000000,
      completed_at: 1700000100,
    };
  }

  // -----------------------------------------------------------------------
  // v2-shaped records parse cleanly
  // -----------------------------------------------------------------------

  it("a v2-shaped record parses via parseRunRecord and keeps exposure_state + perception_surface", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "EXPOSED",
      perception_surface: "transport-html",
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schema_version).toBe(2);
      expect(result.record.exposure_state).toBe("EXPOSED");
      expect(result.record.perception_surface).toBe("transport-html");
      // canary_exposed passes through from v1
      expect(result.record.canary_exposed).toBe(false);
    }
  });

  it("v2 with all perception_surface values is accepted", () => {
    const surfaces = [
      "human-visual",
      "transport-html",
      "raw-html-model-input",
      "simplified-dom-model-input",
      "accessibility-model-input",
      "browser-use-observation",
    ] as const;
    for (const surface of surfaces) {
      const raw: Record<string, unknown> = {
        ...makeV1(),
        schema_version: 2,
        exposure_state: "EXPOSED",
        perception_surface: surface,
      };
      const result = parseRunRecord(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.perception_surface).toBe(surface);
      }
    }
  });

  it("v2 with exposure_state UNMEASURED and null perception_surface", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "UNMEASURED",
      perception_surface: null,
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.exposure_state).toBe("UNMEASURED");
      expect(result.record.perception_surface).toBeNull();
    }
  });

  it("v2 with NOT_EXPOSED state", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "NOT_EXPOSED",
      perception_surface: "human-visual",
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.exposure_state).toBe("NOT_EXPOSED");
    }
  });

  // -----------------------------------------------------------------------
  // v1 → v2 normalizer — specific agent mappings
  // -----------------------------------------------------------------------

  it("human + canary_exposed false → UNMEASURED/null", () => {
    const v1 = makeV1({ agent: "human", canary_exposed: false });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("UNMEASURED");
    expect(result.perception_surface).toBeNull();
  });

  it("human + canary_exposed true → still UNMEASURED/null (boolean was never a measurement)", () => {
    const v1 = makeV1({ agent: "human", canary_exposed: true });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("UNMEASURED");
    expect(result.perception_surface).toBeNull();
  });

  it("raw-http + canary_exposed true → EXPOSED/transport-html", () => {
    const v1 = makeV1({ agent: "raw-http", canary_exposed: true });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("EXPOSED");
    expect(result.perception_surface).toBe("transport-html");
  });

  it("raw-http + canary_exposed false → NOT_EXPOSED/transport-html", () => {
    const v1 = makeV1({ agent: "raw-http", canary_exposed: false });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("NOT_EXPOSED");
    expect(result.perception_surface).toBe("transport-html");
  });

  // -----------------------------------------------------------------------
  // v1 → v2 — other agents (raw-dom, ax-snapshot, browser-use)
  // -----------------------------------------------------------------------

  it("raw-dom + true + extractor 'simplified-dom' → EXPOSED/simplified-dom-model-input", () => {
    const v1 = makeV1({ agent: "raw-dom", canary_exposed: true, extractor: "simplified-dom" });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("EXPOSED");
    expect(result.perception_surface).toBe("simplified-dom-model-input");
  });

  it("raw-dom + false → UNMEASURED/null (v1 cannot distinguish artifact-negative from artifact-absent)", () => {
    const v1 = makeV1({ agent: "raw-dom", canary_exposed: false });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("UNMEASURED");
    expect(result.perception_surface).toBeNull();
  });

  it("ax-snapshot + true + extractor 'accessibility' → EXPOSED/accessibility-model-input", () => {
    const v1 = makeV1({ agent: "ax-snapshot", canary_exposed: true, extractor: "accessibility" });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("EXPOSED");
    expect(result.perception_surface).toBe("accessibility-model-input");
  });

  it("browser-use + true (no extractor) → EXPOSED/raw-html-model-input (unknown extractor default)", () => {
    const v1 = makeV1({ agent: "browser-use", canary_exposed: true });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("EXPOSED");
    expect(result.perception_surface).toBe("raw-html-model-input");
  });

  it("raw-dom + true + unknown extractor → EXPOSED/raw-html-model-input (default)", () => {
    const v1 = makeV1({ agent: "raw-dom", canary_exposed: true, extractor: "raw-html" });
    const result = normalizeV1ToV2(v1);
    expect(result.schema_version).toBe(2);
    expect(result.exposure_state).toBe("EXPOSED");
    expect(result.perception_surface).toBe("raw-html-model-input");
  });

  // -----------------------------------------------------------------------
  // v1 → v2 — all v1 fields pass through
  // -----------------------------------------------------------------------

  it("all v1 fields pass through to v2", () => {
    const v1 = makeV1({ agent: "raw-http", canary_exposed: true });
    v1.run_id = "unique-run-id";
    v1.experiment_id = "my-exp";
    const result = normalizeV1ToV2(v1);
    expect(result.run_id).toBe("unique-run-id");
    expect(result.experiment_id).toBe("my-exp");
    expect(result.agent).toBe("raw-http");
    expect(result.canary_exposed).toBe(true);
    expect(result.canary_referenced).toBe(false);
    expect(result.node_version).toBe("20.0.0");
  });

  // -----------------------------------------------------------------------
  // parseRunRecord — v1 fallback
  // -----------------------------------------------------------------------

  it("a v1-shaped record normalizes via parseRunRecord", () => {
    const v1 = makeV1({ agent: "human", canary_exposed: false });
    const result = parseRunRecord(v1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schema_version).toBe(2);
      expect(result.record.exposure_state).toBe("UNMEASURED");
      expect(result.record.perception_surface).toBeNull();
    }
  });

  it("a v2-shaped record passes through parseRunRecord without v1 normalization", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "EXPOSED",
      perception_surface: "human-visual",
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schema_version).toBe(2);
      expect(result.record.exposure_state).toBe("EXPOSED");
    }
  });

  // -----------------------------------------------------------------------
  // parseRunRecord — garbage input
  // -----------------------------------------------------------------------

  it("garbage input → ok:false with merged error lists", () => {
    const result = parseRunRecord("not-a-record");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      // Should have both v1 and v2 prefixes since both parsers fail
      const hasV1Prefix = result.errors.some((e) => e.startsWith("v1:"));
      const hasV2Prefix = result.errors.some((e) => e.startsWith("v2:"));
      expect(hasV1Prefix).toBe(true);
      expect(hasV2Prefix).toBe(true);
    }
  });

  it("null input → ok:false", () => {
    const result = parseRunRecord(null);
    expect(result.ok).toBe(false);
  });

  it("empty object → ok:false", () => {
    const result = parseRunRecord({});
    expect(result.ok).toBe(false);
  });

  // -----------------------------------------------------------------------
  // v2 schema accepts control_variant and provenance fields
  // -----------------------------------------------------------------------

  it("v2 with control_variant and provenance fields", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "EXPOSED",
      perception_surface: "browser-use-observation",
      control_variant: "keyboard",
      llm_provider_origin: "openai",
      llm_model_requested: "gpt-4",
      llm_model_served: "gpt-4-turbo",
      python_version: "3.12.0",
      browser_use_version: "0.5.0",
      browser_engine: "chromium",
      browser_engine_version: "120.0.0",
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.control_variant).toBe("keyboard");
      expect(result.record.llm_provider_origin).toBe("openai");
      expect(result.record.llm_model_requested).toBe("gpt-4");
      expect(result.record.llm_model_served).toBe("gpt-4-turbo");
      expect(result.record.python_version).toBe("3.12.0");
      expect(result.record.browser_use_version).toBe("0.5.0");
      expect(result.record.browser_engine).toBe("chromium");
      expect(result.record.browser_engine_version).toBe("120.0.0");
    }
  });

  it("v2 with nullish control_variant is accepted", () => {
    const raw: Record<string, unknown> = {
      ...makeV1(),
      schema_version: 2,
      exposure_state: "EXPOSED",
      perception_surface: "transport-html",
    };
    const result = parseRunRecord(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.control_variant).toBeUndefined();
    }
  });
});
