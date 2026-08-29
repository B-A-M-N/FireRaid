/**
 * CSRF — session-bound cryptographic tokens (constant-time verify).
 */
import { deriveCsrfToken, verifyCsrfToken } from "../core/session.js";
import type { Env } from "../env.js";

const CSRF_PURPOSE = "submit";
const FORM_PURPOSE = "form";

export async function makeCsrfToken(env: Env, sessionId: string): Promise<string> {
  return deriveCsrfToken(env.FIRERAID_CSRF_SECRET, sessionId, CSRF_PURPOSE);
}

export async function makeFormCsrfToken(env: Env, sessionId: string): Promise<string> {
  return deriveCsrfToken(env.FIRERAID_CSRF_SECRET, sessionId, FORM_PURPOSE);
}

export async function checkCsrf(
  env: Env,
  sessionId: string,
  token: string
): Promise<boolean> {
  return verifyCsrfToken(env.FIRERAID_CSRF_SECRET, sessionId, CSRF_PURPOSE, token);
}

export async function checkFormCsrf(
  env: Env,
  sessionId: string,
  token: string
): Promise<boolean> {
  return verifyCsrfToken(env.FIRERAID_CSRF_SECRET, sessionId, FORM_PURPOSE, token);
}
