/**
 * THE one canonical route table (extracted from middleware.ts).
 *
 * Resolve MiddlewareRouteConfig (+ legacy top-level fields) into the ONE
 * canonical route table. Called by factory validation and admission dispatch
 * — dispatch, artifact generation, canary parsing, and the client config can
 * never disagree again.
 */
import type {
  MiddlewareRouteConfig,
  MiddlewareClientConfig,
  ResolvedFireRaidRoutes,
} from "../interface.js";
import { MiddlewareConfigError } from "../middleware-errors.js";

const DEFAULT_CANARY_PREFIX = "/c/";
const DEFAULT_TELEMETRY_PATH = "/api/events";
const DEFAULT_FORM_SELECTOR = "#signup-form";

/**
 * Resolve MiddlewareRouteConfig (+ legacy top-level fields) into the ONE
 * canonical route table.
 */
export function resolveRoutes(deps: {
  routes?: MiddlewareRouteConfig;
  telemetryIngestPath?: string;
  clientScriptSrc?: string;
}): ResolvedFireRaidRoutes | null {
  const r = deps.routes;
  if (!r) return null;
  const canaryPrefix = r.canaryPrefix ?? DEFAULT_CANARY_PREFIX;
  const telemetry = deps.telemetryIngestPath === ""
    ? ""
    : (r.telemetry ?? deps.telemetryIngestPath ?? DEFAULT_TELEMETRY_PATH);
  const client: Required<MiddlewareClientConfig> = {
    formSelector: r.client?.formSelector ?? DEFAULT_FORM_SELECTOR,
    submitEndpoint: r.client?.submitEndpoint ?? r.applicationSubmit,
    telemetryEndpoint: r.client?.telemetryEndpoint ?? (telemetry === "" ? DEFAULT_TELEMETRY_PATH : telemetry),
  };
  const resolved: ResolvedFireRaidRoutes = {
    applicationPage: r.applicationPage,
    applicationSubmit: r.applicationSubmit,
    telemetry,
    canaryPrefix,
    client,
    trustedIngress: r.trustedIngress ?? "direct",
  };
  // P1-11: validate the route graph for collisions and malformed paths
  validateRouteGraph(resolved);
  return resolved;
}

/**
 * P1-11: validate the entire route graph for collisions and malformed paths.
 * Dispatch precedence creates dangerous configuration collisions:
 *   - GET canary-prefix matching happens before the application page. A broad
 *     canaryPrefix can swallow legitimate GET routes.
 *   - POST telemetry matching happens before submission. telemetry ===
 *     applicationSubmit makes submissions enter telemetry handling.
 *   - Client submitEndpoint/telemetryEndpoint overrides can contradict the
 *     supposedly canonical server route table.
 * Throws MiddlewareConfigError on any violation.
 */
function validateRouteGraph(routes: ResolvedFireRaidRoutes): void {
  const errors: string[] = [];

  // 1. Absolute-path syntax: must start with /, no query/hash
  const pathRoutes: Array<[string, string]> = [
    ["applicationPage", routes.applicationPage],
    ["applicationSubmit", routes.applicationSubmit],
  ];
  if (routes.telemetry) {
    pathRoutes.push(["telemetry", routes.telemetry]);
  }
  for (const [name, value] of pathRoutes) {
    if (!value.startsWith("/")) {
      errors.push(`routes.${name} must be an absolute path (start with /): "${value}"`);
    }
    if (value.includes("?") || value.includes("#")) {
      errors.push(`routes.${name} must not contain query or hash: "${value}"`);
    }
  }

  // 2. Canary prefix form: must start with /
  if (!routes.canaryPrefix.startsWith("/")) {
    errors.push(`routes.canaryPrefix must start with /: "${routes.canaryPrefix}"`);
  }

  // 3. No overlapping route namespaces (only within the same method)
  // GET routes: canaryPrefix must not swallow applicationPage
  // POST routes: telemetry must not collide with applicationSubmit
  if (routes.telemetry && routes.telemetry === routes.applicationSubmit) {
    errors.push(`routes.telemetry and routes.applicationSubmit must differ (both are "${routes.applicationSubmit}")`);
  }

  // 4. Canary prefix must not swallow other GET routes
  if (routes.applicationPage.startsWith(routes.canaryPrefix)) {
    errors.push(`routes.canaryPrefix "${routes.canaryPrefix}" is a prefix of routes.applicationPage "${routes.applicationPage}" — canary matching would swallow the application page`);
  }

  // 5. Valid form selector
  if (!routes.client.formSelector || routes.client.formSelector.length === 0) {
    errors.push("routes.client.formSelector must be a non-empty string");
  }

  // 6. Consistency between client endpoints and server dispatch
  if (routes.client.submitEndpoint !== routes.applicationSubmit) {
    errors.push(`routes.client.submitEndpoint "${routes.client.submitEndpoint}" does not match routes.applicationSubmit "${routes.applicationSubmit}" — client and server dispatch must agree`);
  }
  if (routes.telemetry && routes.client.telemetryEndpoint !== routes.telemetry) {
    errors.push(`routes.client.telemetryEndpoint "${routes.client.telemetryEndpoint}" does not match routes.telemetry "${routes.telemetry}" — client and server dispatch must agree`);
  }

  if (errors.length > 0) {
    throw new MiddlewareConfigError(
      "Route graph validation failed:\n  - " + errors.join("\n  - ")
    );
  }
}
