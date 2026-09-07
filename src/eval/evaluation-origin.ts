/**
 * Closure 6/10: the SANCTIONED local-development / experiment origin
 * server — the EVALUATION-plane home of volatile wiring.
 *
 * Identical to createOriginServer (src/runtime/node.ts) except the deps go
 * through createEvaluationMiddleware — the validator's internal evaluation
 * path, which accepts stores that honestly declare `durability: "volatile"`.
 * This is where in-memory reference stores belong; a production wiring has
 * NO way to reach this path (createOriginServer keeps the strict factory,
 * and createFireRaidMiddleware's public signature has no bypass).
 *
 * This module lives under src/eval deliberately: the product boundary
 * (check-product-boundary) forbids src/runtime → src/eval imports, and the
 * dependency direction evaluation → product is the legal one.
 */
import http from "node:http";
import type { MiddlewareDeps } from "../host-adapter/middleware.js";
import type { OriginServerOptions } from "../runtime/node.js";
import { __buildOriginServerWithValidator } from "../runtime/node.js";
import { createEvaluationMiddleware } from "./evaluation-middleware.js";

export function createEvaluationOriginServer(
  options: OriginServerOptions & { labMode?: boolean }
): http.Server {
  return __buildOriginServerWithValidator(
    options,
    (deps) => {
      const evalDeps: Record<string, unknown> = { ...deps, routes: options.routes };
      // Only SET labMode when actually requested — a present-but-false key
      // would trip the validator's smuggle-refusal on a later production pass.
      if (options.labMode === true) evalDeps.labMode = true;
      // The evaluation validator runs the SAME structural checks via the
      // internal evaluation path (honestly-"volatile" stores permitted).
      const validated = createEvaluationMiddleware(evalDeps as never);
      // createEvaluationMiddleware runs ensureEvaluationRing: profileKeys is
      // defined on the returned deps (synthesized from `secret` when needed).
      return validated as MiddlewareDeps;
    },
    // FR-RR-16: throwaway experiment wiring may omit onAssessment (warned,
    // not refused) — the production posture is the strict one.
    "evaluation"
  );
}
