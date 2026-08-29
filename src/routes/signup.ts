/**
 * GET /signup — main entry. Creates session, derives profile, injects defenses.
 */
import { html, error } from "../security/headers.js";
import type { Env } from "../env.js";
import { profileVersion, isLabMode } from "../env.js";
import {
  generateSessionId,
  sessionCookieHeader,
  csrfCookieHeader,
  persistSession,
  now,
} from "../core/session.js";
import { deriveProfile, hashProfile } from "../core/profile.js";
import { renderSignupPage } from "../core/renderer.js";
import { makeCsrfToken } from "../security/csrf.js";
import { readSignupHtml } from "../core/static.js";

export async function signup(_req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const sessionId = generateSessionId();
  const profile = await deriveProfile(env, sessionId);
  const profileHash = await hashProfile(profile);
  const csrfToken = await makeCsrfToken(env, sessionId);

  await persistSession(env.DB, {
    id: sessionId,
    createdAt: now(),
    profileVersion: profileVersion(env),
  }, profile.profileId, profileHash);

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
