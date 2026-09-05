/**
 * P0-1 regression: known-incomplete telemetry MUST NOT score interaction evidence.
 *
 * submit.ts reads compact session metrics via loadSessionMetrics(). When the
 * integrity result is "incomplete" (the compact row's watermark is behind the
 * session's accepted watermark AND no raw rows remain to replay), the server
 * KNOWS the behavioral window is truncated. It must NOT fall through to raw
 * aggregation (aggregateSessionTelemetry) — partial telemetry reconstructed
 * from pruned rows would score as Class-C interaction evidence against the
 * applicant.
 *
 * This test:
 *   1. Creates a production-mode session with a signed envelope.
 *   2. Persists a session_metrics row whose watermark is BEHIND
 *      sessions.last_event_seq (simulating raw-batch pruning).
 *   3. Drives the REAL submit() route.
 *   4. Asserts ZERO Class-C interaction evidence was emitted.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submit } from "../../src/routes/submit.js";
import { makeCsrfToken } from "../../src/security/csrf.js";
import { signSessionEnvelope } from "../../src/core/session-envelope.js";
import { resolveProfileKey } from "../../src/core/session.js";
import type { Env } from "../../src/env.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SECRET = "test-profile-secret-0123456789abcdef-0123456789abcdef";
const CSRF_SECRET = "csrf-test-secret-0123456789abcdef-0123456789abcdef";
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
            all: async () => ({ results: db.prepare(stmt.sql).all(...(stmt.params as never[])) }),
          };
        },
        run: async () => {
          const res = db.prepare(sql).run();
          return { meta: { changes: Number(res.changes) } };
        },
      };
    },
    async batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function makeEnv(db: DatabaseSync): Env {
  return {
    DB: makeD1(db),
    ASSETS: {} as Fetcher,
    FIRERAID_PROFILE_SECRET: SECRET,
    FIRERAID_PROFILE_KEY_CURRENT_ID: KEY_ID,
    FIRERAID_CSRF_SECRET: CSRF_SECRET,
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    TURNSTILE_MODE: "disabled-test",
    TURNSTILE_EXPECTED_HOSTNAME: "localhost",
  } as unknown as Env;
}

let dbFile: string;
let db: DatabaseSync;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "fr-p01-")), "d1.sqlite");
  db = new DatabaseSync(dbFile);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dbFile, { force: true });
});

async function envelopeFor(env: Env, sid: string): Promise<string> {
  return signSessionEnvelope(resolveProfileKey(env), sid, Date.now(), 1);
}

/**
 * FR-P0-04: the session row must carry the profile hash AS ISSUED — the
 * submit route's drift check compares reconstruction against it and fails
 * closed on a mismatch. Seed rows with the REAL derived hash, not a stub.
 */
async function seedIssuedSession(
  sid: string,
  keyId: string,
  extra: { submitted?: number; lastEventSeq?: number } = {}
): Promise<void> {
  const { deriveProductionProfile } = await import("../../src/core/profile.js");
  const { hashProfile } = await import("../../src/core/profile.js");
  const profile = await deriveProductionProfile({ secret: SECRET, version: 1, sessionId: sid });
  const hash = await hashProfile(profile);
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted, last_event_seq)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(sid, Date.now(), Date.now(), keyId, profile.profileId, hash, extra.submitted ?? 0, extra.lastEventSeq ?? null);
}

const INTERACTION_SOURCES = new Set([
  "DIRECT_FILL_PATTERN",
  "SHORT_COMPLETION",
  "NO_POINTER_EVENTS",
  "MISSING_INTERACTION_SEQUENCE",
  "ZERO_DWELL_FILL",
  "UNIFORM_INPUT_CADENCE",
  "NO_BLUR_BEFORE_SUBMIT",
]);

