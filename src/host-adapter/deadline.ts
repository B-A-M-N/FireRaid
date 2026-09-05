/**
 * Back-compat re-export shim — the implementation moved to
 * lifecycle/deadlines.ts. New code imports from the lifecycle module.
 */
export {
  DeadlineSignal,
  DeadlineError,
  DEFAULT_ADAPTER_CALL_TIMEOUT_MS,
  DEFAULT_DURABILITY_TIMEOUT_MS,
} from "./lifecycle/deadlines.js";
