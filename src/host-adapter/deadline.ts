/**
 * FR-P1-11 — a request-scoped deadline that host adapters cannot ignore.
 *
 * A host adapter is arbitrary code the integrator supplies. If its `accept`,
 * `collect`, `record`, `claim`, `verify`, or `allow` hangs (a slow DB, a hung
 * remote call, a deadlock), the request would hang with it — indefinitely.
 * FireRaid's contract is fail-closed rejection, but it can only reject a
 * submission the request finishes processing. So the MIDDLEWARE must own the
 * deadline, not rely on the adapter's goodwill.
 *
 * This module provides both halves:
 *   - A shared `AbortSignal` (DeadlineSignal.signal) that the middleware
 *     passes into EVERY adapter contract method (the adapters' signatures
 *     gained a trailing `signal?: AbortSignal`), so a cooperative host can
 *     cancel its underlying I/O the moment the budget expires — not just be
 *     abandoned by the middleware racing it.
 *   - `DeadlineSignal.run()` races an awaited adapter call against the same
 *     deadline and rejects on expiry, so EVEN AN ADAPTER THAT IGNORES THE
 *     SIGNAL cannot hang the request past the budget. The middleware maps
 *     that rejection to a fail-closed operational/transport error, never an
 *     applicant dispositions, and never a partial forward.
 *
 * Fail-closed shape: the deadline fires → the adapter call is abandoned and
 * the request is handled as an infrastructure failure (never "admission
 * passed"). An aborted upstream forward (allow) is a transport failure; an
 * aborted evidence write that loses the causal signal is an operational
 * failure — both prevent the false success a hang otherwise manufactures.
 */

/** Default budget for a single adapter call. */
export const DEFAULT_ADAPTER_CALL_TIMEOUT_MS = 10_000;

export class DeadlineSignal {
  readonly signal: AbortSignal;
  private readonly abortController: AbortController;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when the deadline fires; lets run() release cleanly. */
  private readonly deadlineReached: Promise<void>;

  constructor(ms: number) {
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
    // An already-elapsed deadline aborts immediately.
    const budget = Math.max(0, ms);
    if (budget === 0) {
      this.abortController.abort();
      this.deadlineReached = Promise.resolve();
      this.timer = undefined;
    } else {
      this.deadlineReached = new Promise((resolve) => {
        this.timer = setTimeout(() => {
          this.abortController.abort();
          resolve();
        }, budget);
      });
    }
  }

  /** Discard the underlying timer (call when the request completes early). */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Race a promise against the deadline. Resolves the value if it lands first;
   * rejects with DeadlineError if the deadline fires first — so an adapter
   * that ignores the signal cannot hang the request past the budget. Accepts
   * `void | Promise<void>` (e.g. HostEnforcementAdapter.deny) by normalizing
   * through Promise.resolve().
   */
  run<T>(p: Promise<T> | T): Promise<T> {
    return Promise.race([
      Promise.resolve(p),
      this.deadlineReached.then(() => {
        throw new DeadlineError("adapter call exceeded the request deadline");
      }),
    ]);
  }
}

/** The error the middleware maps to fail-closed handling on deadline expiry. */
export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}