/**
 * P1-AUDIT-2 response (P1-3) — ONE lab_runs read per lab submit.
 *
 * submit.ts consulted the session's bound lab assignment TWICE: a bare
 * `SELECT turnstile_required FROM lab_runs ...` for the Turnstile gate and
 * a second readLabAssignment() for profile reconstruction. Two reads of the
 * SAME immutable assignment per submit is a redundant D1 round-trip, and
 * because they are not in one transaction the two consumers could observe
 * a mid-request rebind — deriving the recipe from a DIFFERENT row than the
 * gate consulted.
 *
 * This test drives the REAL submit() route over a REAL migrated SQLite
 * database (the full migration chain) wrapped as D1, with a counting proxy
 * asserting exactly ONE lab_runs SELECT fires per lab submit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { submit } from "../../src/routes/submit.js";
import { makeCsrfToken } from "../../src/security/csrf.js";
import type { Env } from "../../src/env.js";

const SECRET = "k".repeat(64);
const CSRF_SECRET = "c".repeat(64);

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf-8"));
  }
  return db;
}

/** A lab session row as the lab signup route creates it (stateful, bare sid). */
function insertLabSession(db: DatabaseSync, sid: string): void {
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
     VALUES (?, ?, ?, 1, 'pid', 'phash', 0)`
  ).run(sid, Date.now(), Date.now());
}

/** D1-shaped wrapper that COUNTS lab_runs reads (the P1-3 assertion). */
function countingD1(db: DatabaseSync): { d1: D1Database; reads: () => number } {
  const counter = { labRunsReads: 0 };
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              if (/FROM lab_runs/.test(sql)) counter.labRunsReads++;
              const res = db.prepare(sql).run(...(args as never[]));
              return { meta: { changes: Number(res.changes) } };
            },
            first: async () => {
              if (/FROM lab_runs/.test(sql)) counter.labRunsReads++;
              return db.prepare(sql).get(...(args as never[])) ?? null;
            },
            all: async () => {
              if (/FROM lab_runs/.test(sql)) counter.labRunsReads++;
              return { results: db.prepare(sql).all(...(args as never[])) };
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
  return { d1, reads: () => counter.labRunsReads };
}

function env(d1: D1Database): Env {
  return {
    DB: d1,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    FIRERAID_PROFILE_SECRET: SECRET,
    FIRERAID_CSRF_SECRET: CSRF_SECRET,
  } as unknown as Env;
}

describe("P1-3: one lab_runs read per lab submit", () => {
  it("a bound lab submit consults lab_runs EXACTLY ONCE", async () => {
    const db = migratedDb();
    const { d1, reads } = countingD1(db);

    // Lab sessions are STATEFUL (envelopes are production-only): the signup
    // route created the row; submit resolves it by the bare sid.
    const sid = "sid-single-read";
    insertLabSession(db, sid);

    // A BOUND lab run: decoy-field recipe, no holdout, no turnstile.
    db.prepare(
      `INSERT INTO lab_runs (id, session_id, status, recipe_json, holdout_mode, turnstile_required, created_at)
       VALUES ('run-1', ?, 'BOUND', ?, 0, 0, ?)`
    ).run(sid, JSON.stringify({ families: ["decoy-field"] }), Date.now());

    const csrf = await makeCsrfToken({ FIRERAID_CSRF_SECRET: CSRF_SECRET } as never, sid);
    const req = new Request("http://w/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sid}` },
      body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
    });
    const res = await submit(req, env(d1));

    // The submit completed (accepted or scored — not a 5xx infrastructure
    // failure): the assignment was read and honored.
    expect(res.status).toBeLessThan(500);
    // P1-3: EXACTLY ONE lab_runs SELECT across the whole request.
    expect(reads()).toBe(1);
  });

  it("an UNBOUND lab submit reads lab_runs exactly once (the single unbound probe)", async () => {
    const db = migratedDb();
    const { d1, reads } = countingD1(db);
    const sid = "sid-unbound";
    insertLabSession(db, sid);
    const csrf = await makeCsrfToken({ FIRERAID_CSRF_SECRET: CSRF_SECRET } as never, sid);
    const req = new Request("http://w/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sid}` },
      body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
    });
    const res = await submit(req, env(d1));
    expect(res.status).toBeLessThan(500);
    expect(reads()).toBe(1);
  });
});
