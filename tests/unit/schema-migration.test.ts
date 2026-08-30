/**
 * Schema migration test — FR-R4-056.
 * Actually EXECUTES the migration chain against a fresh local SQLite database
 * (via node:sqlite, SQLite-compatible with D1) instead of merely parsing SQL
 * text. The duplicate-0002 incident (two migrations both ADD COLUMN
 * submissions.policy) is only catchable by executing the chain in order.
 *
 * The parser-only assertions remain as a supplemental schema check.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply the full migration chain, in lexical order, to a fresh DB. */
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
    // FR-R4-002: two files claiming the same number made the chain ambiguous
    expect(unique.size).toBe(numbers.length);
    for (let i = 0; i < numbers.length; i++) {
      expect(numbers[i]).toBe(i + 1);
    }
  });

  it("full chain executes without SQL errors on an empty database", () => {
    const db = new DatabaseSync(":memory:");
    // ALTER TABLE ADD COLUMN is intentionally not idempotent: D1 migration
    // tooling applies each file exactly once (tracked by filename), so the
    // correctness bar is "the chain applies cleanly, in order, once".
    expect(() => applyMigrations(db)).not.toThrow();
  });

  it("executed schema matches what src/ queries expect", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    // sessions — as queried by session.ts / submit.ts
    const sessions = tableColumns(db, "sessions");
    for (const col of ["id", "created_at", "last_seen_at", "profile_version", "profile_id", "profile_hash", "experiment_id", "submitted", "final_score", "final_disposition"]) {
      expect(sessions).toContain(col);
    }

    // submissions — as inserted by submit.ts (incl. policy/reasons_json/public_id)
    const submissions = tableColumns(db, "submissions");
    for (const col of ["id", "session_id", "created_at", "turnstile_ok", "causal_hits", "strong_hits", "weak_hits", "risk_score", "disposition", "policy", "reasons_json", "public_id"]) {
      expect(submissions).toContain(col);
    }

    // submission_evidence + verification_attempts — from 0002
    const evidence = tableColumns(db, "submission_evidence");
    for (const col of ["submission_id", "evidence_class", "source", "weight", "verified", "metadata_json"]) {
      expect(evidence).toContain(col);
    }
    const attempts = tableColumns(db, "verification_attempts");
    for (const col of ["session_id", "provider", "result", "error_codes_json"]) {
      expect(attempts).toContain(col);
    }

    // lab_runs — from 0004 (FR-R4-029)
    const labRuns = tableColumns(db, "lab_runs");
    for (const col of ["id", "bind_token_hash", "session_id", "recipe_json", "turnstile_required", "status", "created_at", "reconciled_at"]) {
      expect(labRuns).toContain(col);
    }

    // harness_runs — aligned with RunRecordV1 (FR-R4-069)
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
    // FR-R4-009: the unique index must reject a second finalization
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
    // Duplicate verified hit must be rejected by the storage layer
    expect(() => hit.run()).toThrow(/UNIQUE/);
    // INSERT OR IGNORE (the strategy canary.ts uses) must be a no-op, not an error
    const ignored = db.prepare(
      `INSERT OR IGNORE INTO canary_hits (session_id, created_at, family, evidence_class, expected_hash, observed_hash, verified)
       VALUES ('s2', 2, 'decoy-route', 'A', 'hash-x', 'hash-x', 1)`
    ).run();
    expect(ignored.changes).toBe(0);
    // A different expected_hash is a different canary and must still be accepted
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
    // Different sessions (session_id itself is UNIQUE on submissions)
    const insert = db.prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, public_id)
       VALUES (?, 1, 1, 0, 0, 0, 0, 'ACCEPT', ?)`
    );
    insert.run("s3", "u-1");
    // Reusing a public_id across sessions must be rejected
    expect(() => insert.run("s4", "u-1")).toThrow(/UNIQUE/);
    expect(insert.run("s4", "u-2").changes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Supplemental parser assertions (retained from the previous smoke test)
// ---------------------------------------------------------------------------

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
