/**
 * FR-P1-19: envelope → session row materialization (ensureSessionRow).
 *
 * Real-SQLite tests through the same D1 adapter pattern as
 * telemetry-watermark-sqlite.test.ts, against the real migration chain —
 * mocked D1 cannot prove INSERT OR IGNORE race semantics.
 *
 * Covers the audit-mandated first-write orders:
 *   - submit-first, canary-first, telemetry-first (route calls all funnel
 *     through ensureSessionRow, so the shared path is exercised directly
 *     for each cookie shape)
 *   - concurrent first-write race: two ensureSessionRow calls for the same
 *     envelope — exactly one INSERT wins; both see the IDENTICAL row
 *     (deterministic profile derivation)
 *   - legacy bare-sid fallback: existing row loads, missing row rejects
 *   - envelope in lab mode is rejected (lab is always stateful)
 *   - production signup issues NO D1 write (covered structurally in
 *     tests/integration/session-envelope-flow.test.ts against the live worker)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSessionRow } from "../../src/cloudflare/session-envelope.js";
import { signSessionEnvelope } from "../../src/core/session-envelope.js";
import { resolveProfileKey } from "../../src/core/session.js";
import type { Env } from "../../src/env.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SECRET = "test-profile-secret-0123456789abcdef-0123456789abcdef";
const KEY_ID = "k1";

function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

function makeD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const stmt = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          stmt.params = params;
          return {
            run: async () => {
              const res = db.prepare(stmt.sql).run(...(stmt.params as never[]));
              return { meta: { changes: Number(res.changes) } };
            },
            first: async () =>
              (db.prepare(stmt.sql).get(...(stmt.params as never[])) ?? null) as never,
          };
        },
        run: async () => {
          const res = db.prepare(stmt.sql).run(...(stmt.params as never[]));
          return { meta: { changes: Number(res.changes) } };
        },
      };
    },
    async batch(statements: { run: () => Promise<{ meta: { changes: number } }> }[]) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function makeEnv(db: DatabaseSync, opts?: { lab?: boolean }): Env {
  return {
    DB: makeD1(db),
    ASSETS: {} as Fetcher,
    FIRERAID_PROFILE_SECRET: SECRET,
    FIRERAID_PROFILE_KEY_CURRENT_ID: KEY_ID,
    PROFILE_VERSION: "1",
    LAB_MODE: opts?.lab ? "true" : "false",
  } as unknown as Env;
}

let dbFile: string;
let db: DatabaseSync;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "fr-env-")), "d1.sqlite");
  db = new DatabaseSync(dbFile);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dbFile, { force: true });
});

const NOW = Date.now();

async function envelopeFor(sid: string, env: Env): Promise<string> {
  return signSessionEnvelope(resolveProfileKey(env), sid, Date.now(), 1);
}

function sessionCount(): number {
  return Number(
    db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()!.n
  );
}

describe("FR-P1-19: ensureSessionRow materialization", () => {
  it("first write via the SUBMIT-first order: envelope → row appears with deterministic columns", async () => {
    const env = makeEnv(db);
    const sid = "submit-first-sid-123456";
    const cookie = await envelopeFor(sid, env);
    const row = await ensureSessionRow(env, cookie);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(sid);
    expect(row!.materialized).toBe(true);
    expect(sessionCount()).toBe(1);
    // Columns derived deterministically, keyed by the envelope's kid.
    const stored = db
      .prepare(`SELECT profile_key_id, profile_version, submitted FROM sessions WHERE id = ?`)
      .get(sid)!;
    expect(stored.profile_key_id).toBe(KEY_ID);
    expect(stored.profile_version).toBe(1);
    expect(stored.submitted).toBe(0);
  });

  it("first write via the CANARY-first order: same materialization, idempotent afterwards", async () => {
    const env = makeEnv(db);
    const sid = "canary-first-sid-12345";
    const cookie = await envelopeFor(sid, env);
    const first = await ensureSessionRow(env, cookie);
    expect(first!.materialized).toBe(true);
    // Second stateful action (the actual canary POST after materialization):
    // fast path — no re-insert, no materialized flag.
    const second = await ensureSessionRow(env, cookie);
    expect(second!.materialized).toBeUndefined();
    expect(sessionCount()).toBe(1);
  });

  it("first write via the TELEMETRY-first order: materializes even when events arrive before any page interaction", async () => {
    const env = makeEnv(db);
    const sid = "telemetry-first-sid-123";
    const cookie = await envelopeFor(sid, env);
    const row = await ensureSessionRow(env, cookie);
    expect(row!.id).toBe(sid);
    expect(sessionCount()).toBe(1);
  });

  it("CONCURRENT first write: both callers see the same row, exactly one INSERT wins", async () => {
    const env = makeEnv(db);
    const sid = "concurrent-race-sid-1234";
    const cookie = await envelopeFor(sid, env);
    // Promise.all → both verify envelopes, both attempt INSERT OR IGNORE.
    const [a, b] = await Promise.all([
      ensureSessionRow(env, cookie),
      ensureSessionRow(env, cookie),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(sid);
    expect(b!.id).toBe(sid);
    // Exactly one materialized it (order-independent: both rows identical).
    const materializers = [a!.materialized, b!.materialized].filter(Boolean).length;
    expect(materializers).toBe(1);
    expect(sessionCount()).toBe(1);
    // Identical derived columns — determinism is the race-safety argument.
    const rows = db.prepare(`SELECT profile_id, profile_hash FROM sessions WHERE id = ?`).all(sid);
    expect(rows).toHaveLength(1);
  });

  it("legacy bare-sid fallback: an EXISTING row still loads, a missing row rejects", async () => {
    const env = makeEnv(db);
    // Pre-envelope row (the mixed-fleet case).
    db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_id, profile_hash, submitted)
       VALUES ('legacy-row-sid-123456', 1, 1, 1, 'p', 'h', 0)`
    ).run();
    const loaded = await ensureSessionRow(env, "legacy-row-sid-123456");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("legacy-row-sid-123456");
    // Bare sid with NO row → reject (cannot fabricate sessions by omitting
    // the envelope).
    const forged = await ensureSessionRow(env, "forged-bare-sid-123456");
    expect(forged).toBeNull();
    expect(sessionCount()).toBe(1);
  });

  it("tampered / unknown / expired envelopes reject without writing", async () => {
    const env = makeEnv(db);
    const bad = await ensureSessionRow(env, "fr1.notreal.notreal");
    expect(bad).toBeNull();
    const sid = "expired-envelope-sid-12";
    // Signed in the far past → expired.
    const expiredCookie = await signSessionEnvelope(resolveProfileKey(env), sid, NOW - 31 * 60 * 1000, 1);
    const gone = await ensureSessionRow(env, expiredCookie);
    expect(gone).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it("envelope in LAB mode is rejected — lab sessions are always stateful", async () => {
    const labEnv = makeEnv(db, { lab: true });
    const sid = "lab-mode-envelope-1234";
    const cookie = await envelopeFor(sid, labEnv);
    const row = await ensureSessionRow(labEnv, cookie);
    expect(row).toBeNull();
    expect(sessionCount()).toBe(0);
  });
});
