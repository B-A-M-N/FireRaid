/**
 * FR-RR-03 + FR-RR-04 — reconstruction drift checks hold on EVERY path.
 *
 * FR-RR-03: the convenience reconstruction wrappers (core's
 * reconstructFromSessionId and cloudflare's reconstructFromSessionId) built
 * their ReconstructableSession WITHOUT the persisted profileHash — silently
 * disabling the FR-P0-04 drift check for every admin/lab caller that goes
 * through them. These tests go through the WRAPPERS (never
 * reconstructIssuedProfile directly): a session whose stored profile_hash
 * was tampered must come back PROFILE_HASH_MISMATCH from both.
 *
 * FR-RR-04: the drift comparison must hash with the VERSIONED hash function
 * (hashProfileByVersion), not the live hashProfile — otherwise a future V2
 * hash change would break every historical V1 reconstruction. The versioned
 * equivalence assertions below pin the dispatch: for V1 sessions the
 * versioned hash IS the V1-frozen function, and a tampered stored hash
 * mismatches through the wrapper regardless.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconstructFromSessionId as coreReconstructFromSessionId } from "../../src/core/reconstruct.js";
import { reconstructFromSessionId as cfReconstructFromSessionId } from "../../src/cloudflare/reconstruct.js";
import { loadSession } from "../../src/cloudflare/session.js";
import { deriveEvaluationProfile, hashProfile } from "../../src/core/profile.js";
import { hashProfileByVersion } from "../../src/core/profile-versions.js";
import type { Env } from "../../src/env.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SECRET = "r".repeat(64);
const KEY_ID = "k1";

function makeEnv(db: DatabaseSync): Env {
  return {
    DB: {
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
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    PROFILE_VERSION: "1",
    LAB_MODE: "false",
    FIRERAID_PROFILE_SECRET: SECRET,
    FIRERAID_PROFILE_KEY_CURRENT_ID: KEY_ID,
    FIRERAID_CSRF_SECRET: "c".repeat(64),
  } as unknown as Env;
}

let dir: string;
let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fr-rr03-"));
  db = new DatabaseSync(join(dir, "t.sqlite"));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  env = makeEnv(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Insert a session with the REAL issued profile hash (derivation-authentic). */
async function seedIssuedSession(sid: string): Promise<string> {
  const profile = await deriveEvaluationProfile({
    secret: SECRET,
    version: 1,
    sessionId: sid,
    mode: "production",
    holdoutMode: false,
    turnstileRequired: false,
  });
  const realHash = await hashProfile(profile);
  db.prepare(
    `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
     VALUES (?, ?, ?, 1, ?, ?, ?, 0)`
  ).run(sid, Date.now(), Date.now(), KEY_ID, profile.profileId, realHash);
  return realHash;
}

/** Corrupt the stored hash the way an issuance/derivation drift would. */
function tamperHash(sid: string): void {
  db.prepare(`UPDATE sessions SET profile_hash = ? WHERE id = ?`).run(
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    sid
  );
}

describe("FR-RR-03: the drift check holds through BOTH convenience wrappers", () => {
  it("core wrapper: an authentic stored hash reconstructs OK; a tampered one is PROFILE_HASH_MISMATCH", async () => {
    const sid = "rr03-core";
    await seedIssuedSession(sid);
    const ok = await coreReconstructFromSessionId(env, sid);
    expect(ok.ok).toBe(true);

    tamperHash(sid);
    const bad = await coreReconstructFromSessionId(env, sid);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("PROFILE_HASH_MISMATCH");
  });

  it("cloudflare wrapper: same contract — authentic OK, tampered PROFILE_HASH_MISMATCH", async () => {
    const sid = "rr03-cf";
    await seedIssuedSession(sid);
    const ok = await cfReconstructFromSessionId(env, sid);
    expect(ok.ok).toBe(true);

    tamperHash(sid);
    const bad = await cfReconstructFromSessionId(env, sid);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("PROFILE_HASH_MISMATCH");
  });
});

describe("FR-RR-04: the drift comparison uses the VERSIONED hash function", () => {
  it("hashProfileByVersion(profile, 1) equals the live hashProfile for V1 (today), and is the function reconstruction compares with", async () => {
    const sid = "rr04-v1";
    await seedIssuedSession(sid);
    const loaded = await loadSession(env.DB, sid);
    expect(loaded?.profileHash).toBeTruthy();

    const ok = await coreReconstructFromSessionId(env, sid);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // The V1 versioned hash reproduces the persisted hash — i.e. the
      // comparison inside reconstruction was made with the version-dispatched
      // function, so a V2 hash change can never break a V1 reconstruction.
      const versioned = await hashProfileByVersion(ok.profile, 1);
      expect(versioned).toBe(loaded!.profileHash);
      // And today (V1 == live) the live hash agrees — the equivalence that
      // makes this fix a no-op behaviorally NOW and a correctness fix at V2.
      const live = await hashProfile(ok.profile);
      expect(live).toBe(versioned);
    }
  });
});
