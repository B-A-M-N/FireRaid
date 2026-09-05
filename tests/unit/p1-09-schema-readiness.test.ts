/**
 * FR-P1-09 — /health is liveness (cheap, no DB); /readyz is readiness and
 * FAIL-CLOSED: it returns 503 — never a false green — when the backed D1 is
 * missing a required table, missing a version-anchored column the current
 * code reads/writes, or when the schema check itself cannot run.
 *
 * The deployment failure this prevents: new code shipped before the migration
 * that introduced its columns. Runtime readiness surfaces that as not-ready
 * instead of failing on every stateful request.
 */
import { describe, it, expect } from "vitest";
import { checkSchemaReadiness, readyzResponse } from "../../src/cloudflare/schema-readiness.js";

const ALL_TABLES = [
  "sessions",
  "event_batches",
  "canary_hits",
  "submissions",
  "submission_evidence",
  "verification_attempts",
  "session_metrics",
  "review_queue",
  "review_calibration",
  "lab_runs",
  "experiments",
  "harness_runs",
];

const META_COLS = [
  "focused_targets_json",
  "pointer_count",
  "focus_transitions",
  "key_count",
  "input_without_focus",
  "first_event_dt",
  "submit_dt",
  "last_event_seq",
  "capture_pointer",
  "capture_key",
  "focus_dt_by_target_json",
  "zero_dwell_violation",
  "input_dts_json",
  "blur_count",
];
const SESSIONS_COLS = ["causal_route_hit"];

/**
 * A scriptable D1 fake. Each prepare() drains queries in the order it sees
 * them; the first statement (table presence) is answered from `tables`, and
 * PRAGMA table_info probes from `columnsByTable`. Statements not matched throw
 * so a test cannot silently exercise a path the mock didn't script.
 */
function fakeD1(opts: {
  tables: string[];
  columnsByTable?: Record<string, string[]>;
  throwOn?: string;
}): D1Database {
  const { tables, columnsByTable = {}, throwOn } = opts;
  return {
    prepare(sql: string) {
      if (throwOn && sql.includes(throwOn)) {
        return {
          bind() {
            throw new Error("simulated D1 error");
          },
        } as unknown as D1Database["prepare"];
      }
      if (sql.startsWith("SELECT name FROM sqlite_master")) {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: tables.map((name) => ({ name })) };
          },
        } as unknown as D1Database["prepare"];
      }
      if (sql.startsWith("PRAGMA table_info")) {
        const m = sql.match(/PRAGMA table_info\((\w+)\)/);
        const table = m?.[1] ?? "";
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: (columnsByTable[table] ?? []).map((name) => ({ name })) };
          },
        } as unknown as D1Database["prepare"];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as D1Database;
}

describe("FR-P1-09: schema readiness", () => {
  it("ready when every required table and version-anchored column is present", async () => {
    const db = fakeD1({
      tables: ALL_TABLES,
      columnsByTable: { session_metrics: META_COLS, sessions: SESSIONS_COLS },
    });
    const check = await checkSchemaReadiness(db, true);
    expect(check.ready).toBe(true);
    expect(check.missingTables).toEqual([]);
    expect(check.missingColumns).toEqual([]);
    expect(check.error).toBeNull();
  });

  it("not ready when a required table is absent (stale migration); /readyz is 503", async () => {
    const missing = ALL_TABLES.filter((t) => t !== "harness_runs");
    const db = fakeD1({ tables: missing });
    const check = await checkSchemaReadiness(db, true);
    expect(check.ready).toBe(false);
    expect(check.missingTables).toContain("harness_runs");
    const resp = await readyzResponse(db as unknown as D1Database, true);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("not ready when the NEWEST 0017 interaction-depth column is missing", async () => {
    // The E5 interaction-depth state columns are the newest additive schema;
    // a deployment whose migration stopped one short of 0017 is not ready to
    // serve this version. Lose one column from the 0017 set only.
    const shallow = META_COLS.filter((c) => c !== "blur_count");
    const db = fakeD1({
      tables: ALL_TABLES,
      columnsByTable: { session_metrics: shallow, sessions: SESSIONS_COLS },
    });
    const check = await checkSchemaReadiness(db, true);
    expect(check.ready).toBe(false);
    expect(check.missingColumns).toContain("session_metrics:blur_count");
    expect(check.missingTables).toEqual([]);
  });

  it("not ready when 0014 sessions.causal_route_hit is missing", async () => {
    const db = fakeD1({ tables: ALL_TABLES, columnsByTable: { session_metrics: META_COLS, sessions: [] } });
    const check = await checkSchemaReadiness(db, true);
    expect(check.ready).toBe(false);
    expect(check.missingColumns).toContain("sessions:causal_route_hit");
  });

  it("fail-closed: a D1 error the check cannot run surfaces as not-ready + error", async () => {
    const db = fakeD1({
      tables: ALL_TABLES,
      columnsByTable: { session_metrics: META_COLS, sessions: SESSIONS_COLS },
      throwOn: "sqlite_master",
    });
    const check = await checkSchemaReadiness(db, true);
    expect(check.ready).toBe(false);
    expect(check.error).toMatch(/simulated D1 error/);
    const resp = await readyzResponse(db as unknown as D1Database, true);
    expect(resp.status).toBe(503);
  });
});
// ── Closure 8 (FR-P1-09): plane-specific schema + opaque external body ───

describe("closure 8: product/lab plane split + opaque readyz body", () => {
  it("PRODUCTION readiness does NOT require the evaluation control-plane tables", async () => {
    // A production D1 with ONLY the product tables is READY — lab_runs /
    // experiments / harness_runs / review_* belong to the lab plane.
    const productOnly = [
      "sessions",
      "event_batches",
      "canary_hits",
      "submissions",
      "submission_evidence",
      "verification_attempts",
      "session_metrics",
    ];
    const db = fakeD1({
      tables: productOnly,
      columnsByTable: { session_metrics: META_COLS, sessions: SESSIONS_COLS },
    });
    const check = await checkSchemaReadiness(db, false);
    expect(check.ready).toBe(true);
    expect(check.missingTables).toEqual([]);
  });

  it("PRODUCTION readiness still fails on a missing PRODUCT table", async () => {
    const noMetrics = ALL_TABLES.filter((t) => t !== "session_metrics");
    const db = fakeD1({ tables: noMetrics });
    const check = await checkSchemaReadiness(db, false);
    expect(check.ready).toBe(false);
    expect(check.missingTables).toEqual(["session_metrics"]);
  });

  it("the EXTERNAL /readyz body is OPAQUE: only {ok, ready} — never the schema manifest", async () => {
    // The probe is unauthenticated; the prior body enumerated missing
    // tables/columns and the raw D1 error to any anonymous caller.
    const missing = ALL_TABLES.filter((t) => t !== "harness_runs");
    const db = fakeD1({ tables: missing });
    const resp = await readyzResponse(db as unknown as D1Database, true);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "ready"]);
    expect(body.ready).toBe(false);
  });

  it("the READY body is likewise exactly {ok, ready}", async () => {
    const db = fakeD1({
      tables: ALL_TABLES,
      columnsByTable: { session_metrics: META_COLS, sessions: SESSIONS_COLS },
    });
    const resp = await readyzResponse(db as unknown as D1Database, true);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "ready"]);
    expect(body.ready).toBe(true);
  });
});
