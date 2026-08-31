/** Host adapter barrel (P1-25). */
export * from "./interface.js";
export { referenceInject } from "./reference-render.js";
export {
  ReferenceSessionAdapter,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
} from "./reference-adapters.js";
export { admit, makeCsrf, verifyCsrf } from "./middleware.js";
export type { MiddlewareDeps, MiddlewareResult } from "./middleware.js";
