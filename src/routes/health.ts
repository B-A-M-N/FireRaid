/**
 * GET /health — LIVENESS probe (cheap, constant, no DB).
 * GET /readyz — READINESS probe (verifies the D1 schema matches this version).
 *
 * FR-P1-09: /health answers "should a load balancer keep routing to me?" and
 * must never depend on D1 — a DB outage is a dependency failure, not a reason
 * to stop routing. /readyz answers "can THIS deployment serve the CURRENT
 * version?", which requires the backed D1 to have the tables and version-
 * anchored columns this code reads and writes. readiness is fail-closed: any
 * schema gap or a D1 check it cannot run returns 503, never a false green.
 */
import { json, withSecurityHeaders } from "../security/headers.js";
import type { Env } from "../env.js";
import { profileVersion, isLabMode } from "../env.js";
import { readyzResponse } from "../cloudflare/schema-readiness.js";

export async function health(_req: Request, env: Env): Promise<Response> {
  const buildSha = env.FIRERAID_BUILD_SHA;
  const resp = json({ ok: true, version: "0.1.0", profileVersion: profileVersion(env), build: buildSha ?? null });
  if (buildSha) resp.headers.set("X-FireRaid-Build", buildSha);
  return resp;
}

export async function readyz(_req: Request, env: Env): Promise<Response> {
  // Closure 8: the plane selects the schema contract (production never
  // requires the evaluation control-plane tables) and the external body is
  // opaque {"ok","ready"} — detail goes to the operator's logs.
  const resp = await readyzResponse(env.DB, isLabMode(env));
  return withSecurityHeaders(resp);
}
