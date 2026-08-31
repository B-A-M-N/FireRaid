/** Host adapter barrel (P1-25). */
export * from "./interface.js";
export { referenceInject } from "./reference-render.js";
export {
  ReferenceSessionAdapter,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
} from "./reference-adapters.js";
export { admit } from "./middleware.js";
export type { MiddlewareDeps, MiddlewareResult } from "./middleware.js";
