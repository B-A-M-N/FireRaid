/**
 * Store lifecycle: TTL sweeps, store finalization, and the operational-error
 * seam (extracted from middleware.ts).
 */
import type { MiddlewareDeps } from "../middleware-types.js";

type Swept = { sweepExpired?: () => Promise<number> | number };

/**
 * P1-9: async sweep results are CONTAINED, not abandoned. The old
 * `void s.sweepExpired()` left a rejecting Promise as an unhandled
 * rejection (process-fatal under strict hosts) — a store whose sweep
 * failed asynchronously would take the whole origin down for a hygiene
 * miss. The Promise is explicitly observed and routed to the operational
 * error hook (P1-10); sync throws stay contained here.
 */
export function sweepStores(deps: MiddlewareDeps): void {
  for (const store of [deps.canaryStore, deps.telemetry as unknown as Swept]) {
    const s = store as Swept | undefined;
    if (s && typeof s.sweepExpired === "function") {
      try {
        const r = s.sweepExpired();
        if (r && typeof (r as Promise<number>).then === "function") {
          (r as Promise<number>).catch((err: unknown) => {
            reportOperationalError(deps, "store-sweep", err);
          });
        }
      } catch (err) {
        // Lifecycle hygiene is best-effort; never fail a request for it.
        reportOperationalError(deps, "store-sweep", err);
      }
    }
  }
}

/**
 * P1-10: the operational-error seam. Infrastructure failures that must not
 * corrupt the applicant response path (store sweeps, store finalization)
 * surface here instead of vanishing — a host that silences them is flying
 * blind on exactly the degradation that turns into a review-data hole.
 * Default: console.error (the reference runtime has no other sink).
 */
export function reportOperationalError(deps: MiddlewareDeps, op: string, err: unknown): void {
  const hook = (deps as { onOperationalError?: (op: string, err: unknown) => void })
    .onOperationalError;
  if (typeof hook === "function") {
    try {
      hook(op, err);
    } catch {
      // The error sink itself failing must never break the request path.
    }
  } else {
    console.error(`FireRaid middleware: operational error in ${op}:`, err);
  }
}

export async function finalizeStores(
  deps: MiddlewareDeps,
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  for (const store of [deps.canaryStore, deps.telemetry as unknown as { finalize?: (sid: string, signal?: AbortSignal) => unknown }]) {
    const s = store as { finalize?: (sid: string, signal?: AbortSignal) => unknown } | undefined;
    if (s && typeof s.finalize === "function") {
      try {
        await s.finalize(sessionId, signal);
      } catch (err) {
        // Finalization failure must not corrupt the response path — but it
        // must be SEEN (P1-10), not swallowed.
        reportOperationalError(deps, "store-finalize", err);
      }
    }
  }
}
