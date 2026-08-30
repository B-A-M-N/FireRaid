/**
 * GET /signup — main entry. Creates session, derives profile, injects defenses.
 * FR-R5-005/028: consumes ?lab_run=<id>&bind=<token> — server-side one-time
 * bind of the session to a lab run BEFORE the page renders. Fails closed in
 * lab mode: an invalid/expired/used bind token renders an error, never an
 * unbound session that would silently dilute the experiment condition.
 */
import { html, error } from "../security/headers.js";
import type { Env } from "../env.js";
import { profileVersion, isLabMode } from "../env.js";
import {
  generateSessionId,
  sessionCookieHeader,
  csrfCookieHeader,
  now,
  resolveProfileKey,
} from "../core/session.js";
import {
  persistSession,
} from "../cloudflare/session.js";;
import { deriveProfile, hashProfile, type DefenseRecipe } from "../core/profile.js";
import { renderSignupPage } from "../core/renderer.js";
import { makeCsrfToken } from "../security/csrf.js";
import { readSignupHtml } from "../core/static.js";
import { constantTimeEqualStr } from "./lab.js";

/** SHA-256 hex of a bind token (mirrors lab.ts storage format). */
async function hashBindToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signup(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const labRunId = url.searchParams.get("lab_run");
  const bindToken = url.searchParams.get("bind");
  const labBindRequested = isLabMode(env) && labRunId !== null;

  // FR-R5-005/028: validate the bind BEFORE creating any state. Fails closed
  // on: unknown run, non-PENDING status, expired run, missing/wrong token.
  let bindHash: string | null = null;
  if (labBindRequested) {
    if (!bindToken) {
      return error("lab run bind failed: missing bind token", 403);
    }
    let row: { status: string; bind_token_hash: string | null; expires_at: number | null } | null;
    try {
      row = await env.DB.prepare(
        `SELECT status, bind_token_hash, expires_at FROM lab_runs WHERE id = ?`
      )
        .bind(labRunId)
        .first<{ status: string; bind_token_hash: string | null; expires_at: number | null }>();
    } catch {
      return error("lab run bind failed: lookup error", 500);
    }
    if (!row) return error("lab run bind failed: unknown run", 403);
    if (row.status !== "PENDING") {
      return error(`lab run bind failed: run is ${row.status}, not PENDING`, 403);
    }
    if (row.expires_at !== null && row.expires_at < now()) {
      return error("lab run bind failed: run expired", 403);
    }
    if (!row.bind_token_hash) {
      return error("lab run bind failed: bind token not available", 403);
    }
    const provided = await hashBindToken(bindToken);
    if (!constantTimeEqualStr(provided, row.bind_token_hash)) {
      return error("lab run bind failed: invalid bind token", 403);
    }
    bindHash = row.bind_token_hash;
  }

  const sessionId = generateSessionId();
  // FR-R5 Pass C (experimental conditions): a bound lab run's recipe IS the
  // experiment condition — derive this session's profile from it so the
  // rendered page provably matches the named condition. Unbound lab and
  // production sessions use the engine's random profile as before.
  let recipe: DefenseRecipe | undefined;
  // FR-POST-R6-P5: holdout_mode rides with the recipe — it changes the
  // random template pool, so issuance and every later reconstruction must
  // see the same value (persisted on the lab run row).
  let holdoutMode = false;
  if (labBindRequested && bindToken && bindHash) {
    try {
      const row = await env.DB.prepare(
        `SELECT recipe_json, holdout_mode FROM lab_runs WHERE id = ?`
      )
        .bind(labRunId)
        .first<{ recipe_json: string | null; holdout_mode: number | null }>();
      const raw = row?.recipe_json;
      if (typeof raw === "string" && raw.length > 0) {
        try { recipe = JSON.parse(raw) as DefenseRecipe; } catch {
          // FR-R6-003: recipe_json was non-empty but not valid JSON —
          // fail closed so a bound run never renders a random profile.
          return error("lab run bind failed: recipe unreadable", 500);
        }
      }
      holdoutMode = row?.holdout_mode === 1;
    } catch {
      // recipe_json lookup error → treat as a failed bind (fail closed, FR-R5 Pass C).
      return error("lab run bind failed: recipe unreadable", 500);
    }
  }
  const profile = await deriveProfile(env, sessionId, undefined, recipe, holdoutMode);
  // FR-R6-003: belt-and-braces — a bound lab run whose recipe requested
  // families somehow derived zero families would silently dilute the
  // experiment condition (deriveProfilePure already throws INVALID_RECIPE
  // fail-closed, but log here for debug observability).
  if (labBindRequested && bindToken && bindHash && recipe?.families) {
    if (profile.families.length === 0) {
      console.error("lab run bind: recipe requested families but derived profile has none", {
        run_id: labRunId,
        recipe_families: recipe.families,
        derived_families: profile.families,
      });
    }
  }
  const profileHash = await hashProfile(profile);
  const csrfToken = await makeCsrfToken(env, sessionId);

  // FR-R7-001: every newly-persisted session carries the key id of the
  // current profile secret, so a future rotation that moves it to the
  // previous-map can still reconstruct the issued profile correctly. The
  // lab-bound path keeps its atomic batch so a failed bind rolls back the
  // session insert; the production path takes the standard delegate.
  const profileKeyId = resolveProfileKey(env).current.id;
  if (labBindRequested && bindToken && bindHash) {
    const sessionStmt = env.DB.prepare(
      `INSERT INTO sessions (id, created_at, last_seen_at, profile_version, profile_key_id, profile_id, profile_hash, submitted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      sessionId,
      now(),
      Date.now(),
      profileVersion(env),
      profileKeyId,
      profile.profileId,
      profileHash,
    );
    const claimStmt = env.DB.prepare(
      `UPDATE lab_runs SET session_id = ?, bind_token_hash = NULL, status = 'BOUND'
       WHERE id = ? AND bind_token_hash = ? AND status = 'PENDING'`
    ).bind(sessionId, labRunId, bindHash);

    try {
      const results = await env.DB.batch([sessionStmt, claimStmt]);
      const claimResult = results[1] as D1Result;
      if ((claimResult.meta?.changes ?? 0) !== 1) {
        return error("lab run bind failed: token already consumed", 409);
      }
    } catch {
      return error("lab run bind failed: internal error", 500);
    }
  } else {
    // Unbound / production path.
    await persistSession(env.DB, {
      id: sessionId,
      createdAt: now(),
      profileVersion: profileVersion(env),
    }, profile.profileId, profileHash, profileKeyId);
  }

  let staticHtml: string;
  try {
    staticHtml = await readSignupHtml(env);
  } catch {
    return error("signup template unavailable", 500);
  }

  const page = renderSignupPage({
    html: staticHtml,
    profile,
    csrfToken,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    labMode: isLabMode(env),
  });

  const resp = html(page);
  resp.headers.append("set-cookie", sessionCookieHeader(sessionId));
  resp.headers.append("set-cookie", csrfCookieHeader(csrfToken));
  return resp;
}
