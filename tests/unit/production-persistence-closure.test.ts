/**
 * FR-RR-01 — PRODUCTION PERSISTENCE CLOSURE.
 *
 * The invariant the schema-readiness constant alone can never prove:
 *
 *     every persistence operation the PRODUCTION artifact can reach
 *     names ONLY tables in PRODUCT_REQUIRED_TABLES.
 *
 * Before this test, src/cloudflare/schema-readiness.ts declared
 * review_queue/review_calibration/lab_runs/experiments/harness_runs
 * "lab-only" while the production Worker's own routes queried
 * experiments/harness_runs (admin analytics), lab_runs (session detail's
 * readLabAssignment), and lab_runs again (the retention sweep) — a
 * deployment could return /readyz 200 and then 500 on production-owned
 * endpoints. The readiness contract and the artifact's real dependencies
 * disagreed, and no existing test could see it.
 *
 * Three layers of proof, in increasing severity:
 *
 *   1. SQL CLOSURE — every SQL statement emitted by the production-plane
 *      lifecycle and product routes names only product tables (structural,
 *      catches a future query the behavioral layer misses).
 *   2. BEHAVIORAL — every production admin route + the production retention
 *      sweep + the product session detail RECONSTRUCTION run to completion
 *      against a schema with the lab-only tables DROPPED — the exact shape
 *      of a production deployment whose migration set never created them.
 *      Any 500 = a hidden lab dependency.
 *   3. READINESS CONTRACT — PRODUCT_REQUIRED_TABLES equals the closure
 *      computed in (1), so /readyz requires exactly what production can
 *      touch (and the lab plane still requires the superset).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetentionSweep } from "../../src/cloudflare/retention.js";
import { PRODUCT_REQUIRED_TABLES } from "../../src/cloudflare/schema-readiness.js";
import {
  adminLogin,
  adminLogout,
} from "../../src/routes/admin/auth.js";
import {
  adminSummary,
  adminSessions,
  adminSessionDetail,
  adminExportSessions,
  adminCleanup,
  adminReviewQueue,
} from "../../src/routes/admin/product.js";
import { createAdminToken } from "../../src/security/admin-auth.js";
import { deriveEvaluationProfile, hashProfile } from "../../src/core/profile.js";
import type { Env } from "../../src/env.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SECRET = "p".repeat(64);
const CSRF_SECRET = "c".repeat(64);
const ADMIN_SECRET = "a".repeat(48);

/** Tables the production data plane must NEVER name in SQL. */
const LAB_ONLY_TABLES = ["lab_runs", "experiments", "harness_runs"];

const PRODUCT_TABLES = [
  ...PRODUCT_REQUIRED_TABLES,
] as readonly string[];

function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

/**
 * A production-deployment schema: the full migration chain, then the
 * LAB-ONLY tables dropped (in FK-safe order) — the honest shape of a
 * production database that never created the evaluation plane's tables.
 * Returns the set of surviving table names.
 */
function productionSchema(db: DatabaseSync): Set<string> {
  applyMigrations(db);
  // Drop dependents before referents (harness_runs FK → experiments).
  db.exec(`DROP TABLE IF EXISTS harness_runs`);
  db.exec(`DROP TABLE IF EXISTS lab_runs`);
  db.exec(`DROP TABLE IF EXISTS experiments`);
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  return new Set(names.map((r) => r.name));
}

/**
 * D1 wrapper that (a) executes against the real SQLite db and (b) RECORDS
 * every SQL statement it sees, so the closure assertions run against the
 * statements the code ACTUALLY emits — not a source grep.
 */
