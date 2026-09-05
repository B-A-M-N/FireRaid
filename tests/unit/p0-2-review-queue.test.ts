/**
 * P0-2 regression: non-ACCEPT dispositions MUST create a review-queue entry.
 *
 * FireRaid's advisory deployment surfaces every submission to a human reviewer.
 * When the decision engine returns REVIEW or QUARANTINE (non-ACCEPT), the
 * submit route must create a review-queue row in the SAME D1 batch as the
 * submission/evidence finalization. The review-queue GET route must then
 * expose the entry to an authenticated admin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adminReviewQueue } from "../../src/routes/admin.js";
import { createAdminToken } from "../../src/security/admin-auth.js";
import { D1SubmissionFinalizer } from "../../src/cloudflare/session-store.js";
import type { Env } from "../../src/env.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SECRET = "test-profile-secret-0123456789abcdef-0123456789abcdef";
const CSRF_SECRET = "csrf-test-secret-0123456789abcdef-0123456789abcdef";
const ADMIN_SECRET = "admin-test-secret-0123456789abcdef-0123456789ab";
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
    ADMIN_SECRET: ADMIN_SECRET,
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    TURNSTILE_MODE: "disabled-test",
    TURNSTILE_EXPECTED_HOSTNAME: "localhost",
  } as unknown as Env;
}

let dbFile: string;
let db: DatabaseSync;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "fr-p02-")), "d1.sqlite");
  db = new DatabaseSync(dbFile);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dbFile, { force: true });
});

describe("P0-2: review-queue entry on non-ACCEPT disposition", () => {
  it("finalizer with createReviewEntry=true creates review-queue entry for REVIEW", async () => {
    const env = makeEnv(db);
    const sid = "p02-finalizer-review-0001";
    const publicId = "pub-review-0001";

    // Create the session row.
    db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
       VALUES (?, ?, ?, 1, ?, 'pid', 'phash', 0)`
    ).run(sid, Date.now(), Date.now(), KEY_ID);

    const f = new D1SubmissionFinalizer(env.DB);
    const { claimed } = await f.finalizeSubmission({
      sessionClaim: { sessionId: sid, score: 60, disposition: "REVIEW" },
      submission: {
        publicId,
        sessionId: sid,
        createdAt: Date.now(),
        turnstileOk: false,
        causalHits: 0,
        strongHits: 1,
        weakHits: 1,
        riskScore: 60,
        disposition: "REVIEW",
        policy: "default-v1",
        reasons: ["test-evidence"],
        verificationProvider: "none",
      },
      evidence: [
        { evidenceClass: "B", source: "DECOY_FIELD_POPULATED", weight: 60, verified: true, metadata: {} },
      ],
      createReviewEntry: true,
    });

    expect(claimed).toBe(true);

    // Verify the review-queue entry was created.
    const entry = db
      .prepare(`SELECT * FROM review_queue WHERE session_id = ?`)
      .get(sid) as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("pending");
    expect(entry!.disposition).toBe("REVIEW");
    expect(entry!.public_id).toBe(publicId);
  });

  it("finalizer with createReviewEntry=false does NOT create review-queue entry (ACCEPT case)", async () => {
    const env = makeEnv(db);
    const sid = "p02-finalizer-accept-0002";
    const publicId = "pub-accept-0002";

    db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
       VALUES (?, ?, ?, 1, ?, 'pid', 'phash', 0)`
    ).run(sid, Date.now(), Date.now(), KEY_ID);

    const f = new D1SubmissionFinalizer(env.DB);
    await f.finalizeSubmission({
      sessionClaim: { sessionId: sid, score: 10, disposition: "ACCEPT" },
      submission: {
        publicId,
        sessionId: sid,
        createdAt: Date.now(),
        turnstileOk: true,
        causalHits: 0,
        strongHits: 0,
        weakHits: 0,
        riskScore: 10,
        disposition: "ACCEPT",
        policy: "default-v1",
        reasons: [],
        verificationProvider: "none",
      },
      evidence: [],
      createReviewEntry: false,
    });

    const entry = db
      .prepare(`SELECT * FROM review_queue WHERE session_id = ?`)
      .get(sid) as Record<string, unknown> | undefined;
    expect(entry).toBeUndefined();
  });

  it("authenticated GET /api/admin/review-queue returns pending entries", async () => {
    const env = makeEnv(db);
    const sid = "p02-queue-get-0003";
    const publicId = "pub-queue-get-0003";

    // Create the session and a submission (review_queue has FK on public_id).
    db.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
       VALUES (?, ?, ?, 1, ?, 'pid', 'phash', 0)`
    ).run(sid, Date.now(), Date.now(), KEY_ID);

    db.prepare(
      `INSERT INTO submissions (public_id, session_id, created_at, turnstile_ok, causal_hits, strong_hits, weak_hits, risk_score, disposition, policy, verification_provider, reasons_json)
       VALUES (?, ?, ?, 0, 0, 0, 0, 150, 'REVIEW', 'default-v1', 'none', '[]')`
    ).run(publicId, sid, Date.now());

    db.prepare(
      `INSERT INTO review_queue (session_id, public_id, created_at, risk_score, risk_tier, disposition, policy, reasons_json, status)
       VALUES (?, ?, ?, 150, 'HIGH', 'REVIEW', 'default-v1', '[]', 'pending')`
    ).run(sid, publicId, Date.now());

    const adminToken = await createAdminToken(env);
    const req = new Request("http://localhost/api/admin/review-queue?status=pending", {
      headers: { cookie: `__Host-fr_admin=${adminToken}` },
    });

    const res = await adminReviewQueue(req, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entries: Array<{ sessionId: string; status: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    const entry = body.entries.find((e) => e.sessionId === sid);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("pending");
  });
});
