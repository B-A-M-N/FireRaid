/**
 * P1-AUDIT-2 (ops) — retention sweep bounding + cron config validation.
 *
 * Two audit findings, both in the scheduled/cleanup path that no other test
 * exercised:
 *   1. runRetentionSweep ran UNBOUNDED `DELETE ... WHERE created_at < ?` per
 *      table — one giant D1 transaction per table on a large deployment.
 *      Now the cron path deletes at most RETENTION_SWEEP_BATCH rows per
 *      table per invocation and the next cron continues; the admin one-shot
 *      keeps unbounded (complete) semantics.
 *   2. The scheduled handler never validated config — a misconfigured
 *      deployment's cron silently swept with whatever env it had. Now a
 *      config error skips the sweep entirely.
 *
 * Real-SQLite (node:sqlite + the real migration chain) like the watermark
 * tests: change-count semantics and LIMIT behavior are exactly what D1 runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetentionSweep } from "../../src/cloudflare/retention.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

type BatchStmt = { run: () => Promise<{ meta: { changes: number } }> };

function makeD1(db: DatabaseSync): D1Database {
  type Stmt = { sql: string; params: unknown[] };
  function runStmt(stmt: Stmt): { meta: { changes: number } } {
    const res = db.prepare(stmt.sql).run(...(stmt.params as never[]));
    return { meta: { changes: Number(res.changes) } };
  }
  return {
    prepare(sql: string) {
      const stmt: Stmt = { sql, params: [] };
      return {
        bind(...params: unknown[]) {
          stmt.params = params;
          return {
            run: async () => runStmt(stmt),
            first: async () => (db.prepare(stmt.sql).get(...(stmt.params as never[])) ?? null) as never,
          };
        },
        run: async () => runStmt(stmt),
      };
    },
    async batch(statements: BatchStmt[]) {
      const out: { meta: { changes: number } }[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fireraid-sweep-"));
  db = new DatabaseSync(join(dir, "test.db"));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Seed N old event_batches (created_at = 1, far below any cutoff). */
