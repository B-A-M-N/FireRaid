/**
 * Static HTML reader — fetches from Workers Assets binding.
 */
import type { Env } from "../env.js";

export async function readSignupHtml(env: Env): Promise<string> {
  const resp = await env.ASSETS.fetch("http://internal/signup.html");
  if (!resp.ok) throw new Error(`asset fetch failed: ${resp.status}`);
  return resp.text();
}

export async function readAdminHtml(env: Env): Promise<string> {
  const resp = await env.ASSETS.fetch("http://internal/admin.html");
  if (!resp.ok) throw new Error(`asset fetch failed: ${resp.status}`);
  return resp.text();
}