describe("P0-1: incomplete telemetry must NOT score interaction evidence", () => {
  it("session with pruned raw rows behind the watermark emits zero Class-C interaction evidence", async () => {
    const env = makeEnv(db);
    const sid = "p01-incomplete-sid-0001";
    const cookie = await envelopeFor(env, sid);

    // Session accepted through seq 10, but raw batches 3-10 were pruned.
    await seedIssuedSession(sid, KEY_ID, { lastEventSeq: 10 });

    // Compact metrics row only folded through seq 1 — behind the watermark.
    // capturePointer/Key true so the interaction family WOULD score if the
    // server incorrectly aggregated the (nonexistent) remaining raw rows.
    db.prepare(
      `INSERT INTO session_metrics
         (session_id, focused_targets_json, pointer_count, focus_transitions,
          key_count, input_without_focus, first_event_dt, first_meaningful_dt,
          submit_dt, last_event_dt, capture_pointer, capture_key, last_event_seq,
          focus_dt_by_target_json, zero_dwell_violation, input_dts_json,
          blur_count, created_at, updated_at)
       VALUES (?, '[]', 0, 0, 0, 0, NULL, NULL, NULL, NULL, 1, 1, 1,
               '{}', 0, '[]', 0, ?, ?)`
    ).run(sid, Date.now(), Date.now());

    // NO event_batches rows — they were pruned.
    // loadSessionMetrics sees lastSeq=1 < session watermark=10 with nothing to replay → incomplete.

    const csrf = await makeCsrfToken({ FIRERAID_CSRF_SECRET: CSRF_SECRET } as never, sid);
    const req = new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${cookie}` },
      body: JSON.stringify({ csrf, form: { name: "Alice", email: "alice@example.com" } }),
    });

    const res = await submit(req, env);

    // The submit should complete without 5xx.
    expect(res.status).toBeLessThan(500);

    // The submission row was written.
    const sub = db
      .prepare(`SELECT id FROM submissions WHERE session_id = ?`)
      .get(sid) as { id: number } | undefined;
    expect(sub).toBeDefined();

    // ZERO Class-C interaction evidence from any interaction source.
    const evidence = db
      .prepare(
        `SELECT source FROM submission_evidence WHERE submission_id = ?`
      )
      .all(sub!.id) as Array<{ source: string }>;

    const interactionEvidence = evidence.filter((e) => INTERACTION_SOURCES.has(e.source));
    expect(interactionEvidence).toHaveLength(0);
  });

  it("session with COMPLETE telemetry DOES score interaction evidence (control case)", async () => {
    const env = makeEnv(db);
    const sid = "p01-complete-sid-0002";
    const cookie = await envelopeFor(env, sid);

    // Session accepted through seq 1.
    await seedIssuedSession(sid, KEY_ID, { lastEventSeq: 1 });

    // Compact metrics row folded through seq 1 — caught up to watermark.
    // Simulate a direct-fill pattern: input_without_focus > 0.
    db.prepare(
      `INSERT INTO session_metrics
         (session_id, focused_targets_json, pointer_count, focus_transitions,
          key_count, input_without_focus, first_event_dt, first_meaningful_dt,
          submit_dt, last_event_dt, capture_pointer, capture_key, last_event_seq,
          focus_dt_by_target_json, zero_dwell_violation, input_dts_json,
          blur_count, created_at, updated_at)
       VALUES (?, '[]', 0, 0, 0, 1, NULL, NULL, NULL, NULL, 1, 1, 1,
               '{}', 0, '[]', 0, ?, ?)`
    ).run(sid, Date.now(), Date.now());

    const csrf = await makeCsrfToken({ FIRERAID_CSRF_SECRET: CSRF_SECRET } as never, sid);
    const req = new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${cookie}` },
      body: JSON.stringify({ csrf, form: { name: "Bob", email: "bob@example.com" } }),
    });

    const res = await submit(req, env);
    expect(res.status).toBeLessThan(500);

    const sub = db
      .prepare(`SELECT id FROM submissions WHERE session_id = ?`)
      .get(sid) as { id: number } | undefined;
    expect(sub).toBeDefined();

    const evidence = db
      .prepare(
        `SELECT source FROM submission_evidence WHERE submission_id = ?`
      )
      .all(sub!.id) as Array<{ source: string }>;

    const interactionEvidence = evidence.filter((e) => INTERACTION_SOURCES.has(e.source));
    // With complete telemetry showing directFill=true, at least one interaction
    // evidence should be emitted.
    expect(interactionEvidence.length).toBeGreaterThan(0);
  });
});