function seedBatches(n: number): void {
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
     VALUES ('seed-sess', 1, 1, 1, 'p', 'h', 0)`
  ).run();
  const ins = db.prepare(
    `INSERT INTO event_batches (session_id, first_seq, last_seq, event_count, payload_json, created_at)
     VALUES ('seed-sess', ?, ?, 1, '[]', 1)`
  );
  // event_batches has a UNIQUE (session_id, first_seq, last_seq) identity —
  // each seeded row needs a distinct (first_seq, last_seq) pair.
  for (let i = 0; i < n; i++) ins.run(i + 1, i + 1);
}

describe("bounded retention sweep (P1-AUDIT-2 ops)", () => {
  it("cron sweep (default) deletes at most RETENTION_SWEEP_BATCH rows per table; next cron continues", async () => {
    seedBatches(1200);
    const d1 = makeD1(db);

    const pass1 = await runRetentionSweep(d1, 1000);
    expect(pass1.telemetryBatches).toBe(500);
    let left = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(left.n).toBe(700);

    const pass2 = await runRetentionSweep(d1, 1000);
    expect(pass2.telemetryBatches).toBe(500);
    left = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(left.n).toBe(200);

    const pass3 = await runRetentionSweep(d1, 1000);
    expect(pass3.telemetryBatches).toBe(200);
    left = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("admin one-shot (unbounded) deletes ALL eligible rows in one invocation", async () => {
    seedBatches(1200);
    const d1 = makeD1(db);
    const res = await runRetentionSweep(d1, 1000, { unbounded: true });
    expect(res.telemetryBatches).toBe(1200);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("sweep never touches rows newer than the cutoff", async () => {
    seedBatches(3);
    db.prepare(
      `INSERT INTO event_batches (session_id, first_seq, last_seq, event_count, payload_json, created_at)
       VALUES ('seed-sess', 999998, 999998, 1, '[]', 999999)`
    ).run();
    const d1 = makeD1(db);
    await runRetentionSweep(d1, 1000, { unbounded: true });
    // Only the fresh row (created_at above the cutoff) survives; its id is
    // the autoincrement INTEGER pk, so assert on created_at, not a label.
    const rows = db.prepare(`SELECT created_at FROM event_batches`).all() as { created_at: number }[];
    expect(rows.map((r) => r.created_at)).toEqual([999999]);
  });

  it("session cascade respects the batch cap too (sessions ≤ cap per pass)", async () => {
    const ins = db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES (?, 1, 1, 1, 'p', 'h', 1)`
    );
    for (let i = 0; i < 700; i++) ins.run(`s-${i}`);
    db.prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition)
       VALUES ('s-0', 1, 1, 0, 0, 0, 0, 'ACCEPT')`
    ).run();
    const d1 = makeD1(db);
    const res = await runRetentionSweep(d1, 1000);
    // finalized sessions capped at 500; the submission's session (s-0) is
    // protected from the abandoned-delete by the NOT IN guard.
    expect(res.finalizedSessions).toBe(500);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    expect(left.n).toBe(200);
  });

  it("P1-10: raw payloads expire on the RAW cutoff, derived records on the plain cutoff", async () => {
    // One OLD raw batch (older than rawCutoff but younger than cutoff) and
    // one FRESH submission (younger than cutoff, older than rawCutoff is
    // impossible — rawCutoff < cutoff — so: between the two clocks). A
    // plain single-cutoff sweep at rawCutoff would delete both; the
    // two-cutoff policy deletes only the raw payload.
    seedBatches(1);
    db.prepare(
      `INSERT INTO submissions (session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition)
       VALUES ('seed-sess', 1, 0, 0, 0, 0, 0, 'REVIEW')`
    ).run();

    const NOW = 100_000;
    const cutoff = NOW - 30 * 24 * 60 * 60 * 1000;      // derived window (30d)
    const rawCutoff = NOW - 7 * 24 * 60 * 60 * 1000;    // raw window (7d)
    // seeded rows use created_at = 1. Move the raw batch INTO the raw
    // window (older than rawCutoff) and the submission INTO the derived
    // window but NOT the raw window (between the two cutoffs) — it must
    // survive because its clock is the derived one.
    db.prepare(`UPDATE event_batches SET created_at = ? WHERE created_at = 1`).run(rawCutoff - 1000);
    db.prepare(`UPDATE submissions SET created_at = ? WHERE created_at = 1`).run(cutoff + 1000);

    const d1 = makeD1(db);
    const res = await runRetentionSweep(d1, cutoff, { unbounded: true, rawCutoff });

    expect(res.telemetryBatches).toBe(1); // raw payload deleted on the short clock
    const leftBatches = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(leftBatches.n).toBe(0);
    const leftSubs = db.prepare(`SELECT COUNT(*) AS n FROM submissions`).get() as { n: number };
    // The disposition (a durable experiment observable) SURVIVES — it is
    // younger than the derived cutoff even though the raw payload died.
    expect(leftSubs.n).toBe(1);
  });

  it("P1-10: with no rawCutoff passed, raw payloads follow the plain cutoff (back-compat)", async () => {
    seedBatches(2);
    const d1 = makeD1(db);
    await runRetentionSweep(d1, 1000, { unbounded: true });
    const left = db.prepare(`SELECT COUNT(*) AS n FROM event_batches`).get() as { n: number };
    expect(left.n).toBe(0);
  });
});

describe("scheduled handler validates config (P1-AUDIT-2 ops)", () => {
  // The scheduled handler is an object method on the default export; the
  // contract under test is the validateConfig-then-skip gate. We pin it at
  // the source level (the handler is not directly importable without a full
  // workerd env) AND via the exported sweep's signature.
  it("scheduled handler validates config BEFORE ctx.waitUntil and skips on error", async () => {
    const src = readFileSync(join(process.cwd(), "src", "index.ts"), "utf-8");
    // Extract the scheduled handler body.
    const m = src.match(/async scheduled\([\s\S]*?\n  \},/);  // eslint-disable-line no-regex-spaces -- matches the handler's 2-space indentation
    expect(m, "scheduled handler found").toBeTruthy();
    const body = m![0];
    const validatePos = body.indexOf("validateConfig(env)");
    const waitUntilPos = body.indexOf("ctx.waitUntil");
    expect(validatePos, "validateConfig called inside scheduled").toBeGreaterThan(-1);
    expect(waitUntilPos, "work is deferred via waitUntil").toBeGreaterThan(-1);
    // The validation must precede the work deferral, and the skip must
    // return WITHOUT scheduling the sweep.
    expect(validatePos).toBeLessThan(waitUntilPos);
    expect(body).toMatch(/if \(configProblem\)[\s\S]*?return;/);
  });
});