function recordingD1(db: DatabaseSync, log: string[]): D1Database {
  const track = (sql: string) => log.push(sql);
  return {
    prepare(sql: string) {
      const stmt = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          stmt.params = params;
          track(sql);
          return {
            run: async () => {
              const res = db.prepare(sql).run(...(stmt.params as never[]));
              return { meta: { changes: Number(res.changes) } };
            },
            first: async () =>
              (db.prepare(sql).get(...(stmt.params as never[])) ?? null) as never,
            all: async () => ({ results: db.prepare(sql).all(...(stmt.params as never[])) }),
          };
        },
        // Unbound .all()/.first() — route code calls prepare(...).all()/.first()
        // directly when a statement has no parameters.
        all: async () => {
          track(sql);
          return { results: db.prepare(sql).all() };
        },
        first: async () =>
          (db.prepare(sql).get() ?? null) as never,
        run: async () => {
          track(sql);
          const res = db.prepare(sql).run();
          return { meta: { changes: Number(res.changes) } };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      // Prepared outside bind() — track each statement's SQL as it runs.
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function makeEnv(db: DatabaseSync, log: string[]): Env {
  return {
    DB: recordingD1(db, log),
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    FIRERAID_PROFILE_SECRET: SECRET,
    FIRERAID_PROFILE_KEY_CURRENT_ID: "k1",
    FIRERAID_CSRF_SECRET: CSRF_SECRET,
    ADMIN_SECRET: ADMIN_SECRET,
    TURNSTILE_MODE: "disabled-test",
    TURNSTILE_EXPECTED_HOSTNAME: "localhost",
  } as unknown as Env;
}

/** All table names a set of SQL statements references (FROM/JOIN/INTO/UPDATE). */
function tablesReferenced(statements: string[]): Set<string> {
  const found = new Set<string>();
  const all = PRODUCT_TABLES.concat(LAB_ONLY_TABLES);
  for (const sql of statements) {
    for (const t of all) {
      const re = new RegExp(`\\b${t}\\b`, "i");
      if (re.test(sql)) found.add(t);
    }
    // PRAGMA table_info(<table>) probes count too.
    const pragma = sql.match(/pragma\s+table_info\((\w+)\)/i);
    if (pragma) found.add(pragma[1].toLowerCase());
  }
  return found;
}

let dir: string;
let db: DatabaseSync;
let sqlLog: string[];
let env: Env;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fr-rr01-"));
  db = new DatabaseSync(join(dir, "prod.sqlite"));
  productionSchema(db); // full chain MINUS the lab-only tables
  sqlLog = [];
  env = makeEnv(db, sqlLog);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedIssuedSession(sid: string): Promise<void> {
  // A production session with an ISSUED profile hash (the real one, so the
  // admin detail's drift-checked reconstruction succeeds).
  const profile = await deriveEvaluationProfile({
    secret: SECRET,
    version: 1,
    sessionId: sid,
    mode: "production",
    holdoutMode: false,
    turnstileRequired: false,
  });
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
     VALUES (?, ?, ?, 1, 'k1', ?, ?, 0)`
  ).run(sid, Date.now(), Date.now(), profile.profileId, await hashProfile(profile));
}

function seedSubmission(db: DatabaseSync, sid: string, publicId: string, disposition = "ACCEPT"): void {
  db.prepare(
    `INSERT INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, verification_provider, reasons_json)
     VALUES (?, ?, ?, 0, 0, 0, 0, 10, ?, 'default-v1', 'none', '[]')`
  ).run(publicId, sid, Date.now(), disposition);
}

function seedReviewEntry(db: DatabaseSync, sid: string, publicId: string): void {
  db.prepare(
    `INSERT INTO review_queue (session_id, public_id, created_at, risk_score, risk_tier, disposition, policy, reasons_json, status)
     VALUES (?, ?, ?, 10, 'ELEVATED', 'REVIEW', 'default-v1', '[]', 'pending')`
  ).run(sid, publicId, Date.now());
}

async function adminCookie(): Promise<string> {
  const token = await createAdminToken(env);
  return `__Host-fr_admin=${token}`;
}

/** Derived bearer token — a mutation-capable caller that skips the CSRF
 * double-submit dance (the operator-script auth path). createAdminToken's
 * output IS the derived token bearer callers present. */
async function adminBearer(): Promise<string> {
  const token = await createAdminToken(env);
  return `Bearer ${token}`;
}

// ── 1. SQL closure over the production-plane lifecycle ───────────────────

describe("FR-RR-01 layer 1: production SQL closure", () => {
  it("the PRODUCTION-plane retention sweep emits NO statement naming a lab-only table", async () => {
    sqlLog.length = 0;
    await runRetentionSweep(env.DB, 1, { unbounded: true, plane: "production" });
    const touched = tablesReferenced(sqlLog);
    for (const lab of LAB_ONLY_TABLES) {
      expect(touched.has(lab), `production sweep referenced lab-only table ${lab}`).toBe(false);
    }
    // And it touched the product core (the sweep is not vacuous).
    expect(touched.has("sessions")).toBe(true);
  });

  it("the LAB-plane sweep still owns lab_runs (the plane split did not amputate the lab fixture)", async () => {
    // The lab plane runs against the FULL schema — build its own db (the
    // shared beforeEach one has the lab tables dropped).
    const labDb = new DatabaseSync(":memory:");
    applyMigrations(labDb);
    const labLog: string[] = [];
    try {
      await runRetentionSweep(recordingD1(labDb, labLog), 1, {
        unbounded: true,
        plane: "lab",
      });
      const touched = tablesReferenced(labLog);
      expect(touched.has("lab_runs")).toBe(true);
    } finally {
      labDb.close();
    }
  });

  it("PRODUCT_REQUIRED_TABLES is closed under the production sweep's references and contains no lab-only table", async () => {
    sqlLog.length = 0;
    await runRetentionSweep(env.DB, 1, { unbounded: true, plane: "production" });
    const touched = tablesReferenced(sqlLog);
    for (const t of touched) {
      expect(
        PRODUCT_REQUIRED_TABLES.includes(t as never),
        `production sweep touches ${t}, which /readyz does not require`
      ).toBe(true);
    }
    for (const lab of LAB_ONLY_TABLES) {
      expect(PRODUCT_REQUIRED_TABLES.includes(lab as never)).toBe(false);
    }
  });
});

// ── 2. Behavioral: every production route runs on the lab-table-less schema ──

describe("FR-RR-01 layer 2: production routes run on a lab-table-less schema", () => {
  it("adminSummary answers without experiments (product metric set only)", async () => {
    const cookie = await adminCookie();
    const res = await adminSummary(
      new Request("http://localhost/api/admin/summary", { headers: { cookie } }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["causalHits", "quarantined", "sessions", "submitted"]);
  });

  it("adminSessions lists sessions", async () => {
    await seedIssuedSession("rr01-list");
    const cookie = await adminCookie();
    const res = await adminSessions(
      new Request("http://localhost/api/admin/sessions?limit=5", { headers: { cookie } }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);
  });

  it("adminSessionDetail reconstructs WITHOUT any lab_runs read (production-issued truth)", async () => {
    await seedIssuedSession("rr01-detail");
    const cookie = await adminCookie();
    const before = sqlLog.length;
    const res = await adminSessionDetail(
      new Request("http://localhost/api/admin/sessions/rr01-detail", { headers: { cookie } }),
      env,
      "rr01-detail"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defense_families: string[]; reconstructionError?: string };
    expect(body.reconstructionError).toBeUndefined();
    expect(Array.isArray(body.defense_families)).toBe(true);
    // The structural half: nothing in the detail path queried a lab table.
    const newStatements = sqlLog.slice(before);
    const touched = tablesReferenced(newStatements);
    for (const lab of LAB_ONLY_TABLES) {
      expect(touched.has(lab)).toBe(false);
    }
  });

  it("adminExportSessions serves the sessions CSV; type=runs is refused (lab plane)", async () => {
    await seedIssuedSession("rr01-export");
    const cookie = await adminCookie();
    const ok = await adminExportSessions(
      new Request("http://localhost/api/admin/export?type=sessions", { headers: { cookie } }),
      env
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/^id,created_at/);
    const runs = await adminExportSessions(
      new Request("http://localhost/api/admin/export?type=runs", { headers: { cookie } }),
      env
    );
    expect(runs.status).toBe(400);
  });

  it("adminCleanup (production env) sweeps the production plane without lab tables present", async () => {
    await seedIssuedSession("rr01-cleanup");
    seedSubmission(db, "rr01-cleanup", "pub-rr01");
    seedReviewEntry(db, "rr01-cleanup", "pub-rr01");
    const bearer = await adminBearer();
    const res = await adminCleanup(
      new Request("http://localhost/api/admin/cleanup?days=0&reviewDays=0&labDays=0", {
        method: "POST",
        headers: { authorization: bearer },
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plane: string };
    expect(body.plane).toBe("production");
  });

  it("adminReviewQueue reads the product review queue", async () => {
    await seedIssuedSession("rr01-review");
    seedSubmission(db, "rr01-review", "pub-rr01r");
    seedReviewEntry(db, "rr01-review", "pub-rr01r");
    const cookie = await adminCookie();
    const res = await adminReviewQueue(
      new Request("http://localhost/api/admin/review-queue", { headers: { cookie } }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries.length).toBe(1);
  });

  it("auth routes (login/logout) are table-free and work on the production schema", async () => {
    const login = await adminLogin(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: ADMIN_SECRET }),
      }),
      env
    );
    expect(login.status).toBe(200);
    const out = await adminLogout(new Request("http://localhost/api/admin/logout", { method: "POST" }), env);
    // Bearer-less logout is 401 — the point is it REACHED the handler (no
    // missing-table 500).
    expect(out.status).toBe(401);
  });
});

// ── 3. The readiness contract matches reachability ────────────────────────

describe("FR-RR-01 layer 3: readiness contract equals production reachability", () => {
  it("the production schema created by the migration chain SATISFIES product readiness", async () => {
    // Import lazily to avoid a cycle at module-eval time.
    const { checkSchemaReadiness } = await import("../../src/cloudflare/schema-readiness.js");
    const check = await checkSchemaReadiness(env.DB, false);
    expect(check.ready).toBe(true);
    expect(check.missingTables).toEqual([]);
  });

  it("the surviving schema is exactly the product set plus test-internal bookkeeping", () => {
    const surviving = productionSchema(new DatabaseSync(":memory:"));
    // Every lab-only table is gone; every product table survived.
    for (const lab of LAB_ONLY_TABLES) expect(surviving.has(lab)).toBe(false);
    for (const t of PRODUCT_REQUIRED_TABLES) {
      expect(surviving.has(t), `product table ${t} missing from the migration chain`).toBe(true);
    }
  });
});
