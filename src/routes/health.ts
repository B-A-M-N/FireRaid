/**
 * GET /health — simple readiness probe.
 */
import { json } from "../security/headers.js";
import type { Env } from "../env.js";
import { profileVersion } from "../env.js";

export async function health(_req: Request, env: Env): Promise<Response> {
  return json({ ok: true, version: "0.1.0", profileVersion: profileVersion(env) });
}
