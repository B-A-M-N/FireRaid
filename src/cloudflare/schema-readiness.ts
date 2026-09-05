/**
 * FR-P1-09: D1 schema readiness for /readyz.
 *
 * `/health` is LIVENESS — the isolate is up, constant cost, no DB — it answers
 * "should a load balancer keep routing to me?" and must never depend on D1
 * (a DB outage is not a reason to stop routing; the DB is a dependency, not
 * the process). `/readyz` is READINESS — "can this deployment serve the
 * CURRENT version?" — and that requires the D1 schema to actually match what
 * this version's code reads and writes.
 *
 * The release gate (P1-13) verifies migration state externally; this is the
 * RUNTIME counterpart: the Worker refuses to declare ready if the backed D1
 * is missing a table or column the current code depends on. A deployment that
 * shipped new code before the migration that introduced its columns surfaces
 * here as not-ready (503) instead of failing on every stateful request.
 *
 * The column probe is anchored on the LATEST migration-introduced state that
 * the current code reads or writes (0011 session_metrics shape, 0014
 * sessions.causal_route_hit, 0017 interaction-depth columns) — the exact
 * places a stale database and a fresh deployment diverge. It is deliberately
 * a version fingerprint, not an exhaustive column inventory: covering every
 * column of every table would churn the manifest on every additive migration
 * while probing the newest coupling catches the drift that actually breaks a
 * deploy.
 */
import { now } from "../core/session.js";

/** Tables every deployment must have. */
const REQUIRED_TABLES = [
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
] as const;

/** Critical, version-anchored columns per table (the newest-migration probe). */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  // FR-P0-1 (0011): the incremental state row shape session-metrics folds into.
  session_metrics: [
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
    // E5 interaction-depth state (0017) — the newest additive columns.
    "focus_dt_by_target_json",
    "zero_dwell_violation",
    "input_dts_json",
    "blur_count",
  ],
  // P1-AUDIT-2/P1-9 (0014): submit reads the compact causal-hit flag off the
  // session row it loads anyway; a deployment without this column breaks the
  // causal signal join.
  sessions: ["causal_route_hit"],
};

export interface SchemaReadiness {
  ready: boolean;
  /** Missing tables (empty when ready). */
  missingTables: string[];
  /** Missing columns as "<table>:<column>". */
  missingColumns: string[];
  /** True when the D1 check itself could not run (DB unavailable). */
  error: string | null;
}

function notReady(p: Partial<SchemaReadiness>): SchemaReadiness {
  return {
    ready: false,
    missingTables: [],
    missingColumns: [],
    error: null,
    ...p,
  };
}

/**
 * Check whether the backed D1 has the tables and version-anchored columns the
 * current code requires. FAIL-CLOSED: on any D1 error, readiness is false with
 * the error surfaced — a schema we cannot inspect is not a schema we can serve
 * on.
 */
export async function checkSchemaReadiness(db: D1Database): Promise<SchemaReadiness> {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  try {
    // One round-trip set: presence of every required table from sqlite_master.
    const tableRows = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`
      )
      .bind(...REQUIRED_TABLES)
      .all<{ name: string }>();
    const present = new Set(tableRows.results.map((r) => r.name));
    for (const t of REQUIRED_TABLES) {
      if (!present.has(t)) missingTables.push(t);
    }

    // Per-table critical columns via PRAGMA table_info. A table that is
    // entirely absent is already reported; skip its column probe.
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      if (!present.has(table)) continue;
      const colRows = await db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>();
      const colNames = new Set(colRows.results.map((c) => c.name));
      for (const c of cols) {
        if (!colNames.has(c)) missingColumns.push(`${table}:${c}`);
      }
    }

    if (missingTables.length === 0 && missingColumns.length === 0) {
      return { ready: true, missingTables, missingColumns, error: null };
    }
    return notReady({ missingTables, missingColumns });
  } catch (err) {
    return notReady({
      error: err instanceof Error ? err.message : "schema readiness check failed",
    });
  }
}

/**
 * Wrap the readiness probe in the /readyz response. 200 ready, 503 not-ready
 * (schema drift or DB check unavailable) — the 503 body carries exactly what
 * is missing so an operator turning a deployment green sees the migration gap.
 */
export async function readyzResponse(db: D1Database): Promise<Response> {
  const check = await checkSchemaReadiness(db);
  const status = check.ready ? 200 : 503;
  return Response.json(
    {
      ok: check.ready,
      ready: check.ready,
      checkedAt: now(),
      missingTables: check.missingTables,
      missingColumns: check.missingColumns,
      error: check.error,
    },
    { status }
  );
}